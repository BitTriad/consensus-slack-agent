import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { MongoMemoryServer } from 'mongodb-memory-server';
import { createJsonBackend, createMongoBackend, createSqliteBackend } from '../../consensus-core/ledger.js';

const require = createRequire(import.meta.url);

/**
 * Build every available backend on isolated storage so the parity suite touches
 * no shared state. The JSON and SQLite backends are synchronous; the MongoDB
 * backend (spun up in-process via mongodb-memory-server — NO external Atlas
 * connection required) is async. Every method is `await`ed below, which is a
 * no-op on the synchronous backends, so the SAME assertions run against all
 * three.
 */
async function makeBackends() {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-ledger-'));
  const json = createJsonBackend(join(dir, 'ledger.json'));
  /** @type {ReturnType<typeof createSqliteBackend> | null} */
  let sqlite = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) sqlite = createSqliteBackend(DatabaseSync, join(dir, 'ledger.db'));
  } catch {
    // node:sqlite unavailable in this runtime — the other backends still run.
  }
  /** @type {MongoMemoryServer | null} */
  let mongoServer = null;
  /** @type {ReturnType<typeof createMongoBackend> | null} */
  let mongo = null;
  try {
    mongoServer = await MongoMemoryServer.create();
    mongo = createMongoBackend({ uri: mongoServer.getUri(), dbName: 'consensus_test' });
    await mongo.connect?.();
  } catch {
    // mongodb-memory-server could not start (e.g. no binary) — skip Mongo parity.
    mongoServer = null;
    mongo = null;
  }
  return {
    dir,
    mongoServer,
    mongo,
    backends: /** @type {[string, any][]} */ ([
      ['json', json],
      ...(sqlite ? [['sqlite', sqlite]] : []),
      ...(mongo ? [['mongo', mongo]] : []),
    ]),
  };
}

const { dir, mongoServer, mongo, backends } = await makeBackends();
after(async () => {
  await mongo?.close?.();
  await mongoServer?.stop();
  rmSync(dir, { recursive: true, force: true });
});

