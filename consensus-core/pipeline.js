/**
 * Consensus ambient brain — runs on every channel message.
 *
 * Two independent jobs per message:
 *   1. Capture: is this message itself a finalized team decision? If so, log it
 *      and post a "Decision captured" card in-thread.
 *   2. Guard: does this message contradict any prior active decision (from a
 *      DIFFERENT thread)? If so, warn the author ephemerally.
 *
 * Every LLM call is sequential, wrapped in try/catch, and must never crash the
 * app. Timings are logged.
 */

import { contradictionAlert, decisionCard } from './blocks.js';
import { captureStatusForChannel, isEnforceable } from './governance.js';
import { classifyDecisions, judgeContradiction } from './judge.js';
import {
  addDecision,
  countDecisionsByAuthorSince,
  isKnownFalsePositive,
  listDecisions,
  listDecisionsByMessage,
  recordEvent,
  retireDecision,
} from './ledger.js';
import { canSeeDecision } from './permissions.js';
import { searchContext } from './rts.js';

/**
 * Enforceable candidate statuses — the ledger rows worth handing to the
 * contradiction judge. Both are enforcing (see governance.isEnforceable); an
 * additional per-row {@link isEnforceable} filter then drops any that have
 * passed their expires_at. `proposed`, `exception`, `superseded`, `expired`, and
 * `rejected` are intentionally excluded here.
 * @type {string[]}
 */
const ENFORCEABLE_STATUSES = ['active', 'confirmed'];

/**
 * Cheap, pure "until &lt;date&gt;" expiry parser for the capture path — extracts an
 * ISO calendar date (YYYY-MM-DD) that trails an "until"/"through"/"expires"
 * keyword and returns it as an end-of-day ISO timestamp. Deliberately narrow: no
 * natural-language month parsing, NO LLM call. Returns null when nothing trivial
 * matches. Exported for unit testing.
 * @param {string} text
 * @returns {string | null}
 */
export function parseUntilDate(text) {
  const m = /\b(?:until|through|thru|expires?(?:\s+on)?|valid\s+until)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text || '');
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T23:59:59.999Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// Minimum message length worth spending any thought on.
const MIN_LENGTH = 20;

// Confidence gates.
const DECISION_MIN_CONFIDENCE = 0.7;
const CONTRADICTION_MIN_CONFIDENCE = 0.75;

// Cap the number of contradiction candidates handed to the judge.
const MAX_CANDIDATES = 50;

// Cap the number of decisions captured from a single message.
const MAX_CAPTURES_PER_MESSAGE = 5;

/**
 * Abuse blunting: max decisions captured per author per UTC day. A patient
 * abuser could otherwise seed junk "decisions" over hours/days, crowding the
 * 50-candidate contradiction window and the 60-decision audit. This is a soft
 * anti-pollution cap, NOT a correctness gate — it is set generously so it never
 * bites honest usage (a real person finalizes far fewer than 20 decisions a day).
 * Only CAPTURE is capped; a capped message is still judged against prior
 * decisions, so an abuser can never use the cap to hide their own contradictions.
 */
export const MAX_CAPTURES_PER_USER_PER_DAY = 20;

/**
 * Pure: how many of `wanted` fresh captures an author may still make today, given
 * they have already captured `alreadyToday`, under `cap`. Never negative, never
 * more than `wanted`. Exported so the cap decision is unit-testable without a
 * live ledger.
 * @param {number} alreadyToday captures already made by this author today
 * @param {number} wanted captures this message would otherwise make
 * @param {number} [cap]
 * @returns {number} how many to capture now (the rest are skipped)
 */
export function capturesAllowedToday(alreadyToday, wanted, cap = MAX_CAPTURES_PER_USER_PER_DAY) {
  const remaining = Math.max(0, cap - (Number(alreadyToday) || 0));
  return Math.min(Math.max(0, Number(wanted) || 0), remaining);
}

/**
 * Start of the current UTC day as an ISO-8601 timestamp — the lower bound for the
 * daily capture cap's count. Comparable lexicographically against stored
 * `created_at` values (also UTC ISO).
 * @param {number} [now] epoch ms
 * @returns {string}
 */
