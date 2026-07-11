/**
 * Block Kit builders for Consensus — the decision-capture card, the
 * contradiction alert, and the App Home dashboard.
 */

import { isExpired } from './governance.js';

/**
 * @typedef {import('./ledger.js').Decision} Decision
 */

/**
 * Format an ISO timestamp (or Slack ts) into a short human date.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function shortDate(value) {
  if (!value) return 'unknown date';
  // Slack ts looks like "1700000000.000100"; ISO looks like a date string.
  const ms = /^\d+\.\d+$/.test(value) ? Number.parseFloat(value) * 1000 : Date.parse(value);
  if (Number.isNaN(ms)) return 'unknown date';
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** @param {string | null | undefined} id */
function userMention(id) {
  return id ? `<@${id}>` : 'someone';
}

/**
 * Sanitize untrusted text for safe rendering inside a Slack `mrkdwn` field.
 * Escapes the three Slack entity characters (& < >) so chat content cannot forge
 * mentions (<!channel>, <@U…>) or fake <http://x|links>, collapses whitespace,
 * and truncates to `maxLen` with an ellipsis.
 * @param {unknown} text
 * @param {number} [maxLen=300]
 * @returns {string}
 */
export function sanitizeMrkdwn(text, maxLen = 300) {
  let s = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) {
    s = `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  }
  return s;
}

/**
 * Human-readable lifecycle label + emoji for a decision status.
 * @param {Decision['status']} status
 * @returns {{emoji: string, label: string}}
 */
export function lifecycleBadge(status) {
  switch (status) {
    case 'proposed':
      return { emoji: '📝', label: 'Proposed' };
    case 'confirmed':
      return { emoji: '✅', label: 'Confirmed' };
    case 'active':
      return { emoji: '🟢', label: 'Active' };
    case 'exception':
      return { emoji: '⚖️', label: 'Exception' };
    case 'superseded':
      return { emoji: '🔁', label: 'Superseded' };
    case 'expired':
      return { emoji: '⌛', label: 'Expired' };
    case 'rejected':
      return { emoji: '🚫', label: 'Rejected' };
    default:
      return { emoji: '🟢', label: 'Active' };
  }
}

/**
 * Expiry-aware lifecycle badge. When a decision has passed its `expires_at`,
 * render Expired (⏳) REGARDLESS of the stored status — expiry is computed live
 * via governance.isExpired, so a decision reads as expired the moment its date
 * passes even though no scheduled sweep has flipped the stored status to the
 * literal `expired` yet (see governance.materializeExpired for that Phase-2 job).
 * A row already stored as `expired` still renders via lifecycleBadge's ⌛ case;
 * this ⏳ path specifically covers the "expired by date, status not yet flipped"
 * case. Otherwise defers to {@link lifecycleBadge}.
 * @param {Pick<Decision, 'status' | 'expires_at'> | null | undefined} decision
 * @param {number} [now] epoch ms
 * @returns {{emoji: string, label: string}}
 */
export function badgeFor(decision, now = Date.now()) {
  if (decision && isExpired(decision, now)) return { emoji: '⏳', label: 'Expired' };
  return lifecycleBadge(decision?.status ?? 'active');
}

/**
 * Lifecycle action buttons appropriate to a decision's current state. Proposed
 * decisions can be Confirmed / Rejected / Marked-exception / Superseded; already
 * enforceable ones (active/confirmed) can be narrowed to an exception or
 * superseded; terminal states (superseded/expired/rejected) carry no actions.
 * Every button is authority-gated in the handler (see governance.canConfirm).
 * @param {Decision['status']} status
 * @param {string} id
 * @returns {import('@slack/types').KnownBlock[]}
 */
function lifecycleActions(status, id) {
  /** @type {any[]} */
  const elements = [];
  if (status === 'proposed') {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Confirm', emoji: true },
      action_id: 'consensus_confirm',
      value: id,
      style: 'primary',
    });
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Reject', emoji: true },
      action_id: 'consensus_reject',
      value: id,
      style: 'danger',
    });
  }
  if (status === 'proposed' || status === 'active' || status === 'confirmed') {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Mark exception', emoji: true },
      action_id: 'consensus_exception',
      value: id,
    });
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Mark superseded', emoji: true },
      action_id: 'consensus_supersede',
      value: id,
    });
  }
  if (elements.length === 0) return [];
  return [{ type: 'actions', elements }];
}

/**
 * Compact "Decision captured" card, posted in-thread. Shows the lifecycle state
 * (badge) and the owner, and renders lifecycle actions appropriate to the state.
 * When `expiresAt` is in the past the badge renders Expired (⏳) even if the
 * stored status has not yet been flipped (see {@link badgeFor}).
 * @param {{statement: string, decidedBy?: string|null, channelName?: string|null, permalink?: string|null, id: string, status?: Decision['status'], ownerUserId?: string|null, expiresAt?: string|null}} args
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function decisionCard({
  statement,
  decidedBy,
  channelName,
  permalink,
  id,
  status = 'active',
  ownerUserId,
  expiresAt = null,
}) {
  const where = channelName ? `#${channelName}` : 'this channel';
  const badge = badgeFor({ status, expires_at: expiresAt });
  const owner = ownerUserId ?? decidedBy;
  const header = status === 'proposed' ? '📝 Proposed decision' : '📌 Decision captured';
  const contextText =
    `${badge.emoji} *${badge.label}* · Owner ${userMention(owner)} · in ${where} · ${shortDate(new Date().toISOString())}` +
    (permalink ? ` · <${permalink}|view message>` : '');

  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${sanitizeMrkdwn(statement, 300)}*` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    },
  ];
  if (status === 'proposed') {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_Proposed — not yet enforced. An authorized owner/admin can Confirm to make it a standing decision._',
        },
      ],
    });
  }
  blocks.push(...lifecycleActions(status, id));
  return blocks;
}

/**
 * Contradiction alert, posted ephemerally to the message author.
 * @param {{newMessageText: string, decision: Decision, confidence: number, reasoning: string}} args
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function contradictionAlert({ newMessageText, decision, confidence, reasoning }) {
  const where = decision.channel_name ? `#${decision.channel_name}` : 'a channel';
  const pct = `${Math.round((confidence || 0) * 100)}%`;
  const original = decision.permalink ? `<${decision.permalink}|View original>` : 'original message';
  const contextText =
    `Decided by ${userMention(decision.decided_by)} in ${where} · ${shortDate(decision.created_at)} · ${original}` +
    ` · ${pct} confidence`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚠️ *Heads up — this may conflict with an active team policy.*',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `> ${sanitizeMrkdwn(decision.statement, 300)}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'This is intentional — supersede', emoji: true },
          action_id: 'consensus_confirm_supersede',
          value: decision.id,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not a conflict', emoji: true },
          action_id: 'consensus_dismiss',
          // Carry the OFFENDING message text (truncated) so the dismissal is
          // recorded against it — not against the alert's own rendered text.
          // Block Kit button values cap at 2000 chars; 500 keeps us well under.
          value: JSON.stringify({ decisionId: decision.id, text: (newMessageText || '').slice(0, 500) }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Show reasoning', emoji: true },
          action_id: 'consensus_reasoning',
          // Reasoning is rendered as mrkdwn later (handleReasoning); sanitize +
          // cap here so it is safe and stays under Block Kit's 2000-char value cap.
          value: sanitizeMrkdwn(reasoning || 'No reasoning provided.', 1500),
        },
      ],
    },
  ];
}

