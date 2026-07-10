/**
 * Decision Ledger — durable store of detected team decisions and the learned
 * "not-a-conflict" memory (dismissals).
 *
 * Primary backend is Node's built-in `node:sqlite` (Node 22.5+ / stable in 26).
 * If it is unavailable at runtime, a tiny JSON-file store with the SAME public
 * interface is used instead, so callers never branch on the backend.
 *
 * @typedef {Object} Decision
 * @property {string} id
 * @property {string} statement
 * @property {string|null} rationale
 * @property {string} channel_id
 * @property {string|null} channel_name
 * @property {string|null} decided_by
 * @property {string|null} message_ts
 * @property {string|null} permalink
 * @property {'active'|'superseded'|'dismissed'} status
 * @property {number} confidence
 * @property {string} created_at
 * @property {number} is_private
 *
 * @typedef {Object} Stats
 * @property {number} active
 * @property {number} superseded
 * @property {number} caught
 * @property {number} dismissed
 * @property {number} activeDecisions
 * @property {number} captured
 * @property {number} alertsFired
 * @property {number} learnedPatterns
 * @property {number|null} precisionPct
 *
 * @typedef {'alert_fired'|'dismissed'|'superseded'|'captured'} EventKind
 *
 * @typedef {Object} LedgerBackend
 * @property {(d: Partial<Decision> & {id: string, statement: string, channel_id: string}) => Decision} addDecision
 * @property {(opts?: {status?: string, limit?: number}) => Decision[]} listDecisions
 * @property {(id: string) => Decision | null} getDecision
 * @property {(id: string, byId: string | null) => void} supersede
 * @property {(id: string) => void} dismiss
 * @property {(newMessageText: string, matchedDecisionId: string) => void} recordDismissal
 * @property {(newMessageText: string, decisionId: string) => boolean} isKnownFalsePositive
 * @property {(kind: EventKind, decisionId: string | null) => void} recordEvent
 * @property {() => Stats} stats
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DB_PATH = './consensus.db';
const JSON_PATH = './consensus-ledger.json';

/**
 * Max prefix length used for dismissal matching. The contradiction alert's
 * "Not a conflict" button can only carry a truncated copy of the offending
 * message (Block Kit caps button values at 2000 chars; blocks.js stores 500), so
 * both the stored dismissal text and any later lookup are truncated to the SAME
 * prefix here — otherwise a long message that matched on store would miss on
 * lookup and the alert would re-fire.
 */
const DISMISSAL_MATCH_LEN = 500;

/**
 * Normalize free text for exact-ish dismissal matching: truncate to a fixed
 * prefix, lowercase, collapse whitespace, strip surrounding punctuation.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return (text || '')
    .slice(0, DISMISSAL_MATCH_LEN)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?"'`]+/g, '')
    .trim();
}

/**
 * Build the SQLite-backed ledger.
 * @param {new (path: string) => any} DatabaseSync
 * @returns {LedgerBackend}
 */
