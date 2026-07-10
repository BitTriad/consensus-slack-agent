import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { isKnownFalsePositive, recordDismissal } from '../../consensus-core/ledger.js';

describe('dismissal memory', () => {
  it('recordDismissal makes a re-whitespaced/re-cased variant a known false positive', () => {
    // A unique decision id keeps this test isolated from any other dismissals.
    const decisionId = `test-${randomUUID()}`;
    const offending = "Let's just spin up MongoDB for the analytics service.";

    // Before recording, the text is not yet a known false positive.
    assert.strictEqual(isKnownFalsePositive(offending, decisionId), false);

    recordDismissal(offending, decisionId);

    // Same text, only whitespace/casing/trailing punctuation differ → still matches.
    const variant = "  lets just   spin up MONGODB for the analytics   service  ";
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
});
