import assert from 'node:assert';
import { describe, it } from 'node:test';

import { checkRateWindow, isQueueFull, looksLikeQuestion } from '../../consensus-core/pipeline.js';

describe('looksLikeQuestion', () => {
  it('treats a trailing question mark as a question', () => {
    assert.strictEqual(looksLikeQuestion('What if we tried MongoDB?'), true);
    assert.strictEqual(looksLikeQuestion('should we switch to mysql'), true);
  });

  it('does not suppress a decision recap that contains a colon', () => {
    // Regression: "What we decided: …" opens with an interrogative word but is a
    // STATEMENT — the colon marks the recap shape, so it must NOT read as a question.
    assert.strictEqual(looksLikeQuestion('What we decided: standardize on Postgres.'), false);
    assert.strictEqual(looksLikeQuestion('How we handle auth from now on: Auth0 only'), false);
  });

  it('is not a question when there is no interrogative prefix and no "?"', () => {
    assert.strictEqual(looksLikeQuestion('We decided to standardize on Postgres.'), false);
  });
});

describe('checkRateWindow (token bucket)', () => {
  it('allows hits below the cap and prunes entries older than the window', () => {
    const now = 100_000;
    // Two entries inside the window, one stale entry outside it.
    const { allowed, recent } = checkRateWindow([now - 10, now - 20, now - 70_000], now, 60_000, 3);
    assert.strictEqual(allowed, true);
    assert.deepStrictEqual(recent, [now - 10, now - 20]); // stale one dropped
  });

  it('rejects once the in-window count reaches the cap', () => {
    const now = 100_000;
    const { allowed, recent } = checkRateWindow([now - 1, now - 2, now - 3], now, 60_000, 3);
    assert.strictEqual(allowed, false);
    assert.strictEqual(recent.length, 3);
  });

  it('re-allows after entries age out of the window', () => {
    const now = 100_000;
    // All three are older than the 60s window → pruned → allowed again.
    const { allowed, recent } = checkRateWindow([now - 61_000, now - 62_000, now - 63_000], now, 60_000, 3);
    assert.strictEqual(allowed, true);
    assert.deepStrictEqual(recent, []);
  });

  it('tolerates non-array input', () => {
    assert.deepStrictEqual(checkRateWindow(/** @type {any} */ (undefined), 1, 60_000, 3), {
      allowed: true,
      recent: [],
    });
  });
});

describe('isQueueFull (per-channel pending cap)', () => {
  it('allows jobs below the cap and drops at/over it', () => {
    assert.strictEqual(isQueueFull(0), false);
    assert.strictEqual(isQueueFull(19), false); // 20th job still enqueues
    assert.strictEqual(isQueueFull(20), true); // 21st is dropped
    assert.strictEqual(isQueueFull(100), true);
  });

  it('honors a custom cap and tolerates nullish pending', () => {
    assert.strictEqual(isQueueFull(2, 3), false);
    assert.strictEqual(isQueueFull(3, 3), true);
    assert.strictEqual(isQueueFull(/** @type {any} */ (undefined)), false);
  });

  it('drops jobs beyond the cap, and settling frees capacity so later jobs run', () => {
    // Reproduce runQueued's enqueue/settle bookkeeping around the exported gate.
    const CAP = 20;
    let pending = 0;
    const ran = [];
    /** @param {number} id @returns {boolean} enqueued? */
    const enqueue = (id) => {
      if (isQueueFull(pending, CAP)) return false; // dropped: never runs
      pending += 1;
      ran.push(id);
      return true;
    };
    const settle = () => {
      pending -= 1;
    };

    // Fill to the cap: ids 0..19 all enqueue.
    for (let i = 0; i < CAP; i += 1) assert.strictEqual(enqueue(i), true);
    assert.strictEqual(pending, CAP);

    // Next arrivals are dropped and never run.
    assert.strictEqual(enqueue(100), false);
    assert.strictEqual(enqueue(101), false);
    assert.ok(!ran.includes(100));
    assert.ok(!ran.includes(101));

    // A settled job frees exactly one slot; the next arrival then runs.
    settle();
    assert.strictEqual(enqueue(200), true);
    assert.ok(ran.includes(200));
    assert.strictEqual(pending, CAP);
  });
});
