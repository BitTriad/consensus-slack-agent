import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  addDecision,
  computeStats,
  countDecisionsByAuthorSince,
  isKnownFalsePositive,
  recordDismissal,
} from '../../consensus-core/ledger.js';

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
  it('recordDismissal makes a re-whitespaced/re-cased variant a known false positive', async () => {
    // A unique decision id keeps this test isolated from any other dismissals.
    const decisionId = `test-${randomUUID()}`;
    const userId = `U_${randomUUID()}`;
    const offending = "Let's just spin up MongoDB for the analytics service.";

    // Before recording, the text is not yet a known false positive.
    assert.strictEqual(await isKnownFalsePositive(offending, decisionId, userId), false);

    await recordDismissal(offending, decisionId, userId);

    // Same text, only whitespace/casing/trailing punctuation differ → still matches.
    const variant = '  lets just   spin up MONGODB for the analytics   service  ';
    assert.strictEqual(await isKnownFalsePositive(variant, decisionId, userId), true);

    // A genuinely different message against the same decision does not match.
    assert.strictEqual(await isKnownFalsePositive('we are staying on Postgres', decisionId, userId), false);
  });

  it('matches long messages that were truncated to the 500-char button prefix on store', async () => {
    const decisionId = `test-${randomUUID()}`;
    const userId = `U_${randomUUID()}`;
    // A realistic offending message longer than the 500-char button-value cap.
    const longBody = `We are moving the new billing service onto MySQL because the team is more comfortable with it. ${'padding words to grow the message well beyond five hundred characters '.repeat(12)}`;
    assert.ok(longBody.length > 500, 'fixture must exceed the 500-char prefix');

    // The dismissal button can only carry a 500-char slice of the offending text.
    const storedFromButton = longBody.slice(0, 500);
    await recordDismissal(storedFromButton, decisionId, userId);

    // Later, the pipeline checks the FULL (untruncated) message. Because both
    // sides normalize+truncate to the same 500-char prefix, it must still match
    // and the alert must NOT re-fire.
    assert.strictEqual(await isKnownFalsePositive(longBody, decisionId, userId), true);

    // A message sharing only a shorter prefix but diverging within the first 500
    // chars is still distinct.
    const different = `${'padding words to grow the message well beyond five hundred characters '.repeat(12)} but this one picks Postgres instead`;
    assert.strictEqual(await isKnownFalsePositive(different, decisionId, userId), false);
  });

  it('is scoped per user: A dismissing suppresses only A, never B (anti-poisoning)', async () => {
    // Attack shape: user A dismisses a real contradiction alert. That must NOT
    // silence the identical message coming from user B.
    const decisionId = `test-${randomUUID()}`;
    const userA = `U_A_${randomUUID()}`;
    const userB = `U_B_${randomUUID()}`;
    const offending = "Let's just spin up MongoDB for the analytics service.";

    await recordDismissal(offending, decisionId, userA);

    // A's own re-alert is suppressed…
    assert.strictEqual(await isKnownFalsePositive(offending, decisionId, userA), true);
    // …but B's identical message still alerts (A's judgment is not B's).
    assert.strictEqual(await isKnownFalsePositive(offending, decisionId, userB), false);
  });

  it('legacy dismissal row without a user_id matches nobody', async () => {
    // Simulate a pre-migration row by recording with a null user_id, then confirm
    // it never suppresses any user (the stage is reset before filming).
    const decisionId = `test-${randomUUID()}`;
    const offending = 'We are moving billing onto MySQL.';

    await recordDismissal(offending, decisionId, null);

    // No user matches a null-scoped row — not even a null lookup.
    assert.strictEqual(await isKnownFalsePositive(offending, decisionId, `U_${randomUUID()}`), false);
    assert.strictEqual(await isKnownFalsePositive(offending, decisionId, null), false);
  });

  it('multi-decision capture: several decisions from ONE message all persist; exact duplicate still dedups', async () => {
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
    const a = await addDecision({ ...base, statement: 'Incident postmortems are mandatory within 48 hours.' });
    const b = await addDecision({ ...base, statement: 'The status page moves to Instatus.' });
    // Two DIFFERENT decisions from the same message must be two distinct rows.
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.statement !== b.statement, true);
    // The exact same (message, statement) redelivered must return the SAME row.
    const aAgain = await addDecision({ ...base, statement: 'Incident postmortems are mandatory within 48 hours.' });
    assert.strictEqual(aAgain.id, a.id);
  });
});

describe('countDecisionsByAuthorSince', () => {
  it('counts only this author since the timestamp, and nobody else', async () => {
    // Unique author ids keep this isolated from any other decisions in the store.
    const authorA = `U_A_${randomUUID()}`;
    const authorB = `U_B_${randomUUID()}`;
    const channelId = `C_CAP_${randomUUID()}`;
    const early = '2000-01-01T00:00:00.000Z';
    const base = {
      rationale: null,
      channel_id: channelId,
      channel_name: 'cap-test',
      permalink: null,
      confidence: 0.95,
      is_private: 0,
    };

    // Three decisions by A, one by B — all with created_at well after `early`.
    await addDecision({ ...base, decided_by: authorA, message_ts: `${Date.now()}.100`, statement: 'A one.' });
    await addDecision({ ...base, decided_by: authorA, message_ts: `${Date.now()}.200`, statement: 'A two.' });
    await addDecision({ ...base, decided_by: authorA, message_ts: `${Date.now()}.300`, statement: 'A three.' });
    await addDecision({ ...base, decided_by: authorB, message_ts: `${Date.now()}.400`, statement: 'B one.' });

    assert.strictEqual(await countDecisionsByAuthorSince(authorA, early), 3, "counts A's three");
    assert.strictEqual(await countDecisionsByAuthorSince(authorB, early), 1, "counts B's one");

    // A future lower-bound excludes everything already stored.
    const future = '2999-01-01T00:00:00.000Z';
    assert.strictEqual(await countDecisionsByAuthorSince(authorA, future), 0, 'timestamp filter excludes older rows');
  });
});