function utcDayStartIso(now = Date.now()) {
  return `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// Ambient LLM rate guard: bound how many LLM-triggering pipeline runs we perform
// over a rolling window, per-user AND globally, so a burst of messages (or one
// abusive user) can never drive unbounded LLM spend. When a limit is hit the
// offending message is skipped entirely (both capture and contradiction).
const RATE_WINDOW_MS = 60_000;
const RATE_PER_USER_MAX = 10;
const RATE_GLOBAL_MAX = 30;

/** Per-user sliding window of LLM-run timestamps (ms). @type {Map<string, number[]>} */
const userLlmHits = new Map();
/** Global sliding window of LLM-run timestamps (ms). @type {number[]} */
let globalLlmHits = [];

/**
 * Pure sliding-window rate check. Given prior hit timestamps (ms), the current
 * time, a window length, and a cap, prune entries older than the window and
 * report whether one more hit is allowed. Does NOT mutate the input array.
 * Exported so the bucket logic can be unit-tested without a live pipeline.
 * @param {number[]} timestamps
 * @param {number} now
 * @param {number} windowMs
 * @param {number} max
 * @returns {{allowed: boolean, recent: number[]}} recent is the pruned window.
 */
export function checkRateWindow(timestamps, now, windowMs, max) {
  const recent = (Array.isArray(timestamps) ? timestamps : []).filter((t) => now - t < windowMs);
  return { allowed: recent.length < max, recent };
}

/**
 * Check-and-record one LLM-triggering pipeline run for `userId` against both the
 * per-user and global rolling windows. Returns true if the run is allowed (and
 * records it); false if either limit is exceeded (records nothing).
 * @param {string} userId
 * @param {number} [now]
 * @returns {boolean}
 */
function allowLlmRun(userId, now = Date.now()) {
  const user = checkRateWindow(userLlmHits.get(userId) ?? [], now, RATE_WINDOW_MS, RATE_PER_USER_MAX);
  const global = checkRateWindow(globalLlmHits, now, RATE_WINDOW_MS, RATE_GLOBAL_MAX);
  if (!user.allowed || !global.allowed) {
    // Persist the pruned windows even on rejection so stale entries expire.
    userLlmHits.set(userId, user.recent);
    globalLlmHits = global.recent;
    return false;
  }
  user.recent.push(now);
  global.recent.push(now);
  userLlmHits.set(userId, user.recent);
  globalLlmHits = global.recent;
  return true;
}

/**
 * In-memory LRU of recently processed event ids (client_msg_id or ts). Slack
 * redelivers events; we must never process the same message twice.
 */
const DEDUP_MAX = 200;
/** @type {Set<string>} */
const processedIds = new Set();

/**
 * @param {string} id
 * @returns {boolean} true if this id was already processed (and should be skipped).
 */
function seenBefore(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > DEDUP_MAX) {
    // Evict oldest (insertion order).
    const oldest = processedIds.values().next().value;
    if (oldest !== undefined) processedIds.delete(oldest);
  }
  return false;
}

/**
 * In-memory guard against alerting the same (user, decision) more than once per
 * day, complementing the durable dismissal check.
 * @type {Set<string>}
 */
const alertedToday = new Set();

/** Hard cap on {@link alertedToday} entries, evicting oldest (insertion order). */
const ALERTED_MAX = 5000;

/** @param {string} userId @param {string} decisionId */
function alertKey(userId, decisionId) {
  return `${userId}:${decisionId}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Record that `key` has been alerted, keeping {@link alertedToday} self-pruning
 * and bounded WITHOUT changing alert semantics. Keys are
 * `${userId}:${decisionId}:${YYYY-MM-DD}`; on each add we drop every entry whose
 * date-suffix isn't today's (yesterday's guards are dead weight — a re-alert is
 * only ever suppressed within the same day), then cap total size, evicting oldest
 * (insertion order) like {@link seenBefore}'s processedIds. Pure over the module
 * Set; the pruning itself lives in {@link pruneAlerted} for unit testing.
 * @param {string} key
 * @returns {void}
 */
function recordAlerted(key) {
  pruneAlerted(alertedToday, key, new Date().toISOString().slice(0, 10));
}

/**
 * Pure helper mirroring {@link recordAlerted}'s pruning, over a caller-supplied
 * Set so the bound + stale-day eviction can be unit-tested without the module
 * singleton. Mutates and returns `set`: drops keys whose date-suffix != `today`,
 * adds `key`, then evicts oldest entries until size <= `cap`. Exported for tests.
 * @param {Set<string>} set
 * @param {string} key
 * @param {string} today YYYY-MM-DD suffix considered current
 * @param {number} [cap]
 * @returns {Set<string>}
 */
export function pruneAlerted(set, key, today, cap = ALERTED_MAX) {
  for (const k of set) {
    if (!k.endsWith(`:${today}`)) set.delete(k);
  }
  set.add(key);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  return set;
}

/**
 * Per-channel serialization: at most one LLM pipeline run per channel at a time.
 * @type {Map<string, Promise<void>>}
 */
const channelQueues = new Map();

/**
 * Per-channel count of jobs enqueued but not yet settled. Tracked alongside
 * {@link channelQueues} so a hot channel's backlog can be capped.
 * @type {Map<string, number>}
 */
const channelPending = new Map();

/**
 * Per-channel cap on the number of pending (queued-but-unsettled) jobs. A burst
 * of hundreds of messages in one channel would otherwise chain hundreds of
 * pending jobs, growing memory and making processing minutes-stale. Beyond the
 * cap, new jobs are dropped rather than enqueued.
 */
const QUEUE_CAP = 20;

/**
 * Pure cap predicate: is a channel already at/over its pending-job cap? Exported
 * so the drop logic can be unit-tested without a live pipeline.
 * @param {number} pending current pending-job count for the channel
 * @param {number} [cap]
 * @returns {boolean} true if a new job should be DROPPED (not enqueued).
 */
export function isQueueFull(pending, cap = QUEUE_CAP) {
  return (pending ?? 0) >= cap;
}

/**
 * Enqueue `job` behind any in-flight work for `channelId`, unless the channel is
 * already at its pending-job cap — in which case the job is DROPPED (not run) and
 * a resolved promise is returned.
 * @param {string} channelId
 * @param {() => Promise<void>} job
 * @param {{ info: (msg: string) => void }} [logger]
 * @returns {Promise<void>}
 */
function runQueued(channelId, job, logger) {
  const pending = channelPending.get(channelId) ?? 0;
  if (isQueueFull(pending)) {
    (logger?.info ?? console.info)(`[consensus] queue cap: dropping message for ${channelId} (${QUEUE_CAP} pending)`);
    return Promise.resolve();
  }
  channelPending.set(channelId, pending + 1);

  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(job, job);
  // Keep the chain alive but drop it once settled if it's the tail.
  channelQueues.set(channelId, next);
  next.finally(() => {
    const remaining = (channelPending.get(channelId) ?? 1) - 1;
    if (remaining <= 0) channelPending.delete(channelId);
    else channelPending.set(channelId, remaining);
    if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
  });
  return next;
}

/**
 * Strip fenced code blocks, inline code, and URLs, then collapse whitespace.
 * Used only for the length/keyword pre-filter — the LLM still sees raw text.
 * @param {string} text
 * @returns {string}
 */
function meaningfulText(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<@[^>]+>|<#[^>]+>/g, ' ')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Belt-and-braces: messages phrased as questions are never captured as
 * decisions even if the judge says so. Exported for unit testing.
 *
 * A trailing '?' is always a question. The interrogative-prefix heuristic is
 * deliberately NOT applied when the text contains a colon: a recap like
 * "What we decided: standardize on Postgres." opens with an interrogative word
 * but is a STATEMENT of a decision, and the colon reliably marks that shape —
 * firing the heuristic there suppressed real captures.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
  const t = (text || '').trim().toLowerCase();
  if (t.endsWith('?')) return true;
  if (t.includes(':')) return false;
  return /^(should|shall|do|does|can|could|would|are|is|what|why|when|where|how|who)\b.*\bwe\b/.test(t);
}

/**
 * Canonical key for reconciling statements across an edit: lowercase, collapse
 * internal whitespace, strip surrounding whitespace and trailing punctuation.
 * Mirrors the classifier's dedupe guard (judge.js `dedupKey`) so two phrasings
 * that the capture path treats as the SAME decision also reconcile as unchanged.
 * @param {string} statement
 * @returns {string}
 */
function normStatement(statement) {
  return String(statement ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?\s]+$/, '');
}