for (const [name, backend] of backends) {
  describe(`ledger backend parity: ${name}`, () => {
    it('stores the new governance/scope fields on addDecision', async () => {
      const d = await backend.addDecision({
        id: `d-${name}-fields`,
        statement: 'Standardize on Postgres.',
        channel_id: 'C1',
        status: 'proposed',
        team_label: 'Platform',
        applies_to: 'all services',
        expires_at: '2027-01-01T00:00:00.000Z',
        owner_user_id: 'U_OWNER',
        authority_level: 'policy',
      });
      assert.strictEqual(d.status, 'proposed');
      assert.strictEqual(d.team_label, 'Platform');
      assert.strictEqual(d.applies_to, 'all services');
      assert.strictEqual(d.expires_at, '2027-01-01T00:00:00.000Z');
      assert.strictEqual(d.owner_user_id, 'U_OWNER');
      assert.strictEqual(d.authority_level, 'policy');

      const round = await backend.getDecision(d.id);
      assert.strictEqual(round.owner_user_id, 'U_OWNER');
      assert.strictEqual(round.authority_level, 'policy');
    });

    it('defaults the new fields to null when omitted', async () => {
      const d = await backend.addDecision({ id: `d-${name}-nulls`, statement: 'x'.repeat(5), channel_id: 'C1' });
      assert.strictEqual(d.team_label, null);
      assert.strictEqual(d.applies_to, null);
      assert.strictEqual(d.expires_at, null);
      assert.strictEqual(d.owner_user_id, null);
      assert.strictEqual(d.authority_level, null);
      assert.strictEqual(d.exception_of, null);
    });

    it('persists exception_of (parent link) and defaults it to null', async () => {
      // An exception carving out of an explicit parent.
      const child = await backend.addDecision({
        id: `d-${name}-exc`,
        statement: 'EU tenants keep data in-region.',
        channel_id: 'C1',
        status: 'exception',
        applies_to: 'EU tenants',
        exception_of: `d-${name}-parent`,
      });
      assert.strictEqual(child.exception_of, `d-${name}-parent`);
      assert.strictEqual(child.applies_to, 'EU tenants');
      assert.strictEqual((await backend.getDecision(child.id)).exception_of, `d-${name}-parent`);

      // A self-exception (the Phase-1 handler path) leaves exception_of null.
      const self = await backend.addDecision({
        id: `d-${name}-selfexc`,
        statement: 'This standing item is a carve-out.',
        channel_id: 'C1',
        status: 'exception',
      });
      assert.strictEqual(self.exception_of, null);
      assert.strictEqual((await backend.getDecision(self.id)).exception_of, null);
    });

    it('setStatus persists confirmed / rejected / exception transitions', async () => {
      const id = `d-${name}-transitions`;
      await backend.addDecision({ id, statement: 'Deploys move to weekly.', channel_id: 'C1', status: 'proposed' });
      assert.strictEqual((await backend.getDecision(id)).status, 'proposed');

      await backend.setStatus(id, 'confirmed');
      assert.strictEqual((await backend.getDecision(id)).status, 'confirmed');

      await backend.setStatus(id, 'exception');
      assert.strictEqual((await backend.getDecision(id)).status, 'exception');

      await backend.setStatus(id, 'rejected');
      assert.strictEqual((await backend.getDecision(id)).status, 'rejected');
    });

    it('dismiss sets status to rejected (new vocabulary)', async () => {
      const id = `d-${name}-dismiss`;
      await backend.addDecision({ id, statement: 'Not really a decision.', channel_id: 'C1', status: 'active' });
      await backend.dismiss(id);
      assert.strictEqual((await backend.getDecision(id)).status, 'rejected');
    });

    it('listDecisions accepts an array of statuses (IN filter)', async () => {
      const ch = `C_LIST_${name}`;
      await backend.addDecision({ id: `d-${name}-a`, statement: 'Active one.', channel_id: ch, status: 'active' });
      await backend.addDecision({
        id: `d-${name}-c`,
        statement: 'Confirmed one.',
        channel_id: ch,
        status: 'confirmed',
      });
      await backend.addDecision({ id: `d-${name}-p`, statement: 'Proposed one.', channel_id: ch, status: 'proposed' });

      const enforceable = (await backend.listDecisions({ status: ['active', 'confirmed'], limit: 100 })).filter(
        (/** @type {any} */ r) => r.channel_id === ch,
      );
      const statuses = new Set(enforceable.map((/** @type {any} */ r) => r.status));
      assert.ok(statuses.has('active') && statuses.has('confirmed'));
      assert.ok(!statuses.has('proposed'), 'proposed must be excluded from the enforceable list');
    });
  });
}

describe('JSON backend migrate-on-load: legacy dismissed → rejected', () => {
  it('maps a legacy dismissed row to rejected and backfills new fields', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'consensus-migrate-'));
    const path = join(dir2, 'legacy.json');
    // A file written by the pre-governance build: status 'dismissed', no new fields.
    writeFileSync(
      path,
      JSON.stringify({
        decisions: [
          { id: 'legacy1', statement: 'Old rejected capture.', channel_id: 'C1', status: 'dismissed' },
          { id: 'legacy2', statement: 'Old active decision.', channel_id: 'C1', status: 'active' },
        ],
        dismissals: [],
        events: [],
        auditDismissals: [],
      }),
    );

    const backend = createJsonBackend(path);
    const rejected = backend.getDecision('legacy1');
    assert.strictEqual(rejected.status, 'rejected', 'legacy dismissed maps to rejected');
    assert.strictEqual(rejected.team_label, null, 'missing new fields backfill to null');
    assert.strictEqual(rejected.owner_user_id, null);
    assert.strictEqual(rejected.exception_of, null, 'exception_of backfills to null on load');

    assert.strictEqual(backend.getDecision('legacy2').status, 'active', 'active is unchanged');

    rmSync(dir2, { recursive: true, force: true });
  });
});
