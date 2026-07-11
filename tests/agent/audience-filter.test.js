import assert from 'node:assert';
import { describe, it } from 'node:test';

import { audiencePreFilter } from '../../agent/agent.js';

describe('audiencePreFilter', () => {
  it('always shows public decisions to any audience', () => {
    assert.strictEqual(audiencePreFilter(0, 'channel'), true);
    assert.strictEqual(audiencePreFilter(0, 'dm'), true);
    assert.strictEqual(audiencePreFilter(false, 'channel'), true);
  });

  it('hides private decisions outright from a channel audience (fail closed)', () => {
    assert.strictEqual(audiencePreFilter(1, 'channel'), false);
    assert.strictEqual(audiencePreFilter(true, 'channel'), false);
  });

  it('defers a private decision to a per-user membership check only for a dm audience', () => {
    assert.strictEqual(audiencePreFilter(1, 'dm'), null);
  });
});
