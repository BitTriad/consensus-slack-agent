import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { addDecision, computeStats, isKnownFalsePositive, recordDismissal } from '../../consensus-core/ledger.js';

describe('computeStats precision math', () => {
  const base = { active: 0, superseded: 0, captured: 0, learnedPatterns: 0 };

  it('computes precision from alert dismissals', () => {
    assert.strictEqual(computeStats({ ...base, alertsFired: 4, dismissed: 1 }).precisionPct, 75);
  });

  it('clamps precision to 0 when dismissals exceed alerts (never negative)', () => {
    // A stray accounting skew must never surface a negative percentage.
    assert.strictEqual(computeStats({ ...base, alertsFired: 2, dismissed: 5 }).precisionPct, 0);
  });

  it('is null (undefined) when no alerts have fired', () => {
    assert.strictEqual(computeStats({ ...base, alertsFired: 0, dismissed: 0 }).precisionPct, null);
  });

  it('is 100 when no alerts were dismissed', () => {
    assert.strictEqual(computeStats({ ...base, alertsFired: 3, dismissed: 0 }).precisionPct, 100);
  });
});

describe('dismissal memory', () => {
  it('recordDismissal makes a re-whitespaced/re-cased variant a known false positive', () => {
    // A unique decision id keeps this test isolated from any other dismissals.
    const decisionId = `test-${randomUUID()}`;
    const offending = "Let's just spin up MongoDB for the analytics service.";

    // Before recording, the text is not yet a known false positive.
    assert.strictEqual(isKnownFalsePositive(offending, decisionId), false);

    recordDismissal(offending, decisionId);

    // Same text, only whitespace/casing/trailing punctuation differ → still matches.
    const variant = '  lets just   spin up MONGODB for the analytics   service  ';
    assert.strictEqual(isKnownFalsePositive(variant, decisionId), true);

    // A genuinely different message against the same decision does not match.
    assert.strictEqual(isKnownFalsePositive('we are staying on Postgres', decisionId), false);
  });

  it('matches long messages that were truncated to the 500-char button prefix on store', () => {
    const decisionId = `test-${randomUUID()}`;
    // A realistic offending message longer than the 500-char button-value cap.
    const longBody = `We are moving the new billing service onto MySQL because the team is more comfortable with it. ${'padding words to grow the message well beyond five hundred characters '.repeat(12)}`;
    assert.ok(longBody.length > 500, 'fixture must exceed the 500-char prefix');

    // The dismissal button can only carry a 500-char slice of the offending text.
    const storedFromButton = longBody.slice(0, 500);
    recordDismissal(storedFromButton, decisionId);

    // Later, the pipeline checks the FULL (untruncated) message. Because both
    // sides normalize+truncate to the same 500-char prefix, it must still match
    // and the alert must NOT re-fire.
    assert.strictEqual(isKnownFalsePositive(longBody, decisionId), true);

    // A message sharing only a shorter prefix but diverging within the first 500
    // chars is still distinct.
    const different = `${'padding words to grow the message well beyond five hundred characters '.repeat(12)} but this one picks Postgres instead`;
    assert.strictEqual(isKnownFalsePositive(different, decisionId), false);
  });

  it('multi-decision capture: several decisions from ONE message all persist; exact duplicate still dedups', () => {
    const ts = `${Date.now()}.000100`;
    const base = {
      rationale: null,
      channel_id: 'C_MULTI_TEST',
      channel_name: 'multi-test',
      decided_by: 'U1',
      message_ts: ts,
      permalink: null,
      confidence: 0.95,
      is_private: 0,
    };
    const a = addDecision({ ...base, statement: 'Incident postmortems are mandatory within 48 hours.' });
    const b = addDecision({ ...base, statement: 'The status page moves to Instatus.' });
    // Two DIFFERENT decisions from the same message must be two distinct rows.
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.statement !== b.statement, true);
    // The exact same (message, statement) redelivered must return the SAME row.
    const aAgain = addDecision({ ...base, statement: 'Incident postmortems are mandatory within 48 hours.' });
    assert.strictEqual(aAgain.id, a.id);
  });
});