/**
 * Pure reconcile diff between the statements captured BEFORE an edit and the
 * statements classified AFTER it, compared under {@link normStatement}:
 *   - kept:    present in BOTH (returned from `before`, original casing)
 *   - retired: present in `before` but no longer in `after`
 *   - added:   newly present in `after`
 * Duplicate statements within a side are collapsed by normalized key. Safe
 * against non-array / non-string input (treated as empty).
 * @param {string[]} before
 * @param {string[]} after
 * @returns {{kept: string[], retired: string[], added: string[]}}
 */
export function diffStatements(before = [], after = []) {
  /** @type {Map<string, string>} */
  const beforeKeys = new Map();
  for (const s of Array.isArray(before) ? before : []) {
    const k = normStatement(s);
    if (k && !beforeKeys.has(k)) beforeKeys.set(k, s);
  }
  /** @type {Map<string, string>} */
  const afterKeys = new Map();
  for (const s of Array.isArray(after) ? after : []) {
    const k = normStatement(s);
    if (k && !afterKeys.has(k)) afterKeys.set(k, s);
  }
  /** @type {string[]} */ const kept = [];
  /** @type {string[]} */ const retired = [];
  /** @type {string[]} */ const added = [];
  for (const [k, s] of beforeKeys) {
    if (afterKeys.has(k)) kept.push(s);
    else retired.push(s);
  }
  for (const [k, s] of afterKeys) {
    if (!beforeKeys.has(k)) added.push(s);
  }
  return { kept, retired, added };
}

