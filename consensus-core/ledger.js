/**
 * Decision Ledger — durable store of detected team decisions and the learned
 * "not-a-conflict" memory (dismissals).
 *
 * Durable backend is MongoDB Atlas: when `MONGODB_URI` is set, the ledger reads
 * and writes a MongoDB database (collections: decisions, events, dismissals,
 * audit_dismissals) so data survives host restarts natively. When it is NOT set
 * (local dev, CI, GitHub Actions), the ledger falls back to Node's built-in
 * `node:sqlite`, and if that too is unavailable, to a tiny JSON-file store. All
 * three expose the SAME interface, so callers never branch on the backend.
 *
 * NOTE: the MongoDB driver is async, so the top-level ledger functions and the
 * backend methods are async. The SQLite/JSON backends return synchronously, but
 * `await` on a non-Promise is a no-op, so a single async call site works for
 * every backend.
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
 * @property {'proposed'|'confirmed'|'active'|'exception'|'superseded'|'expired'|'rejected'} status
 * @property {number} confidence
 * @property {string} created_at
 * @property {number} is_private
 * @property {string|null} team_label
 * @property {string|null} applies_to
 * @property {string|null} expires_at ISO-8601; when set and in the past the decision is treated as expired.
 * @property {string|null} owner_user_id
 * @property {string|null} authority_level e.g. 'policy' | 'project' | 'preference'
 * @property {string|null} exception_of id of the parent decision this row carves an
 *   exception out of. Null for a self-exception (a standing item annotated as a
 *   non-enforced carve-out) and for every non-exception row. See governance.narrowsScope
 *   for the intended Phase-2 parent-linked semantics.
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
 * @typedef {'alert_fired'|'dismissed'|'capture_dismissed'|'superseded'|'captured'|'audit_run'|'edited_sync'|'deleted_sync'|'confirmed'|'rejected'|'exception'} EventKind
 *
 * A backend method may return its value synchronously (SQLite/JSON) or as a
 * Promise (MongoDB). Callers always `await`, so both shapes are interchangeable;
 * each property below is typed as `T | Promise<T>`.
 *
 * @typedef {Object} LedgerBackend
 * @property {(d: Partial<Decision> & {id: string, statement: string, channel_id: string}) => Decision | Promise<Decision>} addDecision
 * @property {(opts?: {status?: string | string[], limit?: number}) => Decision[] | Promise<Decision[]>} listDecisions
 * @property {(channelId: string, messageTs: string) => Decision[] | Promise<Decision[]>} listDecisionsByMessage
 * @property {(id: string) => (Decision | null) | Promise<Decision | null>} getDecision
 * @property {(id: string, byId: string | null) => void | Promise<void>} supersede
 * @property {(id: string) => void | Promise<void>} dismiss
 * @property {(id: string, status: Decision['status']) => void | Promise<void>} setStatus
 * @property {(newMessageText: string, matchedDecisionId: string, userId: string | null) => void | Promise<void>} recordDismissal
 * @property {(newMessageText: string, decisionId: string, userId: string | null) => boolean | Promise<boolean>} isKnownFalsePositive
 * @property {(aId: string, bId: string) => void | Promise<void>} recordAuditDismissal
 * @property {(aId: string, bId: string) => boolean | Promise<boolean>} isAuditPairDismissed
 * @property {(userId: string, isoTimestamp: string) => number | Promise<number>} countDecisionsByAuthorSince
 * @property {(kind: EventKind, decisionId: string | null) => void | Promise<void>} recordEvent
 * @property {() => Stats | Promise<Stats>} stats
 * @property {() => Promise<void>} [connect] Establish the connection + indexes once (MongoDB only).
 * @property {() => Promise<void>} [close] Close the connection (MongoDB only; used by tests).
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { mapLegacyStatus } from './governance.js';

const require = createRequire(import.meta.url);

/**
 * MongoDB connection string. When set, the ledger uses MongoDB as its durable
 * store (data persists natively across restarts); when unset, the SQLite/JSON
 * fallback is used. Never committed — supplied via env (Render dashboard).
 * @type {string | undefined}
 */
const MONGODB_URI = process.env.MONGODB_URI;
/**
 * MongoDB database name for the ledger. Defaults to `consensus`.
 * @type {string}
 */
const MONGODB_DB = process.env.MONGODB_DB || 'consensus';

/**
 * SQLite ledger file path. Defaults to the repo-local `./consensus.db` (the
 * historical GitHub Actions behavior), but is overridable via
 * `CONSENSUS_DB_PATH` so hosts with a persistent disk (e.g. a Render worker
 * mounting a volume at /data) can point the ledger at durable storage.
 * @type {string}
 */
