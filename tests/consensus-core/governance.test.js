import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  canConfirm,
  captureStatusForChannel,
  isEnforceable,
  isExpired,
  isStrict,
  isTrustedChannel,
  mapLegacyStatus,
  materializeExpired,
  narrowsScope,
  parseIdList,
} from '../../consensus-core/governance.js';

describe('parseIdList', () => {
  it('trims, drops blanks, and dedupes', () => {
    const set = parseIdList(' C1 , C2 ,, C1 , ');
    assert.deepStrictEqual([...set].sort(), ['C1', 'C2']);
  });

  it('is empty for undefined/empty input', () => {
    assert.strictEqual(parseIdList(undefined).size, 0);
    assert.strictEqual(parseIdList('').size, 0);
    assert.strictEqual(parseIdList('   ').size, 0);
  });
});

describe('isTrustedChannel', () => {
  it('trusts EVERY channel when the env var is unset entirely (demo fallback)', () => {
    assert.strictEqual(isTrustedChannel('C_ANY', {}), true);
    assert.strictEqual(isTrustedChannel('C_OTHER', {}), true);
  });

  it('trusts only the listed channels when the var is set', () => {
    const env = { CONSENSUS_TRUSTED_CHANNELS: 'C_TRUSTED, C_ALSO' };
    assert.strictEqual(isTrustedChannel('C_TRUSTED', env), true);
    assert.strictEqual(isTrustedChannel('C_ALSO', env), true);
    assert.strictEqual(isTrustedChannel('C_UNTRUSTED', env), false);
  });

  it('trusts NOTHING when set to an explicit empty string (lockdown)', () => {
    assert.strictEqual(isTrustedChannel('C_ANY', { CONSENSUS_TRUSTED_CHANNELS: '' }), false);
  });
});

describe('captureStatusForChannel', () => {
  it('is active for a trusted channel, proposed otherwise', () => {
    const env = { CONSENSUS_TRUSTED_CHANNELS: 'C_TRUSTED' };
    assert.strictEqual(captureStatusForChannel('C_TRUSTED', env), 'active');
    assert.strictEqual(captureStatusForChannel('C_OTHER', env), 'proposed');
  });

  it('is active everywhere under the unset fallback', () => {
    assert.strictEqual(captureStatusForChannel('C_ANY', {}), 'active');
  });
});

describe('canConfirm', () => {
  it('authorizes everyone when the authority list is unset or empty (fallback)', () => {
    assert.strictEqual(canConfirm('U_ANY', {}), true);
    assert.strictEqual(canConfirm('U_ANY', { CONSENSUS_AUTHORITY_USERS: '' }), true);
    assert.strictEqual(canConfirm(null, {}), true);
  });

  it('authorizes only listed users when the list is set', () => {
    const env = { CONSENSUS_AUTHORITY_USERS: 'U_ADMIN, U_LEAD' };
    assert.strictEqual(canConfirm('U_ADMIN', env), true);
    assert.strictEqual(canConfirm('U_LEAD', env), true);
    assert.strictEqual(canConfirm('U_RANDOM', env), false);
    assert.strictEqual(canConfirm(null, env), false);
  });
});

describe('isExpired / isEnforceable', () => {
  const NOW = Date.parse('2026-07-11T00:00:00.000Z');

  it('a null/absent expiry never expires', () => {
    assert.strictEqual(isExpired({ expires_at: null }, NOW), false);
    assert.strictEqual(isExpired({ expires_at: undefined }, NOW), false);
    assert.strictEqual(isExpired({ expires_at: 'not-a-date' }, NOW), false);
  });

  it('an expiry at/before now is expired; a future expiry is not', () => {
    assert.strictEqual(isExpired({ expires_at: '2026-07-10T00:00:00.000Z' }, NOW), true);
    assert.strictEqual(isExpired({ expires_at: '2999-01-01T00:00:00.000Z' }, NOW), false);
  });

  it('active and confirmed are enforceable; every other status is not', () => {
    assert.strictEqual(isEnforceable({ status: 'active', expires_at: null }, NOW), true);
    assert.strictEqual(isEnforceable({ status: 'confirmed', expires_at: null }, NOW), true);
    for (const status of ['proposed', 'exception', 'superseded', 'expired', 'rejected']) {
      assert.strictEqual(isEnforceable({ status, expires_at: null }, NOW), false, `${status} must not be enforceable`);
    }
  });

  it('an expired active decision is NOT enforceable', () => {
    assert.strictEqual(isEnforceable({ status: 'active', expires_at: '2026-07-01T00:00:00.000Z' }, NOW), false);
    // …but the same decision was enforceable before its expiry.
    const before = Date.parse('2026-06-01T00:00:00.000Z');
    assert.strictEqual(isEnforceable({ status: 'active', expires_at: '2026-07-01T00:00:00.000Z' }, before), true);
  });

  it('tolerates null/undefined decisions', () => {
    assert.strictEqual(isEnforceable(null, NOW), false);
    assert.strictEqual(isEnforceable(undefined, NOW), false);
  });
});