/**
 * Decision-adjacency heuristic. Cheap pre-filter (no LLM). We only spend LLM
 * budget on messages that look like they could STATE or finalize a decision, or
 * change a standing choice. Kept broad — the LLM judge does the precise work; a
 * false positive here just costs one classification call, a false negative here
 * silently drops a real decision. Tuned toward recall.
 */
const DECISION_KEYWORDS = [
  'deci', // decide / decided / decision / decisive
  'going with',
  'go with',
  "we'll",
  'we will',
  "let's use",
  'lets use',
  "let's go",
  'switch to',
  'switching to',
  'instead of',
  'standardiz', // standardize / standardise / standardizing
  'approved',
  'approve',
  'sign off',
  'signed off',
  'ship', // ship / shipping / shipped
  'deprecat', // deprecate / deprecated / deprecating
  'choose',
  'chose',
  'choosing',
  'pick', // pick / picked / picking
  'final', // final / finalize / finalized
  'agreed',
  'agree',
  'consensus',
  'freez', // freeze / freezing
  'frozen',
  'policy',
  'budget',
  'pricing',
  'price',
  'launch',
  'roll out',
  'rollout',
  'adopt',
  'moving to',
  'move to',
  'from now on',
  'settled',
  'locked in',
  'lock in',
  'default to',
  'no longer',
  'stop using',
  'switch', // switch / switching / switched (any construction)
  'mandat', // mandatory / mandate / mandated
  'requir', // require / required / requirement
  'must ',
  'now need',
  'sign-off', // hyphenated form of sign off
  'effective ', // "effective August 1"
  'starting ', // "starting next week"
  'going forward',
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function isDecisionAdjacent(text) {
  const lower = text.toLowerCase();
  return DECISION_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Map a ledger row into the shape the contradiction judge expects.
 * @param {import('./ledger.js').Decision} d
 * @returns {import('./judge.js').PriorDecision}
 */
function toPriorDecision(d) {
  return {
    id: d.id,
    statement: d.statement,
    rationale: d.rationale ?? undefined,
    channel: d.channel_name ?? undefined,
    decidedBy: d.decided_by ?? undefined,
    date: d.created_at,
  };
}

/**
 * Best-effort permalink lookup.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channel
 * @param {string} messageTs
 * @returns {Promise<string|null>}
 */
async function fetchPermalink(client, channel, messageTs) {
  try {
    const res = await client.chat.getPermalink({ channel, message_ts: messageTs });
    return res.permalink ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort channel metadata lookup (name + privacy). On API failure,
 * isPrivate is null (UNKNOWN) so the caller can fail closed.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channel
 * @returns {Promise<{name: string|null, isPrivate: boolean|null}>}
 */
async function fetchChannelInfo(client, channel) {
  try {
    const res = await client.conversations.info({ channel });
    const ch = /** @type {any} */ (res.channel) || {};
    return { name: 'name' in ch ? ch.name : null, isPrivate: ch.is_private === true };
  } catch {
    return { name: null, isPrivate: null };
  }
}

/**
 * Handle a single channel message end-to-end.
 * @param {{
 *   event: import('@slack/types').GenericMessageEvent,
 *   client: import('@slack/web-api').WebClient,
 *   logger: import('@slack/bolt').Logger
 * }} args
 * @returns {Promise<void>}
 */
export async function handleChannelMessage({ event, client, logger }) {
  const text = event.text || '';

  // (a) Cheap pre-filter FIRST — no LLM.
  if (event.bot_id) return;

  // Dedup: Slack redelivers events; never process the same message twice.
  const dedupId = /** @type {any} */ (event).client_msg_id || event.ts;
  if (seenBefore(dedupId)) {
    logger.info(`[consensus] dedup: skipping already-processed ${dedupId}`);
    return;
  }

  // Strip code blocks / URLs / mentions before length + keyword gating; a
  // message that is only emoji, links, or code carries no decision content.
  const stripped = meaningfulText(text);
  if (stripped.length < MIN_LENGTH) return;

  // NOTE: the decision-keyword pre-filter only gates decision CAPTURE below.
  // The contradiction check must NOT be keyword-gated: contradicting messages
  // often carry no decision language at all ("lets just spin up MongoDB…").
  const decisionAdjacent = isDecisionAdjacent(stripped);

  // Serialize per channel: at most one LLM pipeline run per channel at a time.
  await runQueued(event.channel, () => runPipeline({ event, client, logger, text, decisionAdjacent }), logger);
}

/**
 * The actual (serialized) pipeline body for one message.
 * @param {{
 *   event: import('@slack/types').GenericMessageEvent,
 *   client: import('@slack/web-api').WebClient,
 *   logger: import('@slack/bolt').Logger,
 *   text: string,
 *   decisionAdjacent: boolean
 * }} args
 * @returns {Promise<void>}
 */
async function runPipeline({ event, client, logger, text, decisionAdjacent }) {
  const channelId = event.channel;
  const messageTs = event.ts;
  const threadTs = event.thread_ts || event.ts;
  const startedAt = Date.now();

  try {
    // Ambient LLM rate guard. This run only spends LLM budget if it will either
    // classify (decisionAdjacent) or run the contradiction judge (there is at
    // least one active decision to check against). Gate BEFORE any LLM call; when
    // over the limit, skip the message entirely (capture AND contradiction) —
    // never crash. A cheap limit-1 ledger read tells us whether the judge path
    // would fire without paying for the full candidate query.
    const willUseLlm = decisionAdjacent || (await listDecisions({ status: ENFORCEABLE_STATUSES, limit: 1 })).length > 0;
    if (willUseLlm && !allowLlmRun(event.user || 'unknown')) {
      logger.info(`[consensus] rate guard: skipping LLM work for message from ${event.user || 'unknown'}`);
      return;
    }

    // (b) Does this message itself finalize one or more decisions? (keyword-gated)
    // A single message can carry SEVERAL decisions (meeting-notes dumps); each is
    // captured and gets its own card, all threaded under the source message.
    // Thread replies are only captured when clearly decisional — the keyword
    // gate already enforces that, so we simply follow decisionAdjacent.
    /** @type {string[]} */
    const capturedIds = [];
    /** @type {Array<{statement: string, rationale: string|null, confidence: number}>} */
    let classifications = [];
    if (decisionAdjacent) {
      const clsStart = Date.now();
      classifications = await classifyDecisions(text);
      logger.info(
        `[consensus] classifyDecisions took ${Date.now() - clsStart}ms → ${classifications.length} candidate decision(s)`,
      );
    }

    // Belt-and-braces: questions are never captured, even if the classifier says so.
    const isQuestion = looksLikeQuestion(text);
    if (classifications.length > 0 && isQuestion) {
      logger.info('[consensus] capture suppressed: message phrased as a question');
    }
    const toCapture = isQuestion
      ? []
      : classifications.filter((c) => c.confidence >= DECISION_MIN_CONFIDENCE).slice(0, MAX_CAPTURES_PER_MESSAGE);

    // Daily per-user capture cap (abuse blunting). Count this author's captures
    // so far today (UTC) and keep only as many of this message's decisions as
    // still fit under the cap; the rest are silently skipped (no card). This never
    // touches the contradiction path below — the message is still judged.
    const author = event.user || 'unknown';
    const captureAllowance = capturesAllowedToday(
      await countDecisionsByAuthorSince(author, utcDayStartIso()),
      toCapture.length,
    );
    if (captureAllowance < toCapture.length) {
      logger.info(`[consensus] capture cap: ${author} hit ${MAX_CAPTURES_PER_USER_PER_DAY}/day, skipping capture`);
    }
    const capped = toCapture.slice(0, captureAllowance);

    if (capped.length > 0) {
      const [permalink, channelInfo] = await Promise.all([
        fetchPermalink(client, channelId, messageTs),
        fetchChannelInfo(client, channelId),
      ]);
      // Fail closed: if channel privacy is UNKNOWN (API failure), treat it as
      // private so a decision is never leaked to non-members by mistake.
      if (channelInfo.isPrivate === null) {
        logger.info('[consensus] channel privacy unknown — treating as private (fail-closed)');
      }
      const isPrivate = channelInfo.isPrivate === false ? 0 : 1;

      // Governance gate: captures in a trusted channel become enforceable
      // ('active') immediately; captures anywhere else become 'proposed' (stored
      // and shown, but never hard-alerted until an authority confirms them).
      const captureStatus = captureStatusForChannel(channelId);
      // Best-effort, cheap expiry: an "until <ISO date>" in the message sets
      // expires_at. No LLM call; null when nothing trivial matches.
      const expiresAt = parseUntilDate(text);

      for (const c of capped) {
        const decision = await addDecision({
          // Cap the captured statement so an over-long (or padded) classification
          // can't bloat the ledger row or downstream renders.
          statement: (c.statement || text.slice(0, 280)).slice(0, 500),
          rationale: c.rationale,
          channel_id: channelId,
          channel_name: channelInfo.name,
          decided_by: event.user,
          message_ts: messageTs,
          permalink,
          confidence: c.confidence,
          is_private: isPrivate,
          status: captureStatus,
          owner_user_id: event.user,
          expires_at: expiresAt,
        });
        capturedIds.push(decision.id);
        await recordEvent('captured', decision.id);

        try {
          // One card per captured decision, all threaded under the source message
          // (they stack in-thread).
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `📌 Decision captured: ${decision.statement}`,
            blocks: decisionCard({
              statement: decision.statement,
              decidedBy: decision.decided_by,
              channelName: decision.channel_name,
              permalink: decision.permalink,
              id: decision.id,
              status: decision.status,
              ownerUserId: decision.owner_user_id,
              expiresAt: decision.expires_at,
            }),
          });
        } catch (e) {
          logger.error(`[consensus] failed to post decision card: ${e}`);
        }
      }

      if (capped.length > 1) {
        logger.info(`[consensus] captured ${capped.length} decision(s) from one message`);
      }
    }

    // (c) Independent contradiction check against prior ACTIVE decisions from
    // OTHER threads (never flag a message against its own thread's decision,
    // including the one we may have just captured above). Cap at the most
    // recent MAX_CANDIDATES to bound judge cost.
    // Only genuinely enforceable decisions (active/confirmed AND not past their
    // expires_at) are contradiction candidates. proposed/exception/superseded/
    // expired/rejected rows are never hard-alerted, so they never reach the judge.
    const now = Date.now();
    const candidates = (await listDecisions({ status: ENFORCEABLE_STATUSES, limit: MAX_CANDIDATES }))
      .filter(
        (d) =>
          isEnforceable(d, now) &&
          !capturedIds.includes(d.id) &&
          d.message_ts !== threadTs &&
          (d.channel_id !== channelId || d.message_ts !== messageTs),
      )
      .slice(0, MAX_CANDIDATES);

    if (candidates.length > 0) {
      // Optional Real-Time Search enrichment. The ambient pipeline only holds the
      // BOT client, whose token lacks the search:read.* scopes and would also need
      // an action_token — so this is gated behind CONSENSUS_RTS=1 and is fully
      // fail-open (searchContext returns [] on any error/timeout, and an empty
      // liveContext leaves judgeContradiction's behavior unchanged).
      /** @type {string[]} */
      let liveContext = [];
      if (process.env.CONSENSUS_RTS === '1') {
        const hits = await searchContext(client, { query: text, limit: 5, logger });
        liveContext = hits.map((h) => {
          const where = h.channel_name ? `#${h.channel_name}` : h.channel_id || 'unknown';
          return `[${where}] ${h.author_name || h.author_user_id || 'unknown'}: ${h.content}`;
        });
      }

      const judgeStart = Date.now();
      const verdict = await judgeContradiction(text, candidates.map(toPriorDecision), liveContext);
      logger.info(
        `[consensus] judgeContradiction took ${Date.now() - judgeStart}ms → isContradiction=${verdict.isContradiction} conf=${verdict.confidence}`,
      );

      if (
        verdict.isContradiction &&
        verdict.confidence >= CONTRADICTION_MIN_CONFIDENCE &&
        verdict.conflictingDecisionId
      ) {
        const decision = candidates.find((d) => d.id === verdict.conflictingDecisionId);
        const key = decision ? alertKey(event.user, decision.id) : '';
        // Per-user dismissal memory: only THIS author's own prior "not a conflict"
        // suppresses the re-alert (event.user is the alerted author).
        if (decision && !(await isKnownFalsePositive(text, decision.id, event.user)) && !alertedToday.has(key)) {
          // Permission boundary: never quote a private-channel decision to a
          // user who cannot see that channel.
          const visible = await canSeeDecision(client, decision, event.user, logger);
          try {
            if (visible) {
              await client.chat.postEphemeral({
                channel: channelId,
                user: event.user,
                text: '⚠️ Heads up — this may conflict with a team decision.',
                blocks: contradictionAlert({
                  newMessageText: text,
                  decision,
                  confidence: verdict.confidence,
                  reasoning: verdict.reasoning,
                }),
              });
            } else {
              await client.chat.postEphemeral({
                channel: channelId,
                user: event.user,
                text: '⚠️ This may conflict with a decision made in a private channel you don’t have access to. Ask an admin of that space.',
              });
            }
            // Only suppress future alerts for this (user, decision) once the
            // ephemeral post has actually succeeded. recordAlerted keeps the
            // in-memory Set self-pruning (drops non-today keys) and bounded.
            recordAlerted(key);
            await recordEvent('alert_fired', decision.id);
          } catch (e) {
            logger.error(`[consensus] failed to post contradiction alert: ${e}`);
          }
        }
      }
    }

    logger.info(`[consensus] handleChannelMessage total ${Date.now() - startedAt}ms`);
  } catch (e) {
    logger.error(`[consensus] pipeline error (non-fatal): ${e}`);
  }
}

/**
 * Handle an edit (`message_changed`) of a human-authored channel message: keep
 * the ledger in sync with the corrected text. Cheap when the edited message
 * never produced a decision (no prior captures → no LLM). Serialized behind the
 * same per-channel queue as fresh captures.
 * @param {{
 *   event: any,
 *   client: import('@slack/web-api').WebClient,
 *   logger: import('@slack/bolt').Logger
 * }} args
 * @returns {Promise<void>}
 */
export async function handleMessageEdited({ event, client, logger }) {
  const message = event.message || {};
  // Human-authored originals only (defense-in-depth; the listener also gates).
  if (message.bot_id || event.bot_id || !message.user) return;
  const channelId = event.channel;
  const originalTs = message.ts;
  if (!channelId || !originalTs) return;

  // Dedup redelivered edit events by (original ts, edit ts).
  const dedupId = `${originalTs}:edited:${message.edited?.ts || ''}`;
  if (seenBefore(dedupId)) {
    logger.info(`[consensus] dedup: skipping already-processed edit ${dedupId}`);
    return;
  }

  // Apply the same cap to edit sync: a channel this hot is already shedding
  // fresh captures, so consistency of behavior beats keeping the ledger in sync.
  await runQueued(channelId, () => runEditPipeline({ event, client, logger }), logger);
}

/**
 * Serialized body of the edit-sync pipeline for one message.
 * @param {{
 *   event: any,
 *   client: import('@slack/web-api').WebClient,
 *   logger: import('@slack/bolt').Logger
 * }} args
 * @returns {Promise<void>}
 */
async function runEditPipeline({ event, client, logger }) {
  const channelId = event.channel;
  const message = event.message || {};
  const originalTs = message.ts;
  const newText = message.text || '';
  const threadTs = message.thread_ts || originalTs;
  const startedAt = Date.now();

  try {
    // No captures from this message → nothing to reconcile. Cheapest exit, no LLM.
    const prior = await listDecisionsByMessage(channelId, originalTs);
    if (prior.length === 0) return;

    // A non-textual edit (e.g. Slack attaching a link unfurl) leaves the text
    // unchanged — reclassifying would waste an LLM call and change nothing.
    const prevText = event.previous_message?.text;
    if (typeof prevText === 'string' && prevText === newText) return;

    // Re-classify the NEW text with the same stripping + question guard the
    // capture path uses. If the edit stripped out all decision content, the
    // classifier returns nothing and every prior capture is retired.
    /** @type {Array<{statement: string, rationale: string|null, confidence: number}>} */
    let classifications = [];
    const stripped = meaningfulText(newText);
    if (stripped.length >= MIN_LENGTH) {
      const clsStart = Date.now();
      classifications = await classifyDecisions(newText);
      logger.info(
        `[consensus] edit re-classify took ${Date.now() - clsStart}ms → ${classifications.length} candidate(s)`,
      );
    }
    const isQuestion = looksLikeQuestion(newText);
    const toCapture = isQuestion
      ? []
      : classifications.filter((c) => c.confidence >= DECISION_MIN_CONFIDENCE).slice(0, MAX_CAPTURES_PER_MESSAGE);

    // Reconcile by normalized statement.
    const { retired, added } = diffStatements(
      prior.map((d) => d.statement),
      toCapture.map((c) => c.statement),
    );
    const retiredKeys = new Set(retired.map(normStatement));
    const addedKeys = new Set(added.map(normStatement));
    const toRetire = prior.filter((d) => retiredKeys.has(normStatement(d.statement)));
    const toAdd = toCapture.filter((c) => addedKeys.has(normStatement(c.statement)));

    // Retire decisions whose statements no longer appear in the edited message.
    // Retirement is NOT a capture, so it is never affected by the daily cap below.
    for (const d of toRetire) {
      await retireDecision(d.id, `source message edited (${message.edited?.ts || ''})`);
      await recordEvent('edited_sync', d.id);
    }

    // Daily per-user capture cap (abuse blunting), applied to edit-added decisions
    // too so an abuser can't launder captures through edits. Author is the
    // original message's author.
    const editAuthor = message.user || 'unknown';
    const addAllowance = capturesAllowedToday(
      await countDecisionsByAuthorSince(editAuthor, utcDayStartIso()),
      toAdd.length,
    );
    if (addAllowance < toAdd.length) {
      logger.info(`[consensus] capture cap: ${editAuthor} hit ${MAX_CAPTURES_PER_USER_PER_DAY}/day, skipping capture`);
    }
    const cappedAdd = toAdd.slice(0, addAllowance);

    // Add newly-introduced decisions (same caps/sanitization as capture) and
    // post a capture card in-thread for each.
    if (cappedAdd.length > 0) {
      const [permalink, channelInfo] = await Promise.all([
        fetchPermalink(client, channelId, originalTs),
        fetchChannelInfo(client, channelId),
      ]);
      if (channelInfo.isPrivate === null) {
        logger.info('[consensus] channel privacy unknown — treating as private (fail-closed)');
      }
      const isPrivate = channelInfo.isPrivate === false ? 0 : 1;
      // Same governance gate as fresh capture (see runPipeline).
      const captureStatus = captureStatusForChannel(channelId);
      const expiresAt = parseUntilDate(newText);

      for (const c of cappedAdd) {
        const decision = await addDecision({
          statement: (c.statement || newText.slice(0, 280)).slice(0, 500),
          rationale: c.rationale,
          channel_id: channelId,
          channel_name: channelInfo.name,
          decided_by: message.user,
          message_ts: originalTs,
          permalink,
          confidence: c.confidence,
          is_private: isPrivate,
          status: captureStatus,
          owner_user_id: message.user,
          expires_at: expiresAt,
        });
        await recordEvent('captured', decision.id);
        try {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `📌 Decision captured: ${decision.statement}`,
            blocks: decisionCard({
              statement: decision.statement,
              decidedBy: decision.decided_by,
              channelName: decision.channel_name,
              permalink: decision.permalink,
              id: decision.id,
              status: decision.status,
              ownerUserId: decision.owner_user_id,
              expiresAt: decision.expires_at,
            }),
          });
        } catch (e) {
          logger.error(`[consensus] failed to post edit-added decision card: ${e}`);
        }
      }
    }

    // One compact thread note, only when something actually changed. Counts
    // reflect what was actually applied (added = post-cap).
    if (toRetire.length + cappedAdd.length > 0) {
      const keptCount = prior.length - toRetire.length;
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: originalTs,
          text: `✏️ Message edited — ledger synced: ${keptCount} kept, ${toRetire.length} retired, ${cappedAdd.length} added.`,
        });
      } catch (e) {
        logger.error(`[consensus] failed to post edit-sync note: ${e}`);
      }
    }

    logger.info(
      `[consensus] handleMessageEdited total ${Date.now() - startedAt}ms → ${prior.length - toRetire.length} kept, ${toRetire.length} retired, ${cappedAdd.length} added`,
    );
  } catch (e) {
    logger.error(`[consensus] edit-sync error (non-fatal): ${e}`);
  }
}