/**
 * App Home dashboard view.
 * @param {{stats: import('./ledger.js').Stats, decisions: Decision[], lastAudit?: import('./audit.js').LastAuditSummary | null}} args
 * @returns {import('@slack/types').HomeView}
 */
export function homeView({ stats, decisions, lastAudit = null }) {
  const precision = stats.precisionPct === null || stats.precisionPct === undefined ? '—' : `${stats.precisionPct}%`;
  const confirmed = stats.superseded;

  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🛡️ Consensus — workspace consistency guardian', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Active decisions*\n${stats.activeDecisions}` },
        { type: 'mrkdwn', text: `*Total captured*\n${stats.captured}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔎 Run consistency audit', emoji: true },
          action_id: 'consensus_run_audit',
          style: 'primary',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: lastAudit
            ? `Last audit: ${shortDate(lastAudit.at)} · ${lastAudit.checkedCount} checked · ${lastAudit.confirmedCount} latent conflict${lastAudit.confirmedCount === 1 ? '' : 's'} found`
            : 'X-ray the whole ledger for standing decisions that already contradict each other.',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*📊 All time*' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Alerts fired*\n${stats.alertsFired}` },
        { type: 'mrkdwn', text: `*Confirmed (superseded)*\n${confirmed}` },
        { type: 'mrkdwn', text: `*Dismissed*\n${stats.dismissed}` },
        { type: 'mrkdwn', text: `*Precision*\n${precision}` },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🧠 Learned patterns: ${stats.learnedPatterns}` }],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Counts are workspace-wide totals; the log below shows only decisions you have access to.',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🗂 Decision Log*' },
    },
  ];

  if (decisions.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "_No decisions captured yet._ I'll start logging team decisions as they happen in your channels.",
      },
    });
  } else {
    for (const d of decisions.slice(0, 15)) {
      const where = d.channel_name ? `#${d.channel_name}` : 'channel';
      const line = `${badgeFor(d).emoji} *${sanitizeMrkdwn(d.statement, 300)}*`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: line },
      });
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${where} · ${shortDate(d.created_at)}${d.permalink ? ` · <${d.permalink}|view>` : ''}`,
          },
        ],
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Consensus learns from every Confirm/Dismiss — precision improves as you use it.',
      },
    ],
  });

  return { type: 'home', blocks };
}

/**
 * Render one decision as a "statement (channel, date, link)" mrkdwn fragment for
 * an audit conflict card. A decision past its `expires_at` is prefixed with an
 * ⏳ Expired badge (computed live via {@link badgeFor}) even if its stored status
 * has not been flipped to the literal `expired`.
 * @param {Decision} d
 * @param {number} [now] epoch ms
 * @returns {string}
 */
function auditDecisionLine(d, now = Date.now()) {
  const where = d.channel_name ? `#${d.channel_name}` : 'a channel';
  const link = d.permalink ? ` · <${d.permalink}|view>` : '';
  const expiredTag = isExpired(d, now) ? '⏳ *Expired* · ' : '';
  return `*${sanitizeMrkdwn(d.statement, 300)}*\n_${expiredTag}${where} · ${shortDate(d.created_at)}${link}_`;
}

