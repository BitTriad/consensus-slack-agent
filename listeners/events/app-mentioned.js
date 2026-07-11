import { runAgent } from '../../agent/index.js';
import {
  composeAuditMessage,
  releaseAudit,
  runAuditForViewer,
  tryAcquireAudit,
} from '../../consensus-core/audit-report.js';
import { getStoredUserToken } from '../../consensus-core/user-token.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * Handle app_mention events and run the agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);
    // Sessions are per-(channel, thread, user) so users never share model memory.
    const sessionKey = `${threadTs}:${userId}`;

    // Strip the bot mention from the text
    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!cleanedText) {
      await say({
        text: "Hey there! How can I help you? Ask me anything and I'll do my best.",
        thread_ts: threadTs,
      });
      return;
    }

    // Consistency-audit trigger: "@Consensus audit" runs the whole-ledger latent
    // conflict scan (permission-gated per viewer) in-thread, instead of the chat
    // agent. Kept BEFORE runAgent so it short-circuits the normal path.
    if (/\baudit\b/i.test(cleanedText)) {
      // Metering: refuse to launch a fresh audit if one is running or ran within
      // the cooldown. The check-and-set is synchronous (single-threaded JS), so
      // two near-simultaneous triggers can never both acquire.
      if (!tryAcquireAudit()) {
        await say({
          text: '⏳ An audit just ran / is still running — try again in a minute.',
          thread_ts: threadTs,
        });
        return;
      }
      try {
        await setStatus({ status: 'Auditing the decision ledger…' });
        // publicOnly: this report is posted into a public thread everyone can
        // read, so a pair is only shown when BOTH decisions are public.
        const report = await runAuditForViewer({ client, userId, logger }, { publicOnly: true });
        const message = composeAuditMessage(report);
        await say({ ...message, thread_ts: threadTs });
      } finally {
        releaseAudit();
      }
      return;
    }

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking\u2026',
      loading_messages: [
        'Teaching the hamsters to type faster\u2026',
        'Untangling the internet cables\u2026',
        'Consulting the office goldfish\u2026',
        'Polishing up the response just for you\u2026',
        'Convincing the AI to stop overthinking\u2026',
      ],
    });

    // Get session ID for conversation context
    const existingSessionId = sessionStore.getSession(channelId, sessionKey);

    // Run the agent with deps for tool access
    const deps = {
      client,
      userId,
      channelId,
      threadTs,
      messageTs: event.ts,
      userToken: context.userToken || getStoredUserToken(userId) || undefined,
      // @mention answers post into the channel thread, readable by everyone —
      // restrict decision provenance to public decisions (fail closed).
      audience: /** @type {'dm'|'channel'} */ ('channel'),
    };
    const { responseText, sessionId: newSessionId } = await runAgent(cleanedText, existingSessionId ?? undefined, deps);

    // Stream response in thread with feedback buttons
    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    const feedbackBlocks = buildFeedbackBlocks();
    await streamer.stop({ blocks: feedbackBlocks });

    // Store session ID for future context
    if (newSessionId) {
      sessionStore.setSession(channelId, sessionKey, newSessionId);
    }
  } catch (e) {
    logger.error(`Failed to handle app mention: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