/**
 * Handle a delete (`message_deleted`) of a channel message: retire every
 * decision that was captured from it. Silent — the source message is gone, so
 * there is nothing to post and no LLM to call. Serialized behind the per-channel
 * queue so it can't race a concurrent capture/edit for the same channel.
 * @param {{
 *   event: any,
 *   logger: import('@slack/bolt').Logger
 * }} args
 * @returns {Promise<void>}
 */
export async function handleMessageDeleted({ event, logger }) {
  const channelId = event.channel;
  const deletedTs = event.deleted_ts;
  if (!channelId || !deletedTs) return;

  // Dedup redelivered delete events.
  const dedupId = `${deletedTs}:deleted`;
  if (seenBefore(dedupId)) {
    logger.info(`[consensus] dedup: skipping already-processed delete ${dedupId}`);
    return;
  }

  // Same cap applies to delete sync (see edit-sync note): a shedding channel
  // stays consistent rather than special-casing the ledger-honesty jobs.
  await runQueued(
    channelId,
    async () => {
      try {
        const prior = await listDecisionsByMessage(channelId, deletedTs);
        if (prior.length === 0) return;
        for (const d of prior) {
          await retireDecision(d.id, 'source message deleted');
          await recordEvent('deleted_sync', d.id);
        }
        logger.info(`[consensus] source deleted — retired ${prior.length} decision(s)`);
      } catch (e) {
        logger.error(`[consensus] delete-sync error (non-fatal): ${e}`);
      }
    },
    logger,
  );
}