function createSqliteBackend(DatabaseSync) {
  const db = new DatabaseSync(DB_PATH);
  // Tolerate concurrent access (e.g. parallel test processes, or the OAuth app
  // and Socket-mode app sharing the file): WAL lets readers and one writer
  // coexist, and busy_timeout makes a contended writer wait instead of failing
  // immediately with "database is locked".
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  } catch {
    // Pragmas are best-effort; the ledger still works without them.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      rationale TEXT,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      decided_by TEXT,
      message_ts TEXT,
      permalink TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dismissals (
      id TEXT PRIMARY KEY,
      new_message_text TEXT NOT NULL,
      matched_decision_id TEXT,
      dismissed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      decision_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Idempotent migration: add is_private to decisions if an older DB predates it.
  // node:sqlite has no "ADD COLUMN IF NOT EXISTS"; check pragma first.
  try {
    const cols = /** @type {{name: string}[]} */ (db.prepare('PRAGMA table_info(decisions)').all());
    if (!cols.some((c) => c.name === 'is_private')) {
      db.exec('ALTER TABLE decisions ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
    }
  } catch {
    // If the pragma/alter fails, callers still work (is_private read defaults to 0).
  }

  // Idempotent migration: guarantee at most one decision per (channel, message).
  // Slack redelivers events across restarts; without this a redelivered capture
  // could insert a duplicate row. SQLite treats NULL message_ts as distinct, so
  // rows without a ts are unaffected. Best-effort: if legacy duplicates already
  // exist the index creation fails and we simply fall back to non-unique inserts.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_msg ON decisions(channel_id, message_ts)');
  } catch {
    // Pre-existing duplicates or older engine — dedup index is best-effort.
  }

  // INSERT OR IGNORE so a redelivered (channel_id, message_ts) is a no-op rather
  // than a thrown unique-constraint error; addDecision then returns the existing row.
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (id, statement, rationale, channel_id, channel_name, decided_by, message_ts, permalink, status, confidence, created_at, is_private)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare('SELECT * FROM decisions WHERE id = ?');
  const selectByMsg = db.prepare('SELECT * FROM decisions WHERE channel_id = ? AND message_ts = ?');
  const supersedeStmt = db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?");
  const dismissStmt = db.prepare("UPDATE decisions SET status = 'dismissed' WHERE id = ?");
  const insertDismissal = db.prepare(
    'INSERT INTO dismissals (id, new_message_text, matched_decision_id, dismissed_at) VALUES (?, ?, ?, ?)',
  );
  const dismissalsForDecision = db.prepare('SELECT new_message_text FROM dismissals WHERE matched_decision_id = ?');
  const insertEvent = db.prepare('INSERT INTO events (id, kind, decision_id, created_at) VALUES (?, ?, ?, ?)');

  return {
    addDecision(d) {
      /** @type {Decision} */
      const row = {
        id: d.id,
        statement: d.statement,
        rationale: d.rationale ?? null,
        channel_id: d.channel_id,
        channel_name: d.channel_name ?? null,
        decided_by: d.decided_by ?? null,
        message_ts: d.message_ts ?? null,
        permalink: d.permalink ?? null,
        status: d.status ?? 'active',
        confidence: typeof d.confidence === 'number' ? d.confidence : 0,
        created_at: d.created_at ?? new Date().toISOString(),
        is_private: d.is_private ? 1 : 0,
      };
      const info = insertDecision.run(
        row.id,
        row.statement,
        row.rationale,
        row.channel_id,
        row.channel_name,
        row.decided_by,
        row.message_ts,
        row.permalink,
        row.status,
        row.confidence,
        row.created_at,
        row.is_private,
      );
      // Ignored insert → a row for this (channel_id, message_ts) already exists
      // (redelivery). Return that existing row instead of a phantom new one.
      if (info.changes === 0) {
        const existing =
          (row.message_ts != null ? selectByMsg.get(row.channel_id, row.message_ts) : null) ??
          selectById.get(row.id);
        if (existing) return /** @type {Decision} */ (existing);
      }
      return row;
    },
    listDecisions({ status, limit = 50 } = {}) {
      let sql = 'SELECT * FROM decisions';
      /** @type {any[]} */
      const params = [];
      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return /** @type {Decision[]} */ (db.prepare(sql).all(...params));
    },
    getDecision(id) {
      return /** @type {Decision | null} */ (selectById.get(id) ?? null);
    },
    supersede(id, byId) {
      supersedeStmt.run(id);
      // byId is accepted for interface parity; the superseding decision is
      // itself already stored as its own active row, so no extra link column
      // is required. Recorded here as a no-op reference.
      void byId;
    },
    /** @param {string} id */
    dismiss(id) {
      dismissStmt.run(id);
    },
    recordDismissal(newMessageText, matchedDecisionId) {
      insertDismissal.run(randomUUID(), newMessageText, matchedDecisionId, new Date().toISOString());
    },
    isKnownFalsePositive(newMessageText, decisionId) {
      const target = normalize(newMessageText);
      if (!target) return false;
      const rows = /** @type {{new_message_text: string}[]} */ (dismissalsForDecision.all(decisionId));
      return rows.some((r) => normalize(r.new_message_text) === target);
    },
    recordEvent(kind, decisionId) {
      insertEvent.run(randomUUID(), kind, decisionId ?? null, new Date().toISOString());
    },
    stats() {
      const counts = /** @type {{status: string, n: number}[]} */ (
        db.prepare('SELECT status, COUNT(*) AS n FROM decisions GROUP BY status').all()
      );
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
      const totalDecisions = /** @type {{n: number}} */ (db.prepare('SELECT COUNT(*) AS n FROM decisions').get()).n;
      const learnedPatterns = /** @type {{n: number}} */ (db.prepare('SELECT COUNT(*) AS n FROM dismissals').get()).n;
      const eventCounts = /** @type {{kind: string, n: number}[]} */ (
        db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all()
      );
      const byKind = Object.fromEntries(eventCounts.map((c) => [c.kind, c.n]));
      return computeStats({
        active: byStatus.active ?? 0,
        superseded: byStatus.superseded ?? 0,
        captured: totalDecisions,
        learnedPatterns,
        alertsFired: byKind.alert_fired ?? 0,
        dismissed: byKind.dismissed ?? 0,
      });
    },
  };
}

/**
 * Shared stats derivation so both backends agree on precision math.
 * @param {{active: number, superseded: number, captured: number, learnedPatterns: number, alertsFired: number, dismissed: number}} raw
 * @returns {Stats}
 */
function computeStats(raw) {
  const precisionPct =
    raw.alertsFired > 0 ? Math.round(((raw.alertsFired - raw.dismissed) / raw.alertsFired) * 100) : null;
  return {
    // Back-compat aliases.
    active: raw.active,
    superseded: raw.superseded,
    caught: raw.superseded,
    dismissed: raw.dismissed,
    // Learning-loop surface.
    activeDecisions: raw.active,
    captured: raw.captured,
    alertsFired: raw.alertsFired,
    learnedPatterns: raw.learnedPatterns,
    precisionPct,
  };
}

/**
 * Build the JSON-file fallback backend with an identical interface.
 * @returns {LedgerBackend}
 */
function createJsonBackend() {
  // Lazy require to avoid top-level fs when sqlite is available.
  const fs = require('node:fs');

  /** @returns {{decisions: Decision[], dismissals: {id: string, new_message_text: string, matched_decision_id: string, dismissed_at: string}[], events: {id: string, kind: string, decision_id: string|null, created_at: string}[]}} */
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      if (!Array.isArray(data.events)) data.events = [];
      return data;
    } catch {
      return { decisions: [], dismissals: [], events: [] };
    }
  }
  /** @param {ReturnType<typeof load>} data */
  function save(data) {
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
  }

  return {
    addDecision(d) {
      const data = load();
      // Durable dedup parity with SQLite: one decision per (channel_id, message_ts).
      // A redelivered capture returns the existing row instead of duplicating.
      if (d.message_ts != null) {
        const existing = data.decisions.find(
          (r) => r.channel_id === d.channel_id && r.message_ts === d.message_ts,
        );
        if (existing) return existing;
      }
      /** @type {Decision} */
      const row = {
        id: d.id,
        statement: d.statement,
        rationale: d.rationale ?? null,
        channel_id: d.channel_id,
        channel_name: d.channel_name ?? null,
        decided_by: d.decided_by ?? null,
        message_ts: d.message_ts ?? null,
        permalink: d.permalink ?? null,
        status: d.status ?? 'active',
        confidence: typeof d.confidence === 'number' ? d.confidence : 0,
        created_at: d.created_at ?? new Date().toISOString(),
        is_private: d.is_private ? 1 : 0,
      };
      data.decisions.push(row);
      save(data);
      return row;
    },
    listDecisions({ status, limit = 50 } = {}) {
      const data = load();
      let rows = data.decisions.slice();
      if (status) rows = rows.filter((r) => r.status === status);
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return rows.slice(0, limit);
    },
    getDecision(id) {
      return load().decisions.find((r) => r.id === id) ?? null;
    },
    supersede(id, byId) {
      const data = load();
      const row = data.decisions.find((r) => r.id === id);
      if (row) row.status = 'superseded';
      void byId;
      save(data);
    },
    /** @param {string} id */
    dismiss(id) {
      const data = load();
      const row = data.decisions.find((r) => r.id === id);
      if (row) row.status = 'dismissed';
      save(data);
    },
    recordDismissal(newMessageText, matchedDecisionId) {
      const data = load();
      data.dismissals.push({
        id: randomUUID(),
        new_message_text: newMessageText,
        matched_decision_id: matchedDecisionId,
        dismissed_at: new Date().toISOString(),
      });
      save(data);
    },
    isKnownFalsePositive(newMessageText, decisionId) {
      const target = normalize(newMessageText);
      if (!target) return false;
      return load()
        .dismissals.filter((r) => r.matched_decision_id === decisionId)
        .some((r) => normalize(r.new_message_text) === target);
    },
    recordEvent(kind, decisionId) {
      const data = load();
      data.events.push({
        id: randomUUID(),
        kind,
        decision_id: decisionId ?? null,
        created_at: new Date().toISOString(),
      });
      save(data);
    },
    stats() {
      const data = load();
      const active = data.decisions.filter((r) => r.status === 'active').length;
      const superseded = data.decisions.filter((r) => r.status === 'superseded').length;
      const alertsFired = data.events.filter((e) => e.kind === 'alert_fired').length;
      const dismissed = data.events.filter((e) => e.kind === 'dismissed').length;
      return computeStats({
        active,
        superseded,
        captured: data.decisions.length,
        learnedPatterns: data.dismissals.length,
        alertsFired,
        dismissed,
      });
    },
  };
}

