import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { addDecision, getDecision, listDecisionsByMessage, retireDecision } from '../../consensus-core/ledger.js';
import { diffStatements } from '../../consensus-core/pipeline.js';

describe('listDecisionsByMessage', () => {
  it('returns all rows for a message and only that message', async () => {
    // Unique channel keeps this test isolated from any other rows in the store.
    const channelId = `C_MSGSYNC_${randomUUID()}`;
    const ts1 = `${Date.now()}.000100`;
    const ts2 = `${Date.now()}.000200`;
    const base = {
      rationale: null,
      channel_id: channelId,
      channel_name: 'msgsync',
      decided_by: 'U1',
      permalink: null,
      confidence: 0.95,
      is_private: 0,
    };

    const a = await addDecision({ ...base, message_ts: ts1, statement: 'We are standardizing on Postgres.' });
    const b = await addDecision({ ...base, message_ts: ts1, statement: 'Hiring is frozen until Q3.' });
    const c = await addDecision({ ...base, message_ts: ts2, statement: 'The status page moves to Instatus.' });

    const forTs1 = await listDecisionsByMessage(channelId, ts1);
    const ids1 = new Set(forTs1.map((d) => d.id));
    assert.strictEqual(forTs1.length, 2, 'both decisions from ts1 are returned');
    assert.ok(ids1.has(a.id) && ids1.has(b.id), 'returns exactly the two ts1 rows');
    assert.ok(!ids1.has(c.id), 'does not leak the ts2 row');

    const forTs2 = await listDecisionsByMessage(channelId, ts2);
    assert.strictEqual(forTs2.length, 1);
    assert.strictEqual(forTs2[0].id, c.id);

    // A message that produced nothing returns an empty array (cheap no-op path).
    assert.deepStrictEqual(await listDecisionsByMessage(channelId, `${Date.now()}.999999`), []);
  });
});

describe('retireDecision', () => {
  it('sets status to superseded and is idempotent', async () => {
    const channelId = `C_RETIRE_${randomUUID()}`;
    const ts = `${Date.now()}.000300`;
    const d = await addDecision({
      statement: 'Deploys move to weekly.',
      rationale: null,
      channel_id: channelId,
      channel_name: 'retire',
      decided_by: 'U1',
      message_ts: ts,
      permalink: null,
      confidence: 0.9,
      is_private: 0,
    });
    assert.strictEqual((await getDecision(d.id))?.status, 'active');

    await retireDecision(d.id, 'source message deleted');
    assert.strictEqual((await getDecision(d.id))?.status, 'superseded');

    // Re-retiring stays superseded (no throw, no status flip).
    await retireDecision(d.id, 'again');
    assert.strictEqual((await getDecision(d.id))?.status, 'superseded');
  });
});

describe('diffStatements', () => {
  it('partitions kept / retired / added under normalization', () => {
    // "Use Postgres" survives despite casing + trailing-punctuation differences;
    // the Friday ship is gone; freezing hiring is new.
    const before = ['We ship Friday.', 'Use Postgres'];
    const after = ['use postgres!!', 'Freeze hiring'];

    const { kept, retired, added } = diffStatements(before, after);

    assert.deepStrictEqual(kept, ['Use Postgres'], 'kept keeps the before-side original casing');
    assert.deepStrictEqual(retired, ['We ship Friday.']);
    assert.deepStrictEqual(added, ['Freeze hiring']);
  });

  it('all retired when after is empty; all added when before is empty', () => {
    assert.deepStrictEqual(diffStatements(['A', 'B'], []), { kept: [], retired: ['A', 'B'], added: [] });
    assert.deepStrictEqual(diffStatements([], ['A', 'B']), { kept: [], retired: [], added: ['A', 'B'] });
  });

  it('collapses duplicates within a side and tolerates non-array/blank input', () => {
    // Two normalized-identical before entries collapse to one; blank drops out.
    const { kept, retired, added } = diffStatements(['Ship it.', 'ship it', ''], ['Ship it']);
    assert.deepStrictEqual(kept, ['Ship it.']);
    assert.deepStrictEqual(retired, []);
    assert.deepStrictEqual(added, []);

    // @ts-expect-error — exercising the defensive non-array guard.
    assert.deepStrictEqual(diffStatements(null, undefined), { kept: [], retired: [], added: [] });
  });
});
