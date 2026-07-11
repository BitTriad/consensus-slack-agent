import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  capturesAllowedToday,
  checkRateWindow,
  isQueueFull,
  looksLikeQuestion,
  parseUntilDate,
  pruneAlerted,
} from '../../consensus-core/pipeline.js';

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

describe('parseUntilDate (cheap capture-path expiry)', () => {
  it('extracts an ISO date trailing an until/through/expires keyword', () => {
    assert.strictEqual(parseUntilDate('Hiring is frozen until 2026-09-30.'), '2026-09-30T23:59:59.999Z');
    assert.strictEqual(parseUntilDate('Discount valid through 2026-12-31'), '2026-12-31T23:59:59.999Z');
    assert.strictEqual(parseUntilDate('This policy expires on 2027-01-15'), '2027-01-15T23:59:59.999Z');
  });

  it('returns null when there is no trivial "until <ISO date>" (no LLM guessing)', () => {
    assert.strictEqual(parseUntilDate('We are standardizing on Postgres.'), null);
    assert.strictEqual(parseUntilDate('Freeze hiring until the end of the quarter.'), null);
    assert.strictEqual(parseUntilDate(''), null);
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

describe('capturesAllowedToday (daily per-user capture cap)', () => {
  it('allows the full batch when the author is well under the cap', () => {
    // Author has 0 today, wants 3, cap 20 → all 3 allowed.
    assert.strictEqual(capturesAllowedToday(0, 3), 3);
    assert.strictEqual(capturesAllowedToday(5, 4), 4);
  });

  it('allows only the remaining slots when the batch would cross the cap', () => {
    // 18 already today, wants 5, cap 20 → only 2 fit.
    assert.strictEqual(capturesAllowedToday(18, 5), 2);
    // Exactly at the boundary: 19 today, wants 3 → 1 fits.
    assert.strictEqual(capturesAllowedToday(19, 3), 1);
  });

  it('allows nothing once the author is at or over the cap', () => {
    assert.strictEqual(capturesAllowedToday(20, 4), 0);
    assert.strictEqual(capturesAllowedToday(25, 4), 0); // over cap never goes negative
  });

  it('honors a custom cap and tolerates non-numeric input', () => {
    assert.strictEqual(capturesAllowedToday(2, 5, 3), 1);
    assert.strictEqual(capturesAllowedToday(/** @type {any} */ (undefined), 3, 3), 3);
    assert.strictEqual(capturesAllowedToday(1, /** @type {any} */ (null), 3), 0);
  });
});

describe('pruneAlerted (self-pruning, bounded alert memory)', () => {
  it('adds the key and drops entries from other days', () => {
    const set = new Set(['u1:d1:2026-07-10', 'u2:d2:2026-07-09']);
    pruneAlerted(set, 'u3:d3:2026-07-11', '2026-07-11');
    // Only today's keys survive (plus the freshly added one).
    assert.deepStrictEqual([...set].sort(), ['u3:d3:2026-07-11']);
  });

  it('keeps multiple same-day keys', () => {
    const set = new Set(['u1:d1:2026-07-11']);
    pruneAlerted(set, 'u2:d2:2026-07-11', '2026-07-11');
    assert.strictEqual(set.size, 2);
    assert.ok(set.has('u1:d1:2026-07-11'));
    assert.ok(set.has('u2:d2:2026-07-11'));
  });

  it('caps total size, evicting oldest (insertion order)', () => {
    const set = new Set();
    for (let i = 0; i < 5; i += 1) pruneAlerted(set, `u:d${i}:2026-07-11`, '2026-07-11', 3);
    // Cap 3 → only the 3 most-recently-added remain; oldest evicted.
    assert.strictEqual(set.size, 3);
    assert.deepStrictEqual([...set], ['u:d2:2026-07-11', 'u:d3:2026-07-11', 'u:d4:2026-07-11']);
  });

  it('is idempotent for a repeated same-day key', () => {
    const set = new Set(['u1:d1:2026-07-11']);
    pruneAlerted(set, 'u1:d1:2026-07-11', '2026-07-11');
    assert.strictEqual(set.size, 1);
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
