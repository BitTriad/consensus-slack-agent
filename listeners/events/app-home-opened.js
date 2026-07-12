import { getLastAudit } from '../../consensus-core/audit.js';
import { homeView } from '../../consensus-core/blocks.js';
import { listDecisions, stats } from '../../consensus-core/ledger.js';
import { canSeeDecision } from '../../consensus-core/permissions.js';

const SUGGESTED_PROMPTS = [
  { title: 'What have we decided about databases?', message: 'What have we decided about databases?' },
  { title: 'Why did we choose our support SLA?', message: 'Why did we choose our support SLA?' },
  { title: 'Show me all active decisions', message: 'Show me all active decisions' },
];

/**
 * Handle app_home_opened events. Under agent_view, this event fires for both
 * the Home tab and the Messages tab (the agent DM). Branch on event.tab:
 *   - 'messages' → pin suggested prompts to the top of the DM
 *   - 'home'     → publish the App Home Block Kit view
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_home_opened'>} args
 * @returns {Promise<void>}
 */
export async function handleAppHomeOpened({ client, event, context, logger }) {
  try {
    if (event.tab === 'messages') {
      await client.assistant.threads.setSuggestedPrompts(
        // Under agent_view, suggested prompts pin to the top of the Messages tab —
        // no thread_ts is required. Cast until @slack/bolt's types catch up.
        /** @type {import('@slack/web-api').AssistantThreadsSetSuggestedPromptsArguments} */ ({
          channel_id: event.channel,
          title: 'How can I help you today?',
          prompts: SUGGESTED_PROMPTS,
        }),
      );
      // TODO(agent-dm-messages-tab): handle app_context_changed once Bolt supports it
      return;
    }

    const userId = /** @type {string} */ (context.userId);

    // Permission boundary: never render a private-channel decision to a viewer
    // who is not a member of that channel. canSeeDecision short-circuits for
    // public decisions, so only the is_private rows pay the membership check.
    const viewer = /** @type {string} */ (event.user);
    // Fetch a wider window (50) and permission-filter BEFORE trimming to 15, so
    // private rows the viewer can't see don't crowd out visible ones in the log.
    const all = await listDecisions({ status: undefined, limit: 50 });
    const visible = [];
    for (const d of all) {
      if (await canSeeDecision(client, d, viewer, logger)) visible.push(d);
      if (visible.length >= 15) break;
    }

    // Render the Consensus dashboard from live ledger data.
    const view = homeView({ stats: await stats(), decisions: visible, lastAudit: getLastAudit() });
    await client.views.publish({ user_id: userId, view });
  } catch (e) {
    logger.error(`Failed to handle app_home_opened: ${e}`);
  }
}
