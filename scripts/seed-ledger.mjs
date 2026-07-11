/**
 * Seed the decision ledger from seed/seed-decisions.json when the ledger is
 * empty (e.g. a fresh cloud runner with no cached consensus.db). Idempotent:
 * addDecision ignores duplicates on (channel_id, message_ts).
 */
import { readFileSync } from 'node:fs';
import { addDecision, dismissDecision, listDecisions, supersede } from '../consensus-core/ledger.js';

const existing = listDecisions({ limit: 1 });
if (existing.length > 0) {
  console.log('[seed] ledger already populated — skipping');
  process.exit(0);
}

const rows = JSON.parse(readFileSync(new URL('../seed/seed-decisions.json', import.meta.url), 'utf-8'));
let added = 0;
for (const r of rows) {
  const d = addDecision({
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
  if (r.status === 'superseded') supersede(d.id, null);
  else if (r.status === 'dismissed' || r.status === 'rejected') dismissDecision(d.id);
  added++;
}
console.log(`[seed] seeded ${added} decisions`);
