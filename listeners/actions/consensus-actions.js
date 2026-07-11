import {
  composeAuditMessage,
  releaseAudit,
  runAuditForViewer,
  tryAcquireAudit,
} from '../../consensus-core/audit-report.js';
import { decisionCard } from '../../consensus-core/blocks.js';
import { canConfirm, isEnforceable } from '../../consensus-core/governance.js';
import {
  dismissDecision,
  getDecision,
  listDecisions,
  recordAuditDismissal,
  recordDismissal,
  recordEvent,
  setDecisionStatus,
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
    // Scope the dismissal to the clicking user (per-user memory kills the
    // dismissal-poisoning vector — see ledger.recordDismissal). The alert is
    // ephemeral, so the clicker is always the alerted author.
    const userId = /** @type {any} */ (body).user?.id ?? null;
    if (parsed.decisionId) {
      recordDismissal(messageText, parsed.decisionId, userId);
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
 * The ephemeral refusal shown when a non-authorized user clicks a lifecycle
 * action (Confirm / Reject / Mark-exception / Supersede) on a decision card.
 * @param {import('@slack/bolt').RespondFn} respond
 * @returns {Promise<void>}
 */
async function refuseUnauthorized(respond) {
  await respond({
    replace_original: false,
    response_type: 'ephemeral',
    text: '🔒 Only an authorized decision owner/admin can confirm this.',
  });
}

/**
 * Re-render a decision card in place after a lifecycle transition so its badge
 * and buttons reflect the new status.
 * @param {import('@slack/bolt').RespondFn} respond
 * @param {import('../../consensus-core/ledger.js').Decision} decision
 * @param {string} noticeText fallback/plain text summary of the transition
 * @returns {Promise<void>}
 */
async function replaceWithCard(respond, decision, noticeText) {
  await respond({
    replace_original: true,
    text: noticeText,
    blocks: decisionCard({
      statement: decision.statement,
      decidedBy: decision.decided_by,
      channelName: decision.channel_name,
      permalink: decision.permalink,
      id: decision.id,
      status: decision.status,
      ownerUserId: decision.owner_user_id,
      expiresAt: decision.expires_at,
    }),
  });
}

/**
 * "Mark superseded" on a decision-capture card → supersede + edit the card.
 * Authority-gated: only an authorized owner/admin may transition the decision.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleCardSupersede({ ack, body, respond, logger }) {
  await ack();
  try {
    const userId = /** @type {any} */ (body).user?.id ?? null;
    if (!canConfirm(userId)) return void (await refuseUnauthorized(respond));
    const id = actionValue(body);
    if (!id) return;
    supersede(id, null);
    recordEvent('superseded', id);
    const decision = getDecision(id);
    if (decision) {
      await replaceWithCard(respond, decision, `🔁 Decision marked *superseded*: ${decision.statement}`);
    } else {
      await respond({ replace_original: true, text: '🔁 Decision marked *superseded*.' });
    }
  } catch (e) {
    logger.error(`[consensus] handleCardSupersede failed: ${e}`);
  }
}

/**
 * "Confirm" on a proposed decision card → promote it to an enforceable
 * `confirmed` (authority-approved) decision. Authority-gated.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleConfirm({ ack, body, respond, logger }) {
  await ack();
  try {
    const userId = /** @type {any} */ (body).user?.id ?? null;
    if (!canConfirm(userId)) return void (await refuseUnauthorized(respond));
    const id = actionValue(body);
    if (!id) return;
    setDecisionStatus(id, 'confirmed');
    recordEvent('confirmed', id);
    const decision = getDecision(id);
    if (decision) {
      await replaceWithCard(respond, decision, `✅ Decision *confirmed*: ${decision.statement}`);
    } else {
      await respond({ replace_original: true, text: '✅ Decision *confirmed*.' });
    }
  } catch (e) {
    logger.error(`[consensus] handleConfirm failed: ${e}`);
  }
}

/**
 * "Reject" on a decision card → mark it `rejected` (never enforced). Authority-gated.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleReject({ ack, body, respond, logger }) {
  await ack();
  try {
    const userId = /** @type {any} */ (body).user?.id ?? null;
    if (!canConfirm(userId)) return void (await refuseUnauthorized(respond));
    const id = actionValue(body);
    if (!id) return;
    setDecisionStatus(id, 'rejected');
    recordEvent('rejected', id);
    await respond({
      replace_original: true,
      text: '🚫 Rejected — I won’t track this as a team decision.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '🚫 *Rejected* — I won’t enforce this as a team decision.' },
        },
      ],
    });
  } catch (e) {
    logger.error(`[consensus] handleReject failed: ${e}`);
  }
}

/**
 * "Mark exception" on a decision card → mark it `exception` (a carve-out that is
 * NOT globally enforced). Authority-gated.
 *
 * Phase-1 SEMANTICS (self-exception): this transitions the SAME decision to
 * status `exception`, leaving `exception_of` null. The meaning is "this standing
 * item is actually a carve-out — don't enforce it globally". Because `exception`
 * is excluded from ENFORCEABLE_STATUSES (see governance.isEnforceable), the row
 * immediately stops being an alert/audit candidate. No new row is created.
 *
 * PHASE-2 TODO: model an exception as a SEPARATE entry that references a distinct
 * parent policy via the `exception_of` column (already migrated on both backends)
 * and narrows it via an `applies_to` scope note — see governance.narrowsScope for
 * the intended predicate. That richer "exception references a distinct parent"
 * model is intentionally NOT built here; this handler only does the tractable
 * self-exception so nothing is over-claimed.
 * @param {import('@slack/bolt').SlackActionMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleMarkException({ ack, body, respond, logger }) {
  await ack();
  try {
    const userId = /** @type {any} */ (body).user?.id ?? null;
    if (!canConfirm(userId)) return void (await refuseUnauthorized(respond));
    const id = actionValue(body);
    if (!id) return;
    setDecisionStatus(id, 'exception');
    recordEvent('exception', id);
    const decision = getDecision(id);
    if (decision) {
      await replaceWithCard(respond, decision, `⚖️ Marked as *exception*: ${decision.statement}`);
    } else {
      await respond({ replace_original: true, text: '⚖️ Marked as an *exception*.' });
    }
  } catch (e) {
    logger.error(`[consensus] handleMarkException failed: ${e}`);
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
      const now = Date.now();
      const activeCount = listDecisions({ status: ['active', 'confirmed'], limit: 60 }).filter((d) =>
        isEnforceable(d, now),
      ).length;
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