/**
 * Block Kit blocks for a consistency-audit report: an intro line, one card per
 * confirmed latent conflict (with Supersede-first / Supersede-second / Not-a-conflict
 * buttons), and an optional trailing line counting conflicts hidden behind private
 * channels the viewer can't access.
 *
 * @param {{
 *   confirmed: import('./audit.js').ConfirmedConflict[],
 *   checkedCount: number,
 *   hiddenPrivateCount?: number
 * }} args
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function auditConflictBlocks({ confirmed, checkedCount, hiddenPrivateCount = 0 }) {
  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔎 *Consistency audit* — ${checkedCount} active decision${checkedCount === 1 ? '' : 's'} checked, *${confirmed.length}* latent conflict${confirmed.length === 1 ? '' : 's'} found.`,
      },
    },
  ];

  for (const { a, b, reasoning } of confirmed) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚠️ *Latent conflict:*\n${auditDecisionLine(a)}\n\n*vs*\n\n${auditDecisionLine(b)}`,
      },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🧠 ${sanitizeMrkdwn(reasoning || 'No reasoning provided.', 300)}` }],
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Supersede first', emoji: true },
          action_id: 'consensus_audit_supersede',
          value: a.id,
          style: 'primary',
        },
        {
          // Distinct action_id (Slack requires uniqueness within an actions
          // block); routed to the same handler as "Supersede first".
          type: 'button',
          text: { type: 'plain_text', text: 'Supersede second', emoji: true },
          action_id: 'consensus_audit_supersede_second',
          value: b.id,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not a conflict', emoji: true },
          action_id: 'consensus_audit_dismiss',
          value: JSON.stringify({ aId: a.id, bId: b.id }),
        },
      ],
    });
  }

  if (hiddenPrivateCount > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🔒 ${hiddenPrivateCount} additional conflict${hiddenPrivateCount === 1 ? '' : 's'} exist involving private channels you don't have access to.`,
        },
      ],
    });
  }

  return blocks;
}
