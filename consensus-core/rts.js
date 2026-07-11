/**
 * Slack Real-Time Search (RTS) wrapper — `assistant.search.context`.
 *
 * WHAT / WHY
 * ----------
 * RTS lets Consensus pull LIVE, permission-aware workspace context (messages,
 * files) at query time instead of relying only on our own decision ledger. It is
 * wired into two places (see agent/agent.js `lookup_decisions` and
 * consensus-core/pipeline.js): decision lookups are augmented with live search
 * hits, and contradiction judging is fed related live snippets.
 *
 * TOKEN / SCOPE CONSTRAINTS (verified against the API reference)
 * -------------------------------------------------------------
 *   • The method is NOT surfaced as a typed helper by @slack/web-api — that SDK
 *     only exposes `client.assistant.threads.*`. We therefore invoke it through
 *     the generic `client.apiCall('assistant.search.context', …)` escape hatch.
 *   • USER token (xoxp): needs search:read.public/.private/.mpim/.im/.files/.users.
 *     Our manifest grants all of these to the user token, so RTS is FEASIBLE with
 *     a user token and NO action_token is required. This is the load-bearing path
 *     (the requesting user's own token, available as `context.userToken`).
 *   • BOT token (xoxb): would need search:read.public/.files/.users AND an
 *     `action_token` that Slack only issues inside an assistant-thread
 *     interaction. Our bot token has NONE of the search scopes, so a bot-token
 *     call fails with `missing_scope` (and, even with scopes, would need
 *     action_token). The ambient pipeline only has the bot client, so RTS there
 *     is expected to fail-open — which is exactly what this wrapper does.
 *
 * Everything here is fail-open: any error, missing token, or >timeout → `[]`.
 * The app must behave identically when RTS is unavailable.
 */

/** Default per-call timeout. RTS must never stall the pipeline. */
const RTS_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} RtsResult
 * @property {'live search'} source     Provenance label for merged rendering.
 * @property {string} content           Message text.
 * @property {string|null} author_name
 * @property {string|null} author_user_id
 * @property {string|null} channel_id
 * @property {string|null} channel_name
 * @property {string|null} message_ts
 * @property {string|null} permalink
 * @property {boolean} is_author_bot
 */

/**
 * Race a promise against a timeout. On timeout the returned promise rejects.
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rts timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Call `assistant.search.context` and return a normalized, defensively-parsed
 * list of message hits. Never throws; returns `[]` on any failure.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {Object} opts
 * @param {string} opts.query                        Natural-language or keyword query.
 * @param {string} [opts.channelTypes]               Comma list: public_channel,private_channel,mpim,im.
 * @param {number} [opts.limit=5]                    Max results.
 * @param {string} [opts.token]                      Override token (pass the USER token here).
 * @param {string} [opts.contentTypes='messages']   Comma list: messages,files,channels,users.
 * @param {import('@slack/bolt').Logger} [opts.logger]
 * @returns {Promise<RtsResult[]>}
 */
export async function searchContext(
  client,
  { query, channelTypes, limit = 5, token, contentTypes = 'messages', logger } = /** @type {any} */ ({}),
) {
  const log = logger || console;
  const q = (query || '').trim();
  if (!q) return [];

  /** @type {Record<string, unknown>} */
  const args = {
    query: q,
    content_types: contentTypes,
    limit,
  };
  if (channelTypes) args.channel_types = channelTypes;
  // Passing token in the options overrides the client's default token, letting
  // the caller supply the requesting user's xoxp token for a permission-aware
  // search even though `client` was constructed with the bot token.
  if (token) args.token = token;

  const started = Date.now();
  try {
    const res = /** @type {any} */ (
      await withTimeout(client.apiCall('assistant.search.context', args), RTS_TIMEOUT_MS)
    );
    if (res?.ok !== true) {
      log.info?.(`[consensus] rts: non-ok response (${res?.error || 'unknown'}) in ${Date.now() - started}ms`);
      return [];
    }
    const messages = res.results?.messages;
    if (!Array.isArray(messages)) {
      log.info?.(`[consensus] rts: no messages in response (${Date.now() - started}ms)`);
      return [];
    }
    /** @type {RtsResult[]} */
    const out = messages.map((m) => ({
      source: /** @type {'live search'} */ ('live search'),
      content: typeof m?.content === 'string' ? m.content : '',
      author_name: m?.author_name ?? null,
      author_user_id: m?.author_user_id ?? null,
      channel_id: m?.channel_id ?? null,
      channel_name: m?.channel_name ?? null,
      message_ts: m?.message_ts ?? null,
      permalink: m?.permalink ?? null,
      is_author_bot: m?.is_author_bot === true,
    }));
    log.info?.(`[consensus] rts: ${out.length} hit(s) for "${q.slice(0, 60)}" in ${Date.now() - started}ms`);
    return out;
  } catch (e) {
    const err = /** @type {any} */ (e);
    log.info?.(
      `[consensus] rts: error (${err?.data?.error || err?.message || err}) in ${Date.now() - started}ms — failing open`,
    );
    return [];
  }
}
