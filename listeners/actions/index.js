import {
  handleAuditDismiss,
  handleAuditSupersede,
  handleCardSupersede,
  handleConfirm,
  handleConfirmSupersede,
  handleDismiss,
  handleMarkException,
  handleNotDecision,
  handleReasoning,
  handleReject,
  handleRunAudit,
} from './consensus-actions.js';
import { handleFeedbackButton } from './feedback-buttons.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);

  // Consensus contradiction-alert actions.
  app.action('consensus_dismiss', handleDismiss);
  app.action('consensus_confirm_supersede', handleConfirmSupersede);
  app.action('consensus_reasoning', handleReasoning);

  // Consensus decision-card lifecycle actions.
  app.action('consensus_supersede', handleCardSupersede);
  app.action('consensus_confirm', handleConfirm);
  app.action('consensus_reject', handleReject);
  app.action('consensus_exception', handleMarkException);
  // Legacy card action (still registered for cards posted before the lifecycle
  // rework); routes to the reject-equivalent dismissal handler.
  app.action('consensus_not_decision', handleNotDecision);

  // Consensus workspace consistency-audit actions.
  app.action('consensus_run_audit', handleRunAudit);
  app.action('consensus_audit_supersede', handleAuditSupersede);
  app.action('consensus_audit_supersede_second', handleAuditSupersede);
  app.action('consensus_audit_dismiss', handleAuditDismiss);
}
