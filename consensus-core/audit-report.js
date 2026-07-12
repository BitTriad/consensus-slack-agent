/**
 * Glue between the audit ENGINE (audit.js — pure LLM logic) and the Slack
 * SURFACES (action handler DM, @mention thread). Runs an audit over the active
 * ledger, applies the per-viewer permission gate (fail-closed), records the
 * learning event, updates the App Home "Last audit" cache, and composes the
 * Block Kit message. Shared so the button flow and the mention flow are byte-for-byte
 * identical and permission-gated the same way.
 */

import { runAudit, setLastAudit } from './audit.js';
import { auditConflictBlocks } from './blocks.js';
import { isEnforceable } from './governance.js';
import { listDecisions, recordEvent } from './ledger.js';
import { canSeeDecision } from './permissions.js';

/**
 * Audit metering. Audits are expensive (one scan call + one judge call per
 * candidate pair), so we allow at most one at a time and impose a short cooldown
 * between runs, shared across every surface (App Home button, @mention).
 */
const AUDIT_COOLDOWN_MS = 60_000;
let auditInFlight = false;
let lastAuditFinishedAt = 0;

/**
 * Atomically reserve the right to run an audit. Because JS is single-threaded,
 * the check-and-set here completes synchronously before the caller awaits any
 * audit work, so two near-simultaneous triggers can never both acquire. Returns
 * true if the caller may proceed (and marks an audit in-flight); false if one is
 * already running or finished less than the cooldown ago. Every successful
 * acquire MUST be paired with a {@link releaseAudit} in a finally block.
 * @param {number} [now]
 * @returns {boolean}
 */
export function tryAcquireAudit(now = Date.now()) {
  if (auditInFlight) return false;
  if (now - lastAuditFinishedAt < AUDIT_COOLDOWN_MS) return false;
  auditInFlight = true;
  return true;
}

/**
 * Release the audit lock and start the cooldown clock. Idempotent.
 * @param {number} [now]
 * @returns {void}
 */
export function releaseAudit(now = Date.now()) {
  auditInFlight = false;
  lastAuditFinishedAt = now;
}

/**
 * Test-only hook: clear the metering state so a test can run audits back-to-back.
 * @returns {void}
 */
export function _resetAuditMeter() {
  auditInFlight = false;
  lastAuditFinishedAt = 0;
}

/**
 * @typedef {Object} AuditReport
 * @property {number} checkedCount
 * @property {import('./audit.js').ConfirmedConflict[]} visibleConfirmed Pairs the viewer may see in full.
 * @property {number} hiddenPrivateCount Confirmed pairs excluded because a member-only decision is involved.
 * @property {number} totalConfirmed Workspace-wide confirmed count (visible + hidden).
 */

/**
 * Run an audit and permission-filter the confirmed conflicts for one viewer.
 *
 * A confirmed pair is only shown if the viewer can see BOTH decisions: if EITHER
 * is private and the viewer is not a member of its channel, the whole pair is
 * excluded (fail-closed) and counted into `hiddenPrivateCount` — never any detail.
 *
 * With `publicOnly` (used when the report is posted into a public channel thread
 * every member can read), the gate is stricter and membership-free: a pair is
 * shown ONLY when BOTH decisions are public. Any pair touching a private decision
 * is excluded, with no membership calls.
 *
 * In `publicOnly` mode the returned report is additionally scrubbed of any hint
 * that private-channel conflicts exist: `hiddenPrivateCount` is forced to 0 and
 * `totalConfirmed` is set to `visibleConfirmed.length`. A report posted where the
 * whole channel can read it must not disclose even the EXISTENCE or the COUNT of
 * conflicts involving private channels — the "🔒 N additional conflicts…" summary
 * line and the non-zero-vs-zero wording would otherwise leak exactly that.
 *
 * @param {{
 *   client: import('@slack/web-api').WebClient,
 *   userId: string,
 *   logger?: import('@slack/bolt').Logger
 * }} args
 * @param {{ publicOnly?: boolean }} [options]
 * @returns {Promise<AuditReport>}
 */
export async function runAuditForViewer({ client, userId, logger }, { publicOnly = false } = {}) {
  // Only enforceable decisions (active/confirmed AND not past their expires_at)
  // are audited for latent conflicts — proposed/exception/superseded/expired/
  // rejected rows are never enforced, so a conflict among them is not actionable.
  const now = Date.now();
  const decisions = (await listDecisions({ status: ['active', 'confirmed'], limit: 60 })).filter((d) =>
    isEnforceable(d, now),
  );
  const result = await runAudit({ decisions });
  await recordEvent('audit_run');

  /** @type {import('./audit.js').ConfirmedConflict[]} */
  const visibleConfirmed = [];
  let hiddenPrivateCount = 0;
  for (const c of result.confirmed) {
    let visible;
    if (publicOnly) {
      // Public-channel report: show a pair only when BOTH decisions are public.
      // No membership lookups — a private decision is never surfaced to a channel.
      visible = !c.a.is_private && !c.b.is_private;
    } else {
      // canSeeDecision short-circuits (no API call) for public decisions, and
      // fails closed on any membership-lookup error → excluded, never leaked.
      const aOk = await canSeeDecision(client, c.a, userId, logger);
      const bOk = aOk ? await canSeeDecision(client, c.b, userId, logger) : false;
      visible = aOk && bOk;
    }
    if (visible) visibleConfirmed.push(c);
    else hiddenPrivateCount++;
  }

  setLastAudit({
    at: new Date().toISOString(),
    checkedCount: result.checkedCount,
    confirmedCount: result.confirmed.length,
  });

  return {
    checkedCount: result.checkedCount,
    visibleConfirmed,
    // A public report must not disclose even the existence or count of
    // private-channel conflicts: zero out the hidden count and report a
    // workspace total that reflects only what is being shown publicly.
    hiddenPrivateCount: publicOnly ? 0 : hiddenPrivateCount,
    totalConfirmed: publicOnly ? visibleConfirmed.length : result.confirmed.length,
  };
}

/**
 * Compose the Slack message ({text, blocks}) for an audit report. Zero confirmed
 * conflicts → a clean all-clear line; otherwise the per-pair conflict cards plus
 * a private-channel summary line when applicable.
 * @param {AuditReport} report
 * @returns {{text: string, blocks?: import('@slack/types').KnownBlock[]}}
 */
export function composeAuditMessage(report) {
  const { checkedCount, visibleConfirmed, hiddenPrivateCount, totalConfirmed } = report;

  // Nothing confirmed anywhere → unambiguous all-clear.
  if (totalConfirmed === 0) {
    return {
      text: `✅ Audit complete — ${checkedCount} decision${checkedCount === 1 ? '' : 's'} checked, no latent contradictions. Your workspace agrees with itself.`,
    };
  }

  return {
    text: `🔎 Consistency audit — ${checkedCount} decisions checked, ${visibleConfirmed.length} latent conflict${visibleConfirmed.length === 1 ? '' : 's'} to review.`,
    blocks: auditConflictBlocks({ confirmed: visibleConfirmed, checkedCount, hiddenPrivateCount }),
  };
}
