import {
  handleCardSupersede,
  handleConfirmSupersede,
  handleDismiss,
  handleNotDecision,
  handleReasoning,
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

  // Consensus decision-card actions.
  app.action('consensus_supersede', handleCardSupersede);
  app.action('consensus_not_decision', handleNotDecision);
}
