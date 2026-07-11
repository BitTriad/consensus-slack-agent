import assert from 'node:assert';
import { describe, it } from 'node:test';

import { auditConflictBlocks, badgeFor, decisionCard, lifecycleBadge } from '../../consensus-core/blocks.js';

const NOW = Date.parse('2026-07-11T00:00:00.000Z');
const PAST = '2026-07-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

describe('lifecycleBadge (pure status → badge)', () => {
  it('maps each lifecycle status to its badge', () => {
    assert.deepStrictEqual(lifecycleBadge('proposed'), { emoji: '📝', label: 'Proposed' });
    assert.deepStrictEqual(lifecycleBadge('confirmed'), { emoji: '✅', label: 'Confirmed' });
    assert.deepStrictEqual(lifecycleBadge('active'), { emoji: '🟢', label: 'Active' });
    assert.deepStrictEqual(lifecycleBadge('exception'), { emoji: '⚖️', label: 'Exception' });
    assert.deepStrictEqual(lifecycleBadge('expired'), { emoji: '⌛', label: 'Expired' });
    assert.deepStrictEqual(lifecycleBadge('rejected'), { emoji: '🚫', label: 'Rejected' });
  });
});

describe('badgeFor (expiry-aware badge)', () => {
  it('renders Expired (⏳) when past expires_at, even if stored status is active', () => {
    assert.deepStrictEqual(badgeFor({ status: 'active', expires_at: PAST }, NOW), { emoji: '⏳', label: 'Expired' });
    assert.deepStrictEqual(badgeFor({ status: 'confirmed', expires_at: PAST }, NOW), { emoji: '⏳', label: 'Expired' });
  });

  it('defers to the status badge when not past expiry', () => {
    assert.deepStrictEqual(badgeFor({ status: 'active', expires_at: FUTURE }, NOW), lifecycleBadge('active'));
    assert.deepStrictEqual(badgeFor({ status: 'active', expires_at: null }, NOW), lifecycleBadge('active'));
    assert.deepStrictEqual(badgeFor({ status: 'proposed', expires_at: null }, NOW), lifecycleBadge('proposed'));
  });

  it('tolerates a null/undefined decision', () => {
    assert.deepStrictEqual(badgeFor(null, NOW), lifecycleBadge('active'));
    assert.deepStrictEqual(badgeFor(undefined, NOW), lifecycleBadge('active'));
  });
});

describe('decisionCard expired-by-date rendering', () => {
  it('shows the ⏳ Expired badge in the context line when expiresAt has passed', () => {
    const blocks = decisionCard({
      statement: 'Feature-flag X on until launch.',
      id: 'd1',
      status: 'active',
      expiresAt: '2000-01-01T00:00:00.000Z', // firmly in the past
    });
    const context = blocks.find((b) => b.type === 'context');
    const text = context?.elements?.[0]?.text ?? '';
    assert.match(text, /⏳/);
    assert.match(text, /\*Expired\*/);
  });

  it('shows the normal Active badge when not expired', () => {
    const blocks = decisionCard({ statement: 'Standing rule.', id: 'd2', status: 'active', expiresAt: FUTURE });
    const context = blocks.find((b) => b.type === 'context');
    const text = context?.elements?.[0]?.text ?? '';
    assert.match(text, /🟢/);
    assert.doesNotMatch(text, /Expired/);
  });
});

describe('auditConflictBlocks expired-by-date rendering', () => {
  it('tags a past-expiry decision with ⏳ Expired in its conflict line', () => {
    const a = {
      id: 'a',
      statement: 'Old promo pricing.',
      channel_id: 'C1',
      channel_name: 'sales',
      created_at: '2026-06-01T00:00:00.000Z',
      expires_at: '2000-01-01T00:00:00.000Z',
      status: 'active',
    };
    const b = {
      id: 'b',
      statement: 'Standard pricing.',
      channel_id: 'C2',
      channel_name: 'sales',
      created_at: '2026-06-02T00:00:00.000Z',
      expires_at: null,
      status: 'active',
    };
    const blocks = auditConflictBlocks({
      confirmed: [{ a, b, reasoning: 'Prices differ.' }],
      checkedCount: 2,
    });
    const rendered = JSON.stringify(blocks);
    // The expired decision carries the ⏳ Expired tag; the non-expired one does not.
    assert.match(rendered, /⏳ \*Expired\*/);
    // Only one expired tag (decision `a`), so exactly one occurrence.
    assert.strictEqual((rendered.match(/⏳ \*Expired\*/g) || []).length, 1);
  });
});