/**
 * Select the best available backend once, at module load.
 * @returns {LedgerBackend}
 */
function selectBackend() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) return createSqliteBackend(DatabaseSync);
  } catch {
    // node:sqlite unavailable — fall through to JSON store.
  }
  return createJsonBackend();
}

const backend = selectBackend();

/**
 * Add a decision to the ledger. Generates an id if none is supplied.
 * @param {Partial<Decision> & {statement: string, channel_id: string, id?: string}} d
 * @returns {Decision}
 */
export function addDecision(d) {
  return backend.addDecision({ id: d.id ?? randomUUID(), ...d });
}

/**
 * List decisions, newest first, optionally filtered by status.
 * @param {{status?: string, limit?: number}} [opts]
 * @returns {Decision[]}
 */
export function listDecisions(opts = {}) {
  return backend.listDecisions(opts);
}

/**
 * Fetch a single decision by id.
 * @param {string} id
 * @returns {Decision | null}
 */
export function getDecision(id) {
  return backend.getDecision(id);
}

/**
 * Mark a decision superseded (optionally by another decision's id).
 * @param {string} id
 * @param {string | null} [byId]
 * @returns {void}
 */
export function supersede(id, byId = null) {
  backend.supersede(id, byId);
}

/**
 * Mark a captured row as not-a-decision (status 'dismissed').
 * @param {string} id
 * @returns {void}
 */
export function dismissDecision(id) {
  backend.dismiss(id);
}

/**
 * Record a user-confirmed false positive so we don't flag it again.
 * @param {string} newMessageText
 * @param {string} matchedDecisionId
 * @returns {void}
 */
export function recordDismissal(newMessageText, matchedDecisionId) {
  backend.recordDismissal(newMessageText, matchedDecisionId);
}

/**
 * Whether this message/decision pair was previously dismissed as not-a-conflict.
 * @param {string} newMessageText
 * @param {string} decisionId
 * @returns {boolean}
 */
export function isKnownFalsePositive(newMessageText, decisionId) {
  return backend.isKnownFalsePositive(newMessageText, decisionId);
}

/**
 * Record a learning-loop event (alert_fired | dismissed | superseded | captured).
 * @param {EventKind} kind
 * @param {string | null} [decisionId]
 * @returns {void}
 */
export function recordEvent(kind, decisionId = null) {
  backend.recordEvent(kind, decisionId);
}

/**
 * Ledger summary counts for the App Home dashboard.
 * @returns {Stats}
 */
export function stats() {
  return backend.stats();
}
