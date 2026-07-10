/**
 * Live evaluation of the decision CLASSIFIER (judge.js `classifyDecisions`).
 *
 * The contradiction judge has its own eval harness; the classifier never did.
 * This exercises messy, real-world input — meeting-notes dumps with several
 * decisions, non-native English, typos, buried decisions, pure discussion,
 * questions, and sarcasm — and checks the CAPTURE COUNT per message.
 *
 * LLM provider: CEREBRAS_API_KEY / GEMINI_API_KEY from env if set (hosted),
 * otherwise the local Claude auth via the Agent SDK (llm.js decides). No live
 * LLM ever runs under `node --test`; this is an explicit, manually-run harness.
 *
 *   node scripts/classify-eval.mjs
 */

import { classifyDecisions } from '../consensus-core/judge.js';

/**
 * @typedef {Object} Case
 * @property {string} id
 * @property {string} label
 * @property {string} text
 * @property {number} expected  Expected number of captured decisions.
 */

/** @type {Case[]} */
const cases = [
  {
    id: 'a',
    label: 'meeting-notes para with exactly 3 decisions',
    text:
      "Recap from today's sync: we're moving all new services to Postgres going forward, " +
      'pricing on the Pro plan is now locked in at $39/month, and hiring is frozen until Q3. ' +
      'Thanks everyone for a productive meeting.',
    expected: 3,
  },
  {
    id: 'b',
    label: 'non-native English single decision',
    text: 'ok team, we has decided we going with weekly deploy from now, no more the daily deploys.',
    expected: 1,
  },
  {
    id: 'c',
    label: 'typo-ridden casual decision',
    text: 'alright its setled — were def gonna swithc the whole app frm REST to graphql, thats teh final call',
    expected: 1,
  },
  {
    id: 'd',
    label: 'decision buried mid-paragraph of chatter',
    text:
      'lol did anyone catch the game last night, absolutely wild finish. anyway my coffee machine broke again ugh. ' +
      'oh also we finalized it — the team is standardizing on TypeScript for all frontend code from now on. ' +
      'btw is it just me or is the office freezing today, someone crank the heat.',
    expected: 1,
  },
  {
    id: 'e',
    label: 'pure discussion, zero decisions',
    text:
      'I think maybe we could consider moving to Postgres at some point? Not sure though. ' +
      'Mongo has been fine for us honestly. Curious what everyone thinks, no strong opinion either way. ' +
      'We should probably talk about it more before committing to anything.',
    expected: 0,
  },
  {
    id: 'f',
    label: 'question about deciding',
    text: 'Should we go with weekly deploys or stick with daily? What do people think we should decide here?',
    expected: 0,
  },
  {
    id: 'g',
    label: 'two decisions + one question mixed in one para',
    text:
      "Couple things from standup: we're deprecating the old v1 API at the end of the month, and the design " +
      'system is now officially locked to the blue/teal palette. Separately — should we also bump the on-call ' +
      'rotation to weekly, or leave it? Not decided on that one yet.',
    expected: 2,
  },
  {
    id: 'h',
    label: 'sarcastic joke decision',
    text: "great news everyone, we've decided to rewrite everything in COBOL lol jk, please don't panic",
    expected: 0,
  },
  {
    id: 'i',
    label: 'hearsay/rumor — not the team’s own settled decision',
    text: 'heard from someone on the platform team that we might be dropping React soon 👀',
    expected: 0,
  },
  {
    id: 'j',
    label: 'self-correction within one message — retracted before it settles',
    text: "we're shipping the migration friday — wait no, scratch that, nothing's decided yet, ignore me",
    expected: 0,
  },
  {
    id: 'k',
    label: 'rumor relayed then personally confirmed as official',
    text: 'people keep saying we’re moving to Linear — and yes I can confirm, it’s official, we’re moving to Linear next sprint',
    expected: 1,
  },
];

// For case (g): the two real decisions, matched loosely by keyword presence.
const G_EXPECTED_TOPICS = [
  { name: 'deprecate v1 API', match: (/** @type {string} */ s) => /v1/i.test(s) && /deprecat/i.test(s) },
  {
    name: 'lock design system to blue/teal palette',
    match: (/** @type {string} */ s) => /(blue|teal|palette|design system)/i.test(s),
  },
];

function provider() {
  if (process.env.CEREBRAS_API_KEY) return `Cerebras (${process.env.CEREBRAS_MODEL || 'zai-glm-4.7'})`;
  if (process.env.GEMINI_API_KEY) return 'Gemini';
  return 'local Claude (Agent SDK)';
}

async function main() {
  console.log(`Classify eval — ${cases.length} messy messages, provider: ${provider()}\n`);

  let passCount = 0;
  const failures = [];

  for (const c of cases) {
    let decisions;
    try {
      decisions = await classifyDecisions(c.text);
    } catch (e) {
      console.log(`[${c.id}] ${c.label}\n    ERROR: ${e?.message || e}\n`);
      failures.push(c.id);
      continue;
    }
    const got = decisions.length;
    const statements = decisions.map((d) => d.statement);

    let ok = got === c.expected;
    // Special rule for (g): pass if it found the 2 correct decisions (by topic),
    // regardless of order, and did not over-capture the question as a 3rd.
    if (c.id === 'g') {
      const topicsHit = G_EXPECTED_TOPICS.filter((t) => statements.some((s) => t.match(s)));
      ok = got === 2 && topicsHit.length === 2;
    }

    if (ok) passCount++;
    else failures.push(c.id);

    console.log(`[${c.id}] ${c.label}`);
    console.log(`    expected=${c.expected}  got=${got}  ${ok ? 'PASS' : 'FAIL'}`);
    for (const s of statements) {
      console.log(`      • ${s} (conf=${decisions.find((d) => d.statement === s)?.confidence ?? '?'})`);
    }
    console.log('');
  }

  const pass = passCount === cases.length;
  console.log(`Score: ${passCount}/${cases.length} cases correct`);
  if (failures.length) console.log(`FAILED cases: ${failures.join(', ')}`);
  console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}`);

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`classify-eval crashed: ${e?.stack || e}`);
  process.exit(1);
});