describe('isStrict', () => {
  it('is false when unset or explicitly falsey (lenient/demo default)', () => {
    assert.strictEqual(isStrict({}), false);
    assert.strictEqual(isStrict({ CONSENSUS_GOVERNANCE_STRICT: '' }), false);
    assert.strictEqual(isStrict({ CONSENSUS_GOVERNANCE_STRICT: 'false' }), false);
    assert.strictEqual(isStrict({ CONSENSUS_GOVERNANCE_STRICT: '0' }), false);
    assert.strictEqual(isStrict({ CONSENSUS_GOVERNANCE_STRICT: 'nope' }), false);
  });

  it('is true for the usual truthy spellings (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On', ' true ']) {
      assert.strictEqual(isStrict({ CONSENSUS_GOVERNANCE_STRICT: v }), true, `${v} should be strict`);
    }
  });
});

describe('strict mode — trusted channels', () => {
  it('lenient (default): unset trusted list trusts EVERY channel', () => {
    assert.strictEqual(isTrustedChannel('C_ANY', {}), true);
    assert.strictEqual(captureStatusForChannel('C_ANY', {}), 'active');
  });

  it('strict: unset trusted list trusts NO channel (captures are proposed)', () => {
    const env = { CONSENSUS_GOVERNANCE_STRICT: 'true' };
    assert.strictEqual(isTrustedChannel('C_ANY', env), false);
    assert.strictEqual(isTrustedChannel('C_OTHER', env), false);
    assert.strictEqual(captureStatusForChannel('C_ANY', env), 'proposed');
  });

  it('strict: an explicitly listed channel is still trusted', () => {
    const env = { CONSENSUS_GOVERNANCE_STRICT: '1', CONSENSUS_TRUSTED_CHANNELS: 'C_TRUSTED' };
    assert.strictEqual(isTrustedChannel('C_TRUSTED', env), true);
    assert.strictEqual(isTrustedChannel('C_OTHER', env), false);
    assert.strictEqual(captureStatusForChannel('C_TRUSTED', env), 'active');
  });

  it('set-but-empty is a lockdown in BOTH modes', () => {
    assert.strictEqual(isTrustedChannel('C_ANY', { CONSENSUS_TRUSTED_CHANNELS: '' }), false);
    assert.strictEqual(
      isTrustedChannel('C_ANY', { CONSENSUS_TRUSTED_CHANNELS: '', CONSENSUS_GOVERNANCE_STRICT: 'true' }),
      false,
    );
  });
});

describe('strict mode — confirm authority', () => {
  it('lenient (default): unset/empty authority list authorizes EVERYONE', () => {
    assert.strictEqual(canConfirm('U_ANY', {}), true);
    assert.strictEqual(canConfirm('U_ANY', { CONSENSUS_AUTHORITY_USERS: '' }), true);
    assert.strictEqual(canConfirm(null, {}), true);
  });

  it('strict: unset/empty authority list authorizes NO ONE', () => {
    assert.strictEqual(canConfirm('U_ANY', { CONSENSUS_GOVERNANCE_STRICT: 'true' }), false);
    assert.strictEqual(
      canConfirm('U_ANY', { CONSENSUS_GOVERNANCE_STRICT: 'true', CONSENSUS_AUTHORITY_USERS: '' }),
      false,
    );
    assert.strictEqual(canConfirm(null, { CONSENSUS_GOVERNANCE_STRICT: 'true' }), false);
  });

  it('strict: an explicitly listed user is still authorized', () => {
    const env = { CONSENSUS_GOVERNANCE_STRICT: '1', CONSENSUS_AUTHORITY_USERS: 'U_ADMIN' };
    assert.strictEqual(canConfirm('U_ADMIN', env), true);
    assert.strictEqual(canConfirm('U_RANDOM', env), false);
  });
});

