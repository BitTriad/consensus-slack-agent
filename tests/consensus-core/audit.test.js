import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { extractJson, normalizeScanPairs } from '../../consensus-core/audit.js';
import { auditPairKey, isAuditPairDismissed, recordAuditDismissal } from '../../consensus-core/ledger.js';

describe('auditPairKey normalization', () => {
  it('is order-insensitive', () => {
    assert.strictEqual(auditPairKey('a', 'b'), auditPairKey('b', 'a'));
    assert.strictEqual(auditPairKey('id2', 'id1'), 'id1|id2');
  });

  it('distinguishes different pairs', () => {
    assert.notStrictEqual(auditPairKey('a', 'b'), auditPairKey('a', 'c'));
  });
});

describe('audit dismissal round-trip', () => {
  it('records a pair and recognizes it in either order; unrelated pairs are not dismissed', async () => {
    const a = `dec-${randomUUID()}`;
    const b = `dec-${randomUUID()}`;
    const c = `dec-${randomUUID()}`;

    assert.strictEqual(await isAuditPairDismissed(a, b), false);

    await recordAuditDismissal(a, b);

    // Recognized regardless of argument order.
    assert.strictEqual(await isAuditPairDismissed(a, b), true);
    assert.strictEqual(await isAuditPairDismissed(b, a), true);

    // A different pair sharing one id is still not dismissed.
    assert.strictEqual(await isAuditPairDismissed(a, c), false);

    // Idempotent: recording again does not throw and stays dismissed.
    await recordAuditDismissal(b, a);
    assert.strictEqual(await isAuditPairDismissed(a, b), true);
  });
});

describe('scan JSON defensive parser', () => {
  it('extracts a balanced object embedded in prose / code fences', () => {
    const messy =
      'Sure! Here is the result:\n```json\n{"pairs": [{"aId":"1","bId":"2","why":"x"}]}\n```\nHope that helps.';
    const parsed = extractJson(messy);
    assert.ok(parsed);
    assert.strictEqual(parsed.pairs.length, 1);
  });

  it('returns null for malformed / non-JSON output', () => {
    assert.strictEqual(extractJson(''), null);
    assert.strictEqual(extractJson('no json here at all'), null);
    assert.strictEqual(extractJson('{"pairs": ['), null); // unbalanced
  });

  it('normalizeScanPairs drops self-pairs, unknown ids, and duplicates', () => {
    const valid = new Set(['1', '2', '3']);
    const parsed = {
      pairs: [
        { aId: '1', bId: '2', why: 'ok' },
        { aId: '2', bId: '1', why: 'dup (reverse order)' },
        { aId: '3', bId: '3', why: 'self-pair' },
        { aId: '1', bId: '99', why: 'unknown id' },
        { aId: '2', bId: '3', why: 'ok2' },
        { bId: '3' }, // missing aId
        'garbage',
      ],
    };
    const out = normalizeScanPairs(parsed, valid);
    const keys = out.map((p) => auditPairKey(p.aId, p.bId)).sort();
    assert.deepStrictEqual(keys, ['1|2', '2|3']);
  });

  it('normalizeScanPairs returns [] for malformed shapes', () => {
    assert.deepStrictEqual(normalizeScanPairs(null, new Set(['1'])), []);
    assert.deepStrictEqual(normalizeScanPairs({}, new Set(['1'])), []);
    assert.deepStrictEqual(normalizeScanPairs({ pairs: 'nope' }, new Set(['1'])), []);
  });

  it('normalizeScanPairs caps output at 15 pairs', () => {
    // 20 valid ids → 19 distinct pairs (1-2, 1-3, ... 1-20); the cap keeps 15.
    const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const valid = new Set(ids);
    const pairs = ids.slice(1).map((bId) => ({ aId: 'd0', bId, why: 'x' }));
    const out = normalizeScanPairs({ pairs }, valid);
    assert.strictEqual(out.length, 15);
    // The first 15 nominated pairs are the ones kept (order preserved).
    assert.deepStrictEqual(
      out.map((p) => p.bId),
      ids.slice(1, 16),
    );
  });
});
