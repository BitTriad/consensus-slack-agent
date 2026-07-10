/**
 * Permission-boundary gate for Consensus.
 *
 * Decisions captured in PRIVATE channels must never be quoted to a user who is
 * not a member of that channel. This module answers "is user U a member of
 * channel C?" against the Slack API, with a short in-memory cache so the
 * ambient pipeline doesn't hammer conversations.members on every message.
 */

// channelId -> { members: Set<string>, expires: number (ms epoch) }
/** @type {Map<string, {members: Set<string>, expires: number}>} */
const membershipCache = new Map();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the membership cache. Test-only hook.
 * @returns {void}
 */
export function _resetMembershipCache() {
  membershipCache.clear();
}

/**
 * Fetch (and cache) the member id set for a channel. Reads only the first page
 * of conversations.members — sufficient for workspace-scale channels in this
 * deployment. Any API failure yields an empty set (fail-closed: unknown → not a
 * member → redact), never throws.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {import('@slack/bolt').Logger} [logger]
 * @returns {Promise<Set<string>>}
 */
async function getMembers(client, channelId, logger) {
  const cached = membershipCache.get(channelId);
  if (cached && cached.expires > Date.now()) return cached.members;

  const members = new Set();
  try {
    const res = await client.conversations.members({ channel: channelId, limit: 200 });
    for (const m of res.members || []) members.add(m);
  } catch (e) {
    logger?.error(`[consensus] permission-gate: conversations.members failed for ${channelId}: ${e}`);
    // Fail closed but do NOT cache the empty/failed result, so a transient
    // error doesn't lock a real member out for the full TTL.
    return members;
  }
  membershipCache.set(channelId, { members, expires: Date.now() + CACHE_TTL_MS });
  return members;
}

/**
 * Whether user `userId` can see channel `channelId` (i.e. is a member).
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {string} userId
 * @param {import('@slack/bolt').Logger} [logger]
 * @returns {Promise<boolean>}
 */
export async function isChannelMember(client, channelId, userId, logger) {
  if (!channelId || !userId) return false;
  const members = await getMembers(client, channelId, logger);
  return members.has(userId);
}

/**
 * Gate a decision for a given viewer: may this user see the full decision, or
 * must it be redacted? Public-channel decisions are always visible.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {import('./ledger.js').Decision} decision
 * @param {string} userId
 * @param {import('@slack/bolt').Logger} [logger]
 * @returns {Promise<boolean>} true if the user may see the decision.
 */
export async function canSeeDecision(client, decision, userId, logger) {
  if (!decision.is_private) return true;
  const ok = await isChannelMember(client, decision.channel_id, userId, logger);
  if (!ok) {
    logger?.info(`[consensus] permission-gate: redacted decision ${decision.id} for user ${userId}`);
  }
  return ok;
}
