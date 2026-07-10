import { handleChannelMessage } from '../../consensus-core/pipeline.js';

// Subtypes we explicitly ignore: edits, deletes, joins/leaves, bot posts, etc.
// Anything with no subtype is normal text; `thread_broadcast` (a reply also sent
// to the channel) is likewise treated as normal decisional text.
const IGNORED_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'bot_message',
  'thread_broadcast_deleted',
]);

/**
 * Is this a message event we should feed to the Consensus pipeline as text?
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isProcessableMessage(event) {
  const subtype = 'subtype' in event ? event.subtype : undefined;
  if (subtype === undefined) return true;
  if (subtype === 'thread_broadcast') return true;
  return !IGNORED_SUBTYPES.has(subtype);
}

/**
 * Ambient Consensus listener on channel/group messages. This is INDEPENDENT of
 * the chat-agent `handleMessage` listener: that one owns DMs and engaged-thread
 * replies for conversation; this one only reads public/private *channel* traffic
 * to detect decisions and contradictions, and never replies conversationally.
 *
 * We return early for everything we don't own (DMs, bot messages, subtypes) so
 * the two `message` listeners don't collide.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleChannelMessageEvent({ client, event, logger }) {
  // Only real, human channel/group messages (edits/deletes/joins ignored).
  if (!isProcessableMessage(event)) return;
  if (event.bot_id) return;
  if (event.channel_type !== 'channel' && event.channel_type !== 'group') return;
  if (!event.user) return;

  await handleChannelMessage({ event, client, logger });
}
