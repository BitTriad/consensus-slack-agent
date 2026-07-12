import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { addDecision, getDecision } from '../../consensus-core/ledger.js';
import { handleCardSupersede, handleConfirm, handleReject } from '../../listeners/actions/consensus-actions.js';

/** Minimal Bolt action-middleware harness capturing ack + respond payloads. */
function makeArgs(userId, decisionId) {
  const responses = [];
  return {
    responses,
    args: {
      ack: async () => {},
      body: { user: { id: userId }, actions: [{ value: decisionId }] },
      respond: async (/** @type {any} */ payload) => {
        responses.push(payload);
      },
      logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    },
  };
}

/** Seed a fresh proposed decision and return its id. */
async function seedProposed() {
  const id = `act-${randomUUID()}`;
  await addDecision({
    id,
    statement: 'Proposed thing.',
    channel_id: 'C_ACT',
    status: 'proposed',
    owner_user_id: 'U_OWNER',
  });
  return id;
}

afterEach(() => {
  delete process.env.CONSENSUS_AUTHORITY_USERS;
});

describe('lifecycle action authority gate', () => {
  it('an unauthorized user cannot Confirm (status unchanged, ephemeral refusal)', async () => {
    process.env.CONSENSUS_AUTHORITY_USERS = 'U_ADMIN';
    const id = await seedProposed();
    const { args, responses } = makeArgs('U_RANDOM', id);

    await handleConfirm(/** @type {any} */ (args));

    assert.strictEqual((await getDecision(id)).status, 'proposed', 'status must not change for an unauthorized click');
    assert.strictEqual(responses.length, 1);
    assert.match(responses[0].text, /authorized decision owner\/admin/i);
    assert.strictEqual(responses[0].replace_original, false);
  });

  it('an authorized user can Confirm (proposed → confirmed)', async () => {
    process.env.CONSENSUS_AUTHORITY_USERS = 'U_ADMIN';
    const id = await seedProposed();
    const { args } = makeArgs('U_ADMIN', id);

    await handleConfirm(/** @type {any} */ (args));

    assert.strictEqual((await getDecision(id)).status, 'confirmed');
  });

  it('an authorized user can Reject (→ rejected)', async () => {
    process.env.CONSENSUS_AUTHORITY_USERS = 'U_ADMIN';
    const id = await seedProposed();
    const { args } = makeArgs('U_ADMIN', id);

    await handleReject(/** @type {any} */ (args));

    assert.strictEqual((await getDecision(id)).status, 'rejected');
  });

  it('an authorized user can Supersede (→ superseded)', async () => {
    process.env.CONSENSUS_AUTHORITY_USERS = 'U_ADMIN';
    const id = await seedProposed();
    const { args } = makeArgs('U_ADMIN', id);

    await handleCardSupersede(/** @type {any} */ (args));

    assert.strictEqual((await getDecision(id)).status, 'superseded');
  });

  it('falls back to authorized-for-all when the authority list is unset', async () => {
    // No CONSENSUS_AUTHORITY_USERS set → any user may confirm (demo fallback).
    const id = await seedProposed();
    const { args } = makeArgs('U_ANYONE', id);

    await handleConfirm(/** @type {any} */ (args));

    assert.strictEqual((await getDecision(id)).status, 'confirmed');
  });
});
