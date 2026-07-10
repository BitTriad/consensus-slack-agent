/**
 * RTS feasibility probe — calls `assistant.search.context` directly and prints
 * the raw outcome so we can confirm which token/scopes actually work.
 *
 * The env vars are normally injected by `slack run`; this standalone probe reads
 * a token from the environment. Run it with an explicit token:
 *
 *   # Preferred: user token (xoxp) — has the search:read.* scopes, no action_token needed
 *   SLACK_USER_TOKEN=xoxp-... node consensus-core/rts-probe.js "Postgres decision"
 *
 *   # Or the bot token (xoxb) — EXPECTED to fail with missing_scope on our manifest
 *   SLACK_BOT_TOKEN=xoxb-... node consensus-core/rts-probe.js "Postgres decision"
 *
 * It prints ok/error and (on success) the first few normalized hits. A clean
 * `missing_scope` / `invalid_auth` / `not_allowed_token_type` error here is a
 * successful, informative probe — not a crash.
 */

import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { searchContext } from './rts.js';

const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
const query = process.argv[2] || 'Postgres decision';

if (!token) {
  console.error(
    'No token found. Set SLACK_USER_TOKEN (preferred, xoxp) or SLACK_BOT_TOKEN (xoxb) in the env.\n' +
      'Example: SLACK_USER_TOKEN=xoxp-... node consensus-core/rts-probe.js "Postgres decision"',
  );
  process.exit(2);
}

const tokenKind = token.startsWith('xoxp') ? 'user (xoxp)' : token.startsWith('xoxb') ? 'bot (xoxb)' : 'unknown';
console.log(`[probe] token kind: ${tokenKind}`);
console.log(`[probe] query: ${JSON.stringify(query)}`);

const client = new WebClient(token);

// First: a raw apiCall so we see the exact API error (searchContext fails open).
try {
  const raw = await client.apiCall('assistant.search.context', {
    query,
    content_types: 'messages',
    limit: 5,
    channel_types: 'public_channel,private_channel,mpim,im',
  });
  console.log('[probe] raw ok:', raw.ok);
  console.log('[probe] raw response keys:', Object.keys(raw));
} catch (e) {
  const err = /** @type {any} */ (e);
  console.log('[probe] raw apiCall threw — exact error:', err?.data?.error || err?.message || String(err));
  if (err?.data) console.log('[probe] raw error payload:', JSON.stringify(err.data));
}

// Then: through our fail-open wrapper (what production uses).
const hits = await searchContext(client, {
  query,
  channelTypes: 'public_channel,private_channel,mpim,im',
  limit: 5,
});
console.log(`[probe] searchContext returned ${hits.length} hit(s):`);
for (const h of hits.slice(0, 5)) {
  console.log(
    `  • [${h.channel_name || h.channel_id}] ${h.author_name || h.author_user_id}: ${h.content.slice(0, 100)}`,
  );
}
