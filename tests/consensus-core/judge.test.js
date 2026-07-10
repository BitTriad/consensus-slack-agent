import assert from 'node:assert';
import { describe, it } from 'node:test';

import { extractJson, firstDecisionLegacyShape, normalizeDecisions } from '../../consensus-core/judge.js';

describe('classifier array parsing (normalizeDecisions)', () => {
  it('parses a well-formed decisions array', () => {
    const parsed = {
      decisions: [
        { statement: 'Standardizing on Postgres', rationale: 'ops simplicity', confidence: 0.9 },
        { statement: 'Freezing hiring till Q3', rationale: null, confidence: 0.8 },
      ],
    };
    const out = normalizeDecisions(parsed);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], {
      statement: 'Standardizing on Postgres',
      rationale: 'ops simplicity',
      confidence: 0.9,
    });
    assert.strictEqual(out[1].rationale, null);
  });

  it('malformed / non-JSON output → [] (via extractJson + normalize)', () => {
    assert.deepStrictEqual(normalizeDecisions(extractJson('')), []);
    assert.deepStrictEqual(normalizeDecisions(extractJson('no json here at all')), []);
    assert.deepStrictEqual(normalizeDecisions(extractJson('{"decisions": [')), []); // unbalanced
  });

  it('malformed shapes → []', () => {
    assert.deepStrictEqual(normalizeDecisions(null), []);
    assert.deepStrictEqual(normalizeDecisions(undefined), []);
    assert.deepStrictEqual(normalizeDecisions({}), []);
    assert.deepStrictEqual(normalizeDecisions({ decisions: 'nope' }), []);
    assert.deepStrictEqual(normalizeDecisions({ decisions: {} }), []);
  });

  it('drops entries without a usable statement', () => {
    const parsed = {
      decisions: [
        { statement: '   ', confidence: 0.9 },
        { rationale: 'no statement', confidence: 0.9 },
        'garbage',
        null,
        { statement: 'Real decision', confidence: 0.9 },
      ],
    };
    const out = normalizeDecisions(parsed);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].statement, 'Real decision');
  });

  it('caps at 5 decisions (extras ignored)', () => {
    const parsed = {
      decisions: Array.from({ length: 8 }, (_, i) => ({
        statement: `Decision ${i + 1}`,
        confidence: 0.9,
      })),
    };
    const out = normalizeDecisions(parsed);
    assert.strictEqual(out.length, 5);
    assert.strictEqual(out[0].statement, 'Decision 1');
    assert.strictEqual(out[4].statement, 'Decision 5');
  });

  it('defaults non-numeric confidence to 0 and blank rationale to null', () => {
    const out = normalizeDecisions({
      decisions: [{ statement: 'X', rationale: '   ', confidence: 'high' }],
    });
    assert.deepStrictEqual(out, [{ statement: 'X', rationale: null, confidence: 0 }]);
  });

  it('dedupes entries that normalize to the same statement, keeping the highest confidence', () => {
    const out = normalizeDecisions({
      decisions: [
        { statement: 'Docs are moving to Docusaurus', rationale: null, confidence: 0.8 },
        { statement: 'docs are moving to docusaurus.', rationale: 'clarity', confidence: 0.92 },
        { statement: '  Docs are moving   to Docusaurus!!! ', rationale: null, confidence: 0.5 },
      ],
    });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      statement: 'docs are moving to docusaurus.',
      rationale: 'clarity',
      confidence: 0.92,
    });
  });

  it('keeps DISTINCT decisions from the same message separate', () => {
    const out = normalizeDecisions({
      decisions: [
        { statement: 'Docs are moving to Docusaurus', rationale: null, confidence: 0.9 },
        { statement: 'Daily standups go async on Mondays', rationale: null, confidence: 0.88 },
      ],
    });
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(
      out.map((d) => d.statement),
      ['Docs are moving to Docusaurus', 'Daily standups go async on Mondays'],
    );
  });

  it('dedup runs BEFORE the cap so duplicates do not consume the cap budget', () => {
    const out = normalizeDecisions({
      decisions: [
        { statement: 'Dupe', confidence: 0.9 },
        { statement: 'dupe.', confidence: 0.9 },
        ...Array.from({ length: 6 }, (_, i) => ({ statement: `Decision ${i + 1}`, confidence: 0.9 })),
      ],
    });
    // 1 (deduped) + 6 distinct = 7 unique → capped at 5.
    assert.strictEqual(out.length, 5);
    assert.strictEqual(out[0].statement, 'Dupe');
    assert.strictEqual(out[4].statement, 'Decision 4');
  });
});

describe('legacy wrapper shape (firstDecisionLegacyShape)', () => {
  it('empty array → no-decision default', () => {
    assert.deepStrictEqual(firstDecisionLegacyShape([]), {
      isDecision: false,
      statement: null,
      rationale: null,
      confidence: 0,
    });
    assert.deepStrictEqual(firstDecisionLegacyShape(undefined), {
      isDecision: false,
      statement: null,
      rationale: null,
      confidence: 0,
    });
  });

  it('non-empty → first decision in legacy shape', () => {
    const out = firstDecisionLegacyShape([
      { statement: 'Ship Friday', rationale: 'ready', confidence: 0.95 },
      { statement: 'Second decision', rationale: null, confidence: 0.8 },
    ]);
    assert.deepStrictEqual(out, {
      isDecision: true,
      statement: 'Ship Friday',
      rationale: 'ready',
      confidence: 0.95,
    });
  });

  it('preserves the legacy key set exactly', () => {
    const out = firstDecisionLegacyShape([{ statement: 'X', rationale: null, confidence: 0.7 }]);
    assert.deepStrictEqual(Object.keys(out).sort(), ['confidence', 'isDecision', 'rationale', 'statement']);
  });
});
