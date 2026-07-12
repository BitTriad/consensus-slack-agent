/**
 * Seed the decision ledger from seed/seed-decisions.json when the ledger is
 * empty (e.g. a fresh MongoDB database, or a cloud runner with no cached
 * consensus.db). Idempotent against whatever backend is active (MongoDB when
 * MONGODB_URI is set, else SQLite/JSON): it skips entirely when the ledger
 * already has any rows, and addDecision itself ignores duplicates on
 * (channel_id, message_ts, statement).
 *
 * The ledger API is async (the MongoDB driver is async), so this uses top-level
 * await and an explicit process.exit so an open MongoDB connection can't keep
 * the child process (spawned by start-render.mjs) alive.
 */
import { readFileSync } from 'node:fs';
import { addDecision, dismissDecision, listDecisions, supersede } from '../consensus-core/ledger.js';

const existing = await listDecisions({ limit: 1 });
if (existing.length > 0) {
  console.log('[seed] ledger already populated — skipping');
  process.exit(0);
}

const rows = JSON.parse(readFileSync(new URL('../seed/seed-decisions.json', import.meta.url), 'utf-8'));
let added = 0;
for (const r of rows) {
  const d = await addDecision({
    statement: r.statement,
    rationale: r.rationale ?? null,
    channel_id: r.channel_id,
    channel_name: r.channel_name ?? null,
    decided_by: r.decided_by ?? null,
    message_ts: r.message_ts,
    permalink: r.permalink ?? null,
    confidence: r.confidence ?? 0.9,
    is_private: r.is_private ? 1 : 0,
  });
  // Map both the legacy ('dismissed') and new ('rejected') seed vocab.
  if (r.status === 'superseded') await supersede(d.id, null);
  else if (r.status === 'dismissed' || r.status === 'rejected') await dismissDecision(d.id);
  added++;
}
console.log(`[seed] seeded ${added} decisions`);
// Explicit exit: a live MongoDB client would otherwise keep this process open.
process.exit(0);
