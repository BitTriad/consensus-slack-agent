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
import { classifyDecision, judgeContradiction } from './judge.js';
import { addDecision, isKnownFalsePositive, listDecisions, recordEvent } from './ledger.js';
import { canSeeDecision } from './permissions.js';
import { searchContext } from './rts.js';

// Minimum message length worth spending any thought on.
const MIN_LENGTH = 20;

// Confidence gates.
const DECISION_MIN_CONFIDENCE = 0.7;
const CONTRADICTION_MIN_CONFIDENCE = 0.75;

// Cap the number of contradiction candidates handed to the judge.
const MAX_CANDIDATES = 15;

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

/** @param {string} userId @param {string} decisionId */
function alertKey(userId, decisionId) {
  return `${userId}:${decisionId}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Per-channel serialization: at most one LLM pipeline run per channel at a time.
 * @type {Map<string, Promise<void>>}
 */
const channelQueues = new Map();

/**
 * Enqueue `job` behind any in-flight work for `channelId`.
 * @param {string} channelId
 * @param {() => Promise<void>} job
 * @returns {Promise<void>}
 */
function runQueued(channelId, job) {
  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(job, job);
  // Keep the chain alive but drop it once settled if it's the tail.
  channelQueues.set(channelId, next);
  next.finally(() => {
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
 * decisions even if the judge says so.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeQuestion(text) {
  const t = (text || '').trim().toLowerCase();
  if (t.endsWith('?')) return true;
  return /^(should|shall|do|does|can|could|would|are|is|what|why|when|where|how|who)\b.*\bwe\b/.test(t);
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
  await runQueued(event.channel, () => runPipeline({ event, client, logger, text, decisionAdjacent }));
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
    // (b) Is this message itself a finalized decision? (keyword-gated)
    // Thread replies are only captured when clearly decisional — the keyword
    // gate already enforces that, so we simply follow decisionAdjacent.
    let capturedId = null;
    /** @type {{isDecision: boolean, statement: string|null, rationale: string|null, confidence: number}} */
    let classification = { isDecision: false, statement: null, rationale: null, confidence: 0 };
    if (decisionAdjacent) {
      const clsStart = Date.now();
      classification = await classifyDecision(text);
      logger.info(
        `[consensus] classifyDecision took ${Date.now() - clsStart}ms → isDecision=${classification.isDecision} conf=${classification.confidence}`,
      );
    }

    // Belt-and-braces: questions are never captured, even if the judge says so.
    const captureOk =
      classification.isDecision && classification.confidence >= DECISION_MIN_CONFIDENCE && !looksLikeQuestion(text);
    if (classification.isDecision && looksLikeQuestion(text)) {
      logger.info('[consensus] capture suppressed: message phrased as a question');
    }

    if (captureOk) {
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
      const decision = addDecision({
        // Cap the captured statement so an over-long (or padded) classification
        // can't bloat the ledger row or downstream renders.
        statement: (classification.statement || text.slice(0, 280)).slice(0, 500),
        rationale: classification.rationale,
        channel_id: channelId,
        channel_name: channelInfo.name,
        decided_by: event.user,
        message_ts: messageTs,
        permalink,
        confidence: classification.confidence,
        is_private: isPrivate,
      });
      capturedId = decision.id;
      recordEvent('captured', decision.id);

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
          }),
        });
      } catch (e) {
        logger.error(`[consensus] failed to post decision card: ${e}`);
      }
    }

    // (c) Independent contradiction check against prior ACTIVE decisions from
    // OTHER threads (never flag a message against its own thread's decision,
    // including the one we may have just captured above). Cap at the most
    // recent MAX_CANDIDATES to bound judge cost.
    const candidates = listDecisions({ status: 'active', limit: 30 })
      .filter(
        (d) =>
          d.id !== capturedId &&
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
        if (decision && !isKnownFalsePositive(text, decision.id) && !alertedToday.has(key)) {
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
            // ephemeral post has actually succeeded.
            alertedToday.add(key);
            recordEvent('alert_fired', decision.id);
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