describe('narrowsScope (Phase-1 conservative stub)', () => {
  it('returns false — Phase 1 does not model parent-linked scope narrowing', () => {
    const parent = { id: 'p1', applies_to: 'all tenants' };
    const exception = { status: 'exception', exception_of: null, applies_to: 'EU tenants' };
    assert.strictEqual(narrowsScope(exception, parent), false);
    // Even a (future-shaped) parent-linked exception is conservatively false today.
    assert.strictEqual(narrowsScope({ ...exception, exception_of: 'p1' }, parent), false);
    assert.strictEqual(narrowsScope(null, null), false);
  });
});

describe('materializeExpired', () => {
  const NOW = Date.parse('2026-07-11T00:00:00.000Z');
  const past = '2026-07-01T00:00:00.000Z';
  const future = '2999-01-01T00:00:00.000Z';

  it('returns exactly the past-expiry active/confirmed ids', () => {
    const decisions = [
      { id: 'a', status: 'active', expires_at: past }, // ← flip
      { id: 'c', status: 'confirmed', expires_at: past }, // ← flip
      { id: 'active-future', status: 'active', expires_at: future }, // not yet
      { id: 'active-none', status: 'active', expires_at: null }, // never
      { id: 'proposed-past', status: 'proposed', expires_at: past }, // not enforceable
      { id: 'exception-past', status: 'exception', expires_at: past }, // not enforceable
      { id: 'superseded-past', status: 'superseded', expires_at: past },
      { id: 'expired-past', status: 'expired', expires_at: past }, // already flipped
    ];
    assert.deepStrictEqual(materializeExpired(decisions, NOW).sort(), ['a', 'c']);
  });

  it('converges: a second pass over the flipped rows returns nothing', () => {
    const flipped = [
      { id: 'a', status: 'expired', expires_at: past },
      { id: 'c', status: 'expired', expires_at: past },
    ];
    assert.deepStrictEqual(materializeExpired(flipped, NOW), []);
  });

  it('tolerates non-array / empty input', () => {
    assert.deepStrictEqual(materializeExpired(/** @type {any} */ (null), NOW), []);
    assert.deepStrictEqual(materializeExpired([], NOW), []);
  });
});

describe('exception is never an alert/audit candidate', () => {
  const NOW = Date.parse('2026-07-11T00:00:00.000Z');
  it('isEnforceable excludes exception regardless of expiry', () => {
    assert.strictEqual(isEnforceable({ status: 'exception', expires_at: null }, NOW), false);
    assert.strictEqual(isEnforceable({ status: 'exception', expires_at: '2999-01-01T00:00:00.000Z' }, NOW), false);
    // materializeExpired also never selects an exception, so a sweep can't resurrect it.
    assert.deepStrictEqual(
      materializeExpired([{ id: 'x', status: 'exception', expires_at: '2026-07-01T00:00:00.000Z' }], NOW),
      [],
    );
  });
});

describe('mapLegacyStatus', () => {
  it('maps only the renamed legacy value and is idempotent', () => {
    assert.strictEqual(mapLegacyStatus('dismissed'), 'rejected');
    assert.strictEqual(mapLegacyStatus('rejected'), 'rejected');
    assert.strictEqual(mapLegacyStatus('active'), 'active');
    assert.strictEqual(mapLegacyStatus('superseded'), 'superseded');
    assert.strictEqual(mapLegacyStatus('proposed'), 'proposed');
    assert.strictEqual(mapLegacyStatus(undefined), 'active');
  });
});
