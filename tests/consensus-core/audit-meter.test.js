import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  _resetAuditMeter,
  composeAuditMessage,
  releaseAudit,
  tryAcquireAudit,
} from '../../consensus-core/audit-report.js';

describe('audit metering', () => {
  afterEach(() => _resetAuditMeter());

  const T0 = 1_000_000; // well past the initial cooldown from lastFinished=0

  it('grants the first acquire and refuses a second while in-flight', () => {
    assert.strictEqual(tryAcquireAudit(T0), true);
    // A second attempt while the first is still in-flight is refused.
    assert.strictEqual(tryAcquireAudit(T0 + 500), false);
  });

  it('enforces a 60s cooldown after release, then re-allows', () => {
    assert.strictEqual(tryAcquireAudit(T0), true);
    releaseAudit(T0);
    // Within the cooldown window → refused.
    assert.strictEqual(tryAcquireAudit(T0 + 30_000), false);
    // At/after the cooldown → allowed again.
    assert.strictEqual(tryAcquireAudit(T0 + 60_000), true);
  });
});

describe('public audit report never leaks private-conflict counts', () => {
  // runAuditForViewer scrubs a publicOnly report so hiddenPrivateCount is 0 and
  // totalConfirmed equals visibleConfirmed.length. composeAuditMessage must then
  // render nothing that hints private-channel conflicts exist. These assertions
  // lock that observable contract (the shaping itself lives in runAuditForViewer,
  // which needs the LLM audit engine and so is not unit-tested directly).

  it('renders a clean all-clear when nothing is publicly visible (hidden pairs suppressed)', () => {
    // A publicOnly report where every confirmed pair touched a private channel:
    // both counts collapse to 0, so the viewer sees an unqualified all-clear.
    const message = composeAuditMessage({
      checkedCount: 5,
      visibleConfirmed: [],
      hiddenPrivateCount: 0,
      totalConfirmed: 0,
    });
    assert.match(message.text, /no latent contradictions/);
    assert.strictEqual(message.blocks, undefined);
    assert.doesNotMatch(message.text, /🔒|private|additional conflict/i);
  });

  it('omits the 🔒 hidden-conflicts line for a public report with visible conflicts', () => {
    const a = { id: 'a', statement: 'Use Postgres', is_private: false };
    const b = { id: 'b', statement: 'Use MySQL', is_private: false };
    const message = composeAuditMessage({
      checkedCount: 8,
      visibleConfirmed: [{ a, b, reasoning: 'direct DB contradiction' }],
      hiddenPrivateCount: 0,
      totalConfirmed: 1,
    });
    const rendered = JSON.stringify(message.blocks);
    assert.doesNotMatch(rendered, /🔒/);
    assert.doesNotMatch(rendered, /additional conflict/i);
  });
});
