import { getDecision, recordDismissal, recordEvent, supersede, dismissDecision } from '../../consensus-core/ledger.js';

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
 * "Not a decision" on a decision-capture card → dismiss it and edit the card.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleNotDecision({ ack, body, respond, logger }) {
  await ack();
  try {
    const id = actionValue(body);
    // Mark as genuinely dismissed (status 'dismissed' — 🚫 on the dashboard),
    // removing it from active candidates, and record the learning event.
    if (id) {
      dismissDecision(id);
      recordEvent('dismissed', id);
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