const DB_PATH = process.env.CONSENSUS_DB_PATH || './consensus.db';
/**
 * JSON-fallback ledger path, derived from {@link DB_PATH} so both backends live
 * on the same (possibly persistent) volume. `foo.db` -> `foo-ledger.json`.
 * @type {string}
 */
const JSON_PATH = DB_PATH.replace(/\.db$/, '') + '-ledger.json';

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
 * Canonical key for an unordered pair of decision ids: the two ids sorted and
 * joined with '|'. Order-insensitive so (a,b) and (b,a) map to the same key.
 * @param {string} aId
 * @param {string} bId
 * @returns {string}
 */
export function auditPairKey(aId, bId) {
  return [String(aId ?? ''), String(bId ?? '')].sort().join('|');
}

/**
 * Build the SQLite-backed ledger. `dbPath` is injectable so tests can build a
 * backend on a temp file; production uses the module default.
 * @param {new (path: string) => any} DatabaseSync
 * @param {string} [dbPath]
 * @returns {LedgerBackend}
 */
export function createSqliteBackend(DatabaseSync, dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
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
      created_at TEXT NOT NULL,
      team_label TEXT,
      applies_to TEXT,
      expires_at TEXT,
      owner_user_id TEXT,
      authority_level TEXT,
      exception_of TEXT
    );
    CREATE TABLE IF NOT EXISTS dismissals (
      id TEXT PRIMARY KEY,
      new_message_text TEXT NOT NULL,
      matched_decision_id TEXT,
      user_id TEXT,
      dismissed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      decision_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_dismissals (
      pair_key TEXT PRIMARY KEY,
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

  // Idempotent migration: add the Phase-1 governance/scope columns if an older
  // DB predates them. Same PRAGMA-check pattern as is_private above — node:sqlite
  // has no "ADD COLUMN IF NOT EXISTS". All are nullable with no default, so a
  // legacy row simply reads back null for each.
  try {
    const cols = /** @type {{name: string}[]} */ (db.prepare('PRAGMA table_info(decisions)').all());
    const have = new Set(cols.map((c) => c.name));
    for (const col of ['team_label', 'applies_to', 'expires_at', 'owner_user_id', 'authority_level', 'exception_of']) {
      if (!have.has(col)) db.exec(`ALTER TABLE decisions ADD COLUMN ${col} TEXT`);
    }
  } catch {
    // If the pragma/alter fails, callers still work (new fields read as null).
  }

  // Idempotent migration: remap the legacy status vocabulary to the Phase-1
  // lifecycle states. Only `dismissed` was renamed (→ `rejected`); `active` and
  // `superseded` keep their meaning. This is a data UPDATE (not a schema change),
  // and it is naturally idempotent — after it runs there are no `dismissed` rows
  // left, so a second run touches nothing.
  try {
    db.exec("UPDATE decisions SET status = 'rejected' WHERE status = 'dismissed'");
  } catch {
    // Best-effort; a failed remap leaves legacy rows readable (mapped on read is
    // not done for SQLite, but the demo/seed never writes 'dismissed' anymore).
  }

  // Idempotent migration: add user_id to dismissals if an older DB predates
  // per-user dismissal scoping. Same PRAGMA-check pattern as is_private above.
  // Legacy rows keep a NULL user_id and therefore match NO ONE on lookup (a
  // dismissal is one person's judgment about their own alert — see
  // isKnownFalsePositive), so no back-compat handling is needed.
  try {
    const cols = /** @type {{name: string}[]} */ (db.prepare('PRAGMA table_info(dismissals)').all());
    if (!cols.some((c) => c.name === 'user_id')) {
      db.exec('ALTER TABLE dismissals ADD COLUMN user_id TEXT');
    }
  } catch {
    // If the pragma/alter fails, per-user scoping still holds: legacy rows read
    // back with a null user_id and match no one.
  }

  // Idempotent migration: guarantee at most one decision per (channel, message).
  // Slack redelivers events across restarts; without this a redelivered capture
  // could insert a duplicate row. SQLite treats NULL message_ts as distinct, so
  // rows without a ts are unaffected. Best-effort: if legacy duplicates already
  // exist the index creation fails and we simply fall back to non-unique inserts.
  try {
    // v2 uniqueness: multi-decision capture stores SEVERAL rows per source
    // message, so uniqueness must include the statement. Migrate away from the
    // old (channel_id, message_ts) index which silently blocked the 2nd+
    // decision of a message and returned the wrong existing row.
    db.exec('DROP INDEX IF EXISTS idx_decisions_msg');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_msg_stmt ON decisions(channel_id, message_ts, statement)');
  } catch {
    // Pre-existing duplicates or older engine — dedup index is best-effort.
  }

  // INSERT OR IGNORE so a redelivered (channel_id, message_ts) is a no-op rather
  // than a thrown unique-constraint error; addDecision then returns the existing row.
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (id, statement, rationale, channel_id, channel_name, decided_by, message_ts, permalink, status, confidence, created_at, is_private, team_label, applies_to, expires_at, owner_user_id, authority_level, exception_of)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare('SELECT * FROM decisions WHERE id = ?');
  const selectByMsg = db.prepare('SELECT * FROM decisions WHERE channel_id = ? AND message_ts = ? AND statement = ?');
  const selectAllByMsg = db.prepare(
    'SELECT * FROM decisions WHERE channel_id = ? AND message_ts = ? ORDER BY created_at DESC',
  );
  const supersedeStmt = db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?");
  const setStatusStmt = db.prepare('UPDATE decisions SET status = ? WHERE id = ?');
  const insertDismissal = db.prepare(
    'INSERT INTO dismissals (id, new_message_text, matched_decision_id, user_id, dismissed_at) VALUES (?, ?, ?, ?, ?)',
  );
  // Scope lookups to the SAME dismissing user. `user_id = ?` bound to a non-null
  // id can never match a legacy NULL row (SQL NULL = value is never true), so
  // pre-migration dismissals match no one — exactly the intended reset.
  const dismissalsForDecisionUser = db.prepare(
    'SELECT new_message_text FROM dismissals WHERE matched_decision_id = ? AND user_id = ?',
  );
  const countByAuthorSince = db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE decided_by = ? AND created_at >= ?');
  const insertEvent = db.prepare('INSERT INTO events (id, kind, decision_id, created_at) VALUES (?, ?, ?, ?)');
  const insertAuditDismissal = db.prepare(
    'INSERT OR IGNORE INTO audit_dismissals (pair_key, created_at) VALUES (?, ?)',
  );
  const selectAuditDismissal = db.prepare('SELECT 1 FROM audit_dismissals WHERE pair_key = ?');

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
        team_label: d.team_label ?? null,
        applies_to: d.applies_to ?? null,
        expires_at: d.expires_at ?? null,
        owner_user_id: d.owner_user_id ?? null,
        authority_level: d.authority_level ?? null,
        exception_of: d.exception_of ?? null,
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
        row.team_label,
        row.applies_to,
        row.expires_at,
        row.owner_user_id,
        row.authority_level,
        row.exception_of,
      );
      // Ignored insert → a row for this (channel_id, message_ts) already exists
      // (redelivery). Return that existing row instead of a phantom new one.
      if (info.changes === 0) {
        const existing =
          (row.message_ts != null ? selectByMsg.get(row.channel_id, row.message_ts, row.statement) : null) ??
          selectById.get(row.id);
        if (existing) return /** @type {Decision} */ (existing);
      }
      return row;
    },
    listDecisions({ status, limit = 50 } = {}) {
      let sql = 'SELECT * FROM decisions';
      /** @type {any[]} */
      const params = [];
      const statuses = Array.isArray(status) ? status : status ? [status] : [];
      if (statuses.length > 0) {
        sql += ` WHERE status IN (${statuses.map(() => '?').join(', ')})`;
        params.push(...statuses);
      }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return /** @type {Decision[]} */ (db.prepare(sql).all(...params));
    },
    listDecisionsByMessage(channelId, messageTs) {
      if (messageTs == null) return [];
      return /** @type {Decision[]} */ (selectAllByMsg.all(channelId, messageTs));
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
      // A rejected capture is status 'rejected' in the Phase-1 vocabulary.
      setStatusStmt.run('rejected', id);
    },
    /** @param {string} id @param {Decision['status']} status */
    setStatus(id, status) {
      setStatusStmt.run(status, id);
    },
    recordDismissal(newMessageText, matchedDecisionId, userId) {
      insertDismissal.run(randomUUID(), newMessageText, matchedDecisionId, userId ?? null, new Date().toISOString());
    },
    isKnownFalsePositive(newMessageText, decisionId, userId) {
      const target = normalize(newMessageText);
      if (!target) return false;
      // A lookup without a user id (or against legacy null rows) matches no one.
      if (userId == null) return false;
      const rows = /** @type {{new_message_text: string}[]} */ (dismissalsForDecisionUser.all(decisionId, userId));
      return rows.some((r) => normalize(r.new_message_text) === target);
    },
    countDecisionsByAuthorSince(userId, isoTimestamp) {
      const row = /** @type {{n: number}} */ (countByAuthorSince.get(userId, isoTimestamp));
      return row?.n ?? 0;
    },
    recordAuditDismissal(aId, bId) {
      insertAuditDismissal.run(auditPairKey(aId, bId), new Date().toISOString());
    },
    isAuditPairDismissed(aId, bId) {
      return selectAuditDismissal.get(auditPairKey(aId, bId)) != null;
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
        // `confirmed` and `active` are both enforceable — count them together as
        // the "active decisions" surfaced on the dashboard.
        active: (byStatus.active ?? 0) + (byStatus.confirmed ?? 0),
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
 * Shared stats derivation so both backends agree on precision math. `dismissed`
 * counts ALERT dismissals only ('dismissed' events); rejecting a decision capture
 * is recorded under the distinct 'capture_dismissed' kind and never feeds this
 * precision math. precisionPct is clamped to 0..100 defensively so a stray
 * accounting skew (e.g. more dismissals than recorded alerts) can never surface a
 * negative or >100 percentage. Exported for unit testing.
 * @param {{active: number, superseded: number, captured: number, learnedPatterns: number, alertsFired: number, dismissed: number}} raw
 * @returns {Stats}
 */
export function computeStats(raw) {
  const precisionPct =
    raw.alertsFired > 0
      ? Math.min(100, Math.max(0, Math.round(((raw.alertsFired - raw.dismissed) / raw.alertsFired) * 100)))
      : null;
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
 * Build the JSON-file fallback backend with an identical interface. `jsonPath`
 * is injectable so tests can build a backend on a temp file; production uses the
 * module default.
 * @param {string} [jsonPath]
 * @returns {LedgerBackend}
 */
export function createJsonBackend(jsonPath = JSON_PATH) {
  // Lazy require to avoid top-level fs when sqlite is available.
  const fs = require('node:fs');

  /** @returns {{decisions: Decision[], dismissals: {id: string, new_message_text: string, matched_decision_id: string, user_id?: string|null, dismissed_at: string}[], events: {id: string, kind: string, decision_id: string|null, created_at: string}[], auditDismissals: {pair_key: string, created_at: string}[]}} */
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (!Array.isArray(data.events)) data.events = [];
      if (!Array.isArray(data.auditDismissals)) data.auditDismissals = [];
      // Migrate-on-load parity with SQLite: remap the legacy status vocabulary
      // (dismissed→rejected) and backfill the nullable governance/scope fields so
      // callers see a uniform Decision shape regardless of when a row was written.
      if (Array.isArray(data.decisions)) {
        for (const r of data.decisions) {
          r.status = mapLegacyStatus(r.status);
          if (r.team_label === undefined) r.team_label = null;
          if (r.applies_to === undefined) r.applies_to = null;
          if (r.expires_at === undefined) r.expires_at = null;
          if (r.owner_user_id === undefined) r.owner_user_id = null;
          if (r.authority_level === undefined) r.authority_level = null;
          if (r.exception_of === undefined) r.exception_of = null;
        }
      }
      return data;
    } catch {
      return { decisions: [], dismissals: [], events: [], auditDismissals: [] };
    }
  }
  /** @param {ReturnType<typeof load>} data */
  function save(data) {
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  }

  return {
    addDecision(d) {
      const data = load();
      // Durable dedup parity with SQLite: one decision per (channel_id, message_ts).
      // A redelivered capture returns the existing row instead of duplicating.
      if (d.message_ts != null) {
        const existing = data.decisions.find(
          (r) => r.channel_id === d.channel_id && r.message_ts === d.message_ts && r.statement === d.statement,
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
        team_label: d.team_label ?? null,
        applies_to: d.applies_to ?? null,
        expires_at: d.expires_at ?? null,
        owner_user_id: d.owner_user_id ?? null,
        authority_level: d.authority_level ?? null,
        exception_of: d.exception_of ?? null,
      };
      data.decisions.push(row);
      save(data);
      return row;
    },
    listDecisions({ status, limit = 50 } = {}) {
      const data = load();
      let rows = data.decisions.slice();
      const statuses = Array.isArray(status) ? status : status ? [status] : [];
      if (statuses.length > 0) rows = rows.filter((r) => statuses.includes(r.status));
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return rows.slice(0, limit);
    },
    listDecisionsByMessage(channelId, messageTs) {
      if (messageTs == null) return [];
      return load()
        .decisions.filter((r) => r.channel_id === channelId && r.message_ts === messageTs)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
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
      if (row) row.status = 'rejected';
      save(data);
    },
    /** @param {string} id @param {Decision['status']} status */
    setStatus(id, status) {
      const data = load();
      const row = data.decisions.find((r) => r.id === id);
      if (row) row.status = status;
      save(data);
    },
    recordDismissal(newMessageText, matchedDecisionId, userId) {
      const data = load();
      data.dismissals.push({
        id: randomUUID(),
        new_message_text: newMessageText,
        matched_decision_id: matchedDecisionId,
        user_id: userId ?? null,
        dismissed_at: new Date().toISOString(),
      });
      save(data);
    },
    isKnownFalsePositive(newMessageText, decisionId, userId) {
      const target = normalize(newMessageText);
      if (!target) return false;
      // Scope to the SAME dismissing user. A lookup without a user id, and any
      // legacy row whose user_id is null/undefined, matches no one (the guard
      // `r.user_id != null` drops pre-scoping rows before the equality check).
      if (userId == null) return false;
      return load()
        .dismissals.filter((r) => r.matched_decision_id === decisionId && r.user_id != null && r.user_id === userId)
        .some((r) => normalize(r.new_message_text) === target);
    },
    countDecisionsByAuthorSince(userId, isoTimestamp) {
      return load().decisions.filter((r) => r.decided_by === userId && r.created_at >= isoTimestamp).length;
    },
    recordAuditDismissal(aId, bId) {
      const data = load();
      const key = auditPairKey(aId, bId);
      if (!data.auditDismissals.some((r) => r.pair_key === key)) {
        data.auditDismissals.push({ pair_key: key, created_at: new Date().toISOString() });
        save(data);
      }
    },
    isAuditPairDismissed(aId, bId) {
      const key = auditPairKey(aId, bId);
      return load().auditDismissals.some((r) => r.pair_key === key);
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
      // `confirmed` and `active` are both enforceable — count them together.
      const active = data.decisions.filter((r) => r.status === 'active' || r.status === 'confirmed').length;
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
 * Build the MongoDB-backed ledger — the durable production store. Reuses ONE
 * {@link MongoClient} (the driver pools connections internally), so callers never
 * reconnect per operation. Every method awaits {@link ensureConnected} first,
 * which connects + creates indexes exactly once.
 *
 * Collections:
 *   - `decisions`         one document per captured decision (`_id` = decision id)
 *   - `events`            learning-loop events (alert_fired, dismissed, …)
 *   - `dismissals`        per-user "not a conflict" memory
 *   - `audit_dismissals`  dismissed audit PAIRS (`_id` = pair_key)
 *
 * Uniqueness on (channel_id, message_ts, statement) is enforced by a PARTIAL
 * unique index limited to rows whose message_ts is a string — matching SQLite,
 * where a NULL message_ts is distinct and never collides.
 * @param {{uri: string, dbName: string}} opts
 * @returns {LedgerBackend}
 */
export function createMongoBackend({ uri, dbName }) {
  const client = new MongoClient(uri);
  /** @type {Promise<void> | null} Memoized connect+index promise. */
  let ready = null;
  const db = () => client.db(dbName);
  const decisions = () => db().collection('decisions');
  const dismissals = () => db().collection('dismissals');
  const events = () => db().collection('events');
  const auditDismissals = () => db().collection('audit_dismissals');

  /**
   * Connect once and create indexes once. Idempotent: the memoized promise means
   * concurrent first-calls share a single connect.
   * @returns {Promise<void>}
   */
  function ensureConnected() {
    if (!ready) {
      ready = (async () => {
        await client.connect();
        // Uniqueness parity with SQLite's idx_decisions_msg_stmt: only rows with
        // a string message_ts participate, so NULL-ts rows never collide.
        await decisions().createIndex(
          { channel_id: 1, message_ts: 1, statement: 1 },
          { unique: true, partialFilterExpression: { message_ts: { $type: 'string' } } },
        );
        await decisions().createIndex({ created_at: -1 });
        await decisions().createIndex({ channel_id: 1, message_ts: 1 });
        await decisions().createIndex({ decided_by: 1, created_at: 1 });
        await dismissals().createIndex({ matched_decision_id: 1, user_id: 1 });
        await events().createIndex({ kind: 1 });
      })();
    }
    return ready;
  }

  /**
   * Strip Mongo's `_id` from a decision document so the returned shape is exactly
   * a {@link Decision}. `_id` mirrors `id`, so no data is lost.
   * @param {any} doc
   * @returns {Decision | null}
   */
  function stripId(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    void _id;
    return /** @type {Decision} */ (rest);
  }

  return {
    async addDecision(d) {
      await ensureConnected();
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
        team_label: d.team_label ?? null,
        applies_to: d.applies_to ?? null,
        expires_at: d.expires_at ?? null,
        owner_user_id: d.owner_user_id ?? null,
        authority_level: d.authority_level ?? null,
        exception_of: d.exception_of ?? null,
      };
      // Durable dedup parity with SQLite (INSERT OR IGNORE): a redelivered
      // (channel_id, message_ts, statement) returns the existing row. Fast path
      // is a findOne; the unique index is the backstop against a concurrent race.
      if (row.message_ts != null) {
        const existing = await decisions().findOne({
          channel_id: row.channel_id,
          message_ts: row.message_ts,
          statement: row.statement,
        });
        if (existing) return /** @type {Decision} */ (stripId(existing));
      }
      try {
        await decisions().insertOne({ _id: /** @type {any} */ (row.id), ...row });
      } catch (e) {
        // Duplicate key (11000): a concurrent insert won the race — return the
        // now-existing row rather than a phantom. Same net behavior as OR IGNORE.
        if (/** @type {any} */ (e)?.code === 11000) {
          const existing =
            (row.message_ts != null
              ? await decisions().findOne({
                  channel_id: row.channel_id,
                  message_ts: row.message_ts,
                  statement: row.statement,
                })
              : null) ?? (await decisions().findOne({ _id: /** @type {any} */ (row.id) }));
          if (existing) return /** @type {Decision} */ (stripId(existing));
        }
        throw e;
      }
      return row;
    },
    async listDecisions({ status, limit = 50 } = {}) {
      await ensureConnected();
      const statuses = Array.isArray(status) ? status : status ? [status] : [];
      /** @type {Record<string, any>} */
      const filter = {};
      if (statuses.length > 0) filter.status = { $in: statuses };
      const docs = await decisions()
        .find(filter, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
      return /** @type {Decision[]} */ (/** @type {unknown} */ (docs));
    },
    async listDecisionsByMessage(channelId, messageTs) {
      await ensureConnected();
      if (messageTs == null) return [];
      const docs = await decisions()
        .find({ channel_id: channelId, message_ts: messageTs }, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .toArray();
      return /** @type {Decision[]} */ (/** @type {unknown} */ (docs));
    },
    async getDecision(id) {
      await ensureConnected();
      return stripId(await decisions().findOne({ _id: /** @type {any} */ (id) }, { projection: {} }));
    },
    async supersede(id, byId) {
      await ensureConnected();
      await decisions().updateOne({ _id: /** @type {any} */ (id) }, { $set: { status: 'superseded' } });
      void byId;
    },
    async dismiss(id) {
      await ensureConnected();
      await decisions().updateOne({ _id: /** @type {any} */ (id) }, { $set: { status: 'rejected' } });
    },
    async setStatus(id, status) {
      await ensureConnected();
      await decisions().updateOne({ _id: /** @type {any} */ (id) }, { $set: { status } });
    },
    async recordDismissal(newMessageText, matchedDecisionId, userId) {
      await ensureConnected();
      await dismissals().insertOne({
        id: randomUUID(),
        new_message_text: newMessageText,
        matched_decision_id: matchedDecisionId,
        user_id: userId ?? null,
        dismissed_at: new Date().toISOString(),
      });
    },
    async isKnownFalsePositive(newMessageText, decisionId, userId) {
      await ensureConnected();
      const target = normalize(newMessageText);
      if (!target) return false;
      // A lookup without a user id (or against legacy null rows) matches no one.
      if (userId == null) return false;
      const rows = /** @type {{new_message_text: string}[]} */ (
        /** @type {unknown} */ (
          await dismissals()
            .find({ matched_decision_id: decisionId, user_id: userId }, { projection: { new_message_text: 1, _id: 0 } })
            .toArray()
        )
      );
      return rows.some((r) => normalize(r.new_message_text) === target);
    },
    async countDecisionsByAuthorSince(userId, isoTimestamp) {
      await ensureConnected();
      return decisions().countDocuments({ decided_by: userId, created_at: { $gte: isoTimestamp } });
    },
    async recordAuditDismissal(aId, bId) {
      await ensureConnected();
      const key = auditPairKey(aId, bId);
      // Upsert on the pair key so a repeat dismissal is a no-op (parity with the
      // SQLite INSERT OR IGNORE); created_at is only written on first insert.
      await auditDismissals().updateOne(
        { _id: /** @type {any} */ (key) },
        { $setOnInsert: { pair_key: key, created_at: new Date().toISOString() } },
        { upsert: true },
      );
    },
    async isAuditPairDismissed(aId, bId) {
      await ensureConnected();
      return (await auditDismissals().findOne({ _id: /** @type {any} */ (auditPairKey(aId, bId)) })) != null;
    },
    async recordEvent(kind, decisionId) {
      await ensureConnected();
      await events().insertOne({
        id: randomUUID(),
        kind,
        decision_id: decisionId ?? null,
        created_at: new Date().toISOString(),
      });
    },
    async stats() {
      await ensureConnected();
      const statusAgg = /** @type {{_id: string, n: number}[]} */ (
        await decisions()
          .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
          .toArray()
      );
      const byStatus = Object.fromEntries(statusAgg.map((c) => [c._id, c.n]));
      const totalDecisions = await decisions().countDocuments({});
      const learnedPatterns = await dismissals().countDocuments({});
      const kindAgg = /** @type {{_id: string, n: number}[]} */ (
        await events()
          .aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }])
          .toArray()
      );
      const byKind = Object.fromEntries(kindAgg.map((c) => [c._id, c.n]));
      return computeStats({
        active: (byStatus.active ?? 0) + (byStatus.confirmed ?? 0),
        superseded: byStatus.superseded ?? 0,
        captured: totalDecisions,
        learnedPatterns,
        alertsFired: byKind.alert_fired ?? 0,
        dismissed: byKind.dismissed ?? 0,
      });
    },
    connect: ensureConnected,
    async close() {
      await client.close();
    },
  };
}

/**
 * Select the best available backend once, at module load. Prefers MongoDB when
 * `MONGODB_URI` is set (durable, survives restarts), else SQLite, else the JSON
 * fallback. Async because the MongoDB client connects + builds indexes before
 * the first operation.
 * @returns {Promise<LedgerBackend>}
 */
async function selectBackend() {
  if (MONGODB_URI) {
    const mongo = createMongoBackend({ uri: MONGODB_URI, dbName: MONGODB_DB });
    await mongo.connect?.();
    return mongo;
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) return createSqliteBackend(DatabaseSync);
  } catch {
    // node:sqlite unavailable — fall through to JSON store.
  }
  return createJsonBackend();
}

/**
 * Lazily-resolved backend singleton. Memoized so the (possibly async) selection
 * and MongoDB connect happen exactly once, and every ledger call reuses the same
 * pooled client.
 * @type {Promise<LedgerBackend> | null}
 */
let backendPromise = null;

/**
 * @returns {Promise<LedgerBackend>}
 */
function getBackend() {
  if (!backendPromise) backendPromise = selectBackend();
  return backendPromise;
}

/**
 * Add a decision to the ledger. Generates an id if none is supplied.
 * @param {Partial<Decision> & {statement: string, channel_id: string, id?: string}} d
 * @returns {Promise<Decision>}
 */
export async function addDecision(d) {
  const backend = await getBackend();
  return backend.addDecision({ id: d.id ?? randomUUID(), ...d });
}

/**
 * List decisions, newest first, optionally filtered by status (a single status
 * or an array of statuses matched with SQL `IN`).
 * @param {{status?: string | string[], limit?: number}} [opts]
 * @returns {Promise<Decision[]>}
 */
export async function listDecisions(opts = {}) {
  const backend = await getBackend();
  return backend.listDecisions(opts);
}

/**
 * List every decision captured from a single source message, newest first.
 * Used by the edit/delete sync path to reconcile the ledger with human
 * corrections to the original message.
 * @param {string} channelId
 * @param {string} messageTs
 * @returns {Promise<Decision[]>}
 */
export async function listDecisionsByMessage(channelId, messageTs) {
  const backend = await getBackend();
  return backend.listDecisionsByMessage(channelId, messageTs);
}

/**
 * Fetch a single decision by id.
 * @param {string} id
 * @returns {Promise<Decision | null>}
 */
export async function getDecision(id) {
  const backend = await getBackend();
  return backend.getDecision(id);
}

/**
 * Retire a decision the team has revoked (via an edit or delete of its source
 * message): sets status to 'superseded', reusing the existing status vocabulary.
 * `reason` is contextual only — it is logged by callers, never stored.
 * @param {string} id
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export async function retireDecision(id, reason) {
  void reason;
  const backend = await getBackend();
  await backend.supersede(id, null);
}

/**
 * Mark a decision superseded (optionally by another decision's id).
 * @param {string} id
 * @param {string | null} [byId]
 * @returns {Promise<void>}
 */
export async function supersede(id, byId = null) {
  const backend = await getBackend();
  await backend.supersede(id, byId);
}

/**
 * Mark a captured row as not-a-decision (status 'rejected').
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function dismissDecision(id) {
  const backend = await getBackend();
  await backend.dismiss(id);
}

/**
 * Transition a decision to an explicit lifecycle status (e.g. 'confirmed',
 * 'rejected', 'exception'). Callers are responsible for the authority gate
 * (see governance.canConfirm) — the ledger just records the state.
 * @param {string} id
 * @param {Decision['status']} status
 * @returns {Promise<void>}
 */
export async function setDecisionStatus(id, status) {
  const backend = await getBackend();
  await backend.setStatus(id, status);
}

/**
 * Record a user-confirmed false positive so we don't flag it again — scoped to
 * the dismissing user.
 *
 * Per-user scoping is a security boundary, not a nicety: a dismissal is one
 * person's judgment about their OWN alert (alerts are ephemeral, seen only by the
 * message author). When this memory was GLOBAL, any user who dismissed an alert
 * suppressed that (normalized message text, decision) pair for EVERYONE forever —
 * a dismissal-poisoning vector where a malicious member posts a real
 * contradiction, dismisses their own alert, and silences the identical message
 * for the whole workspace. Scoping the memory to `userId` confines each dismissal
 * to the person who made it.
 * @param {string} newMessageText
 * @param {string} matchedDecisionId
 * @param {string | null} [userId] the dismissing user (from the action body)
 * @returns {Promise<void>}
 */
export async function recordDismissal(newMessageText, matchedDecisionId, userId = null) {
  const backend = await getBackend();
  await backend.recordDismissal(newMessageText, matchedDecisionId, userId);
}

/**
 * Whether this message/decision pair was previously dismissed as not-a-conflict
 * BY THIS user. Only the dismissing user's own rows are consulted; another user's
 * dismissal never suppresses this user's alert, and legacy rows without a user_id
 * match no one. See {@link recordDismissal} for the poisoning rationale behind the
 * per-user scope.
 * @param {string} newMessageText
 * @param {string} decisionId
 * @param {string | null} [userId] the message author being alerted
 * @returns {Promise<boolean>}
 */
export async function isKnownFalsePositive(newMessageText, decisionId, userId = null) {
  const backend = await getBackend();
  return backend.isKnownFalsePositive(newMessageText, decisionId, userId);
}

/**
 * Count decisions captured by `userId` at or after `isoTimestamp`. Backs the
 * daily per-author capture cap (see pipeline.js MAX_CAPTURES_PER_USER_PER_DAY),
 * which blunts slow ledger pollution.
 * @param {string} userId
 * @param {string} isoTimestamp ISO-8601; created_at is stored in the same format,
 *   so a lexicographic `>=` compare is a correct chronological compare.
 * @returns {Promise<number>}
 */
export async function countDecisionsByAuthorSince(userId, isoTimestamp) {
  const backend = await getBackend();
  return backend.countDecisionsByAuthorSince(userId, isoTimestamp);
}

/**
 * Record a user-confirmed "not a conflict" verdict for a decision PAIR (from the
 * consistency audit), so the pair is never re-surfaced by a future audit.
 * @param {string} aId
 * @param {string} bId
 * @returns {Promise<void>}
 */
export async function recordAuditDismissal(aId, bId) {
  const backend = await getBackend();
  await backend.recordAuditDismissal(aId, bId);
}

/**
 * Whether this decision pair was previously dismissed as not-a-conflict in an audit.
 * @param {string} aId
 * @param {string} bId
 * @returns {Promise<boolean>}
 */
export async function isAuditPairDismissed(aId, bId) {
  const backend = await getBackend();
  return backend.isAuditPairDismissed(aId, bId);
}

/**
 * Record a learning-loop event
 * (alert_fired | dismissed | capture_dismissed | superseded | captured | audit_run | edited_sync | deleted_sync | confirmed | rejected | exception).
 * @param {EventKind} kind
 * @param {string | null} [decisionId]
 * @returns {Promise<void>}
 */
export async function recordEvent(kind, decisionId = null) {
  const backend = await getBackend();
  await backend.recordEvent(kind, decisionId);
}

/**
 * Ledger summary counts for the App Home dashboard.
 * @returns {Promise<Stats>}
 */
export async function stats() {
  const backend = await getBackend();
  return backend.stats();
}
