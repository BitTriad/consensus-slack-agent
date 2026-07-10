/**
 * When Consensus itself is added to a channel, post a one-time, friendly intro
 * so newcomers understand what the ambient bot does and how to opt out.
 */

// Channels we've already greeted this process — avoids re-introducing on
// duplicate/redelivered join events.
/** @type {Set<string>} */
const introduced = new Set();

const INTRO_TEXT =
  "👋 I'm Consensus — I quietly track team decisions made here and warn about contradictions. " +
  'Opt-out anytime by removing me.';

/**
 * Handle member_joined_channel. Only acts when the joining member is the bot.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'member_joined_channel'>} args
 * @returns {Promise<void>}
 */
export async function handleMemberJoinedChannel({ client, event, context, logger }) {
  try {
    const botUserId = context.botUserId;
    if (!botUserId || event.user !== botUserId) return;
    if (introduced.has(event.channel)) return;
    introduced.add(event.channel);

    await client.chat.postMessage({ channel: event.channel, text: INTRO_TEXT });
    logger.info(`[consensus] posted intro in ${event.channel}`);
  } catch (e) {
    logger.error(`[consensus] failed to post intro (non-fatal): ${e}`);
  }
}
