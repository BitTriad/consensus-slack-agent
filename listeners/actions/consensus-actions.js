import {
  composeAuditMessage,
  releaseAudit,
  runAuditForViewer,
  tryAcquireAudit,
} from '../../consensus-core/audit-report.js';
import {
  dismissDecision,
  getDecision,
  listDecisions,
  recordAuditDismissal,
  recordDismissal,
  recordEvent,
  supersede,
} from '../../consensus-core/ledger.js';

/**
 * Safely read the string `value` from an interactive action payload.
 * @param {any} body
 * @returns {string}
 */
function actionValue(body) {
  return body?.actions?.[0]?.value ?? '';
}

/**
 * "Not a conflict" on a contradiction alert → learn the false positive and
 * retract the ephemeral warning.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleDismiss({ ack, body, respond, logger }) {
  await ack();
  try {
    const raw = actionValue(body);
    /** @type {{decisionId?: string, text?: string}} */
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { decisionId: raw };
    }
    // Record the dismissal against the OFFENDING user message (carried in the
    // button value), not the alert's own rendered text — otherwise
    // isKnownFalsePositive would never match and the alert would re-fire.
    const messageText = parsed.text || '';
    if (parsed.decisionId) {
      recordDismissal(messageText, parsed.decisionId);
      recordEvent('dismissed', parsed.decisionId);
    }
    await respond({
      replace_original: true,
      text: '👍 Noted — I won’t flag this again.',
    });
  } catch (e) {
    logger.error(`[consensus] handleDismiss failed: ${e}`);
  }
}

/**
 * "This is intentional — supersede" on a contradiction alert → mark the prior
 * decision superseded and confirm.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleConfirmSupersede({ ack, body, respond, logger }) {
  await ack();
  try {
    const decisionId = actionValue(body);
    if (decisionId) {
      supersede(decisionId, null);
      recordEvent('superseded', decisionId);
    }
    await respond({
      replace_original: true,
      text: '✅ Got it — I’ve marked the earlier decision as *superseded*. This is the current call now.',
    });
  } catch (e) {
    logger.error(`[consensus] handleConfirmSupersede failed: ${e}`);
  }
}

/**
 * "Show reasoning" on a contradiction alert → reveal the judge's reasoning
 * (ephemeral, non-destructive).
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleReasoning({ ack, body, respond, logger }) {
  await ack();
  try {
    const reasoning = actionValue(body) || 'No reasoning was recorded.';
    await respond({
      replace_original: false,
      response_type: 'ephemeral',
      text: `🧠 *Why I flagged this:*\n> ${reasoning}`,
    });
  } catch (e) {
    logger.error(`[consensus] handleReasoning failed: ${e}`);
  }
}

/**
 * "Mark superseded" on a decision-capture card → supersede + edit the card.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleCardSupersede({ ack, body, respond, logger }) {
  await ack();
  try {
    const id = actionValue(body);
    const decision = id ? getDecision(id) : null;
    if (id) supersede(id, null);
    await respond({
      replace_original: true,
      text: `🔁 Decision marked *superseded*${decision ? `: ${decision.statement}` : ''}.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔁 *Superseded*${decision ? ` — ~${decision.statement}~` : ''}\nI’ll no longer treat this as the active decision.`,
          },
        },
      ],
    });
  } catch (e) {
    logger.error(`[consensus] handleCardSupersede failed: ${e}`);
  }
}

/**
 * "🔎 Run consistency audit" (App Home) → audit the whole active ledger for
 * latent decision-vs-decision conflicts and DM the requesting user the result.
 *
 * App Home actions carry no channel, so we post to the user's DM (channel = user
 * id): first an acknowledgement, then the permission-gated report.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleRunAudit({ ack, body, client, logger }) {
  await ack();
  try {
    const userId = /** @type {any} */ (body).user?.id;
    if (!userId) return;
    // Metering: one audit at a time, with a cooldown between runs. The App Home
    // DM path keeps its per-viewer permission behavior (no publicOnly).
    if (!tryAcquireAudit()) {
      await client.chat.postMessage({
        channel: userId,
        text: '⏳ An audit just ran / is still running — try again in a minute.',
      });
      return;
    }
    try {
      const activeCount = listDecisions({ status: 'active', limit: 60 }).length;
      await client.chat.postMessage({
        channel: userId,
        text: `🔎 Auditing ${activeCount} active decision${activeCount === 1 ? '' : 's'} for latent conflicts…`,
      });

      const report = await runAuditForViewer({ client, userId, logger });
      const message = composeAuditMessage(report);
      await client.chat.postMessage({ channel: userId, ...message });
    } finally {
      releaseAudit();
    }
  } catch (e) {
    logger.error(`[consensus] handleRunAudit failed: ${e}`);
  }
}

/**
 * "Supersede first"/"Supersede second" on an audit conflict card → mark the
 * chosen decision superseded and confirm (without destroying the rest of the report).
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleAuditSupersede({ ack, body, respond, logger }) {
  await ack();
  try {
    const id = actionValue(body);
    const decision = id ? getDecision(id) : null;
    if (id) {
      supersede(id, null);
      recordEvent('superseded', id);
    }
    await respond({
      replace_original: false,
      response_type: 'ephemeral',
      text: `✅ Marked *superseded*${decision ? `: ${decision.statement}` : ''}. That resolves the conflict — re-run the audit to confirm.`,
    });
  } catch (e) {
    logger.error(`[consensus] handleAuditSupersede failed: ${e}`);
  }
}

/**
 * "Not a conflict" on an audit conflict card → remember the PAIR so a future
 * audit never re-surfaces it, and confirm.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleAuditDismiss({ ack, body, respond, logger }) {
  await ack();
  try {
    const raw = actionValue(body);
    /** @type {{aId?: string, bId?: string}} */
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    if (parsed.aId && parsed.bId) {
      recordAuditDismissal(parsed.aId, parsed.bId);
    }
    await respond({
      replace_original: false,
      response_type: 'ephemeral',
      text: '👍 Noted — these two aren’t in conflict. I won’t raise this pair in future audits.',
    });
  } catch (e) {
    logger.error(`[consensus] handleAuditDismiss failed: ${e}`);
  }
}

/**
 * "Not a decision" on a decision-capture card → dismiss it and edit the card.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleNotDecision({ ack, body, respond, logger }) {
  await ack();
  try {
    const id = actionValue(body);
    // Mark as genuinely dismissed (status 'dismissed' — 🚫 on the dashboard),
    // removing it from active candidates, and record the learning event. Use the
    // distinct 'capture_dismissed' kind (NOT 'dismissed', which counts alert
    // dismissals) so rejecting a capture never pollutes the alert-precision stat.
    if (id) {
      dismissDecision(id);
      recordEvent('capture_dismissed', id);
    }
    await respond({
      replace_original: true,
      text: '🚫 Okay — I won’t track this as a decision.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🚫 *Dismissed* — I won’t track this as a team decision.',
          },
        },
      ],
    });
  } catch (e) {
    logger.error(`[consensus] handleNotDecision failed: ${e}`);
  }
}
