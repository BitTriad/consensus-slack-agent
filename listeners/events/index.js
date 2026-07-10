import { handleAppHomeOpened } from './app-home-opened.js';
import { handleAppMentioned } from './app-mentioned.js';
import { handleChannelMessageEvent } from './channel-message.js';
import { handleMemberJoinedChannel } from './member-joined.js';
import { handleMessage } from './message.js';

/**
 * Register event listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.event('app_home_opened', handleAppHomeOpened);
  app.event('app_mention', handleAppMentioned);
  app.event('member_joined_channel', handleMemberJoinedChannel);
  // Two independent 'message' listeners. Bolt dispatches the event to both; each
  // returns early for cases it doesn't own, so there is no double-handling:
  //   - handleMessage: DMs + engaged-thread replies (chat agent, replies).
  //   - handleChannelMessageEvent: channel/group traffic (Consensus, read-only).
  app.event('message', handleMessage);
  app.event('message', handleChannelMessageEvent);
}
