import { judgeContradiction } from '../judge.js';
import { dataset } from './dataset.js';

/**
 * Run judgeContradiction across the dataset, sequentially, and report metrics.
 */
/**
 * Run one case once. An error is either a thrown transport failure OR a returned
 * verdict whose reasoning starts with 'ERROR' (a swallowed parse/transport
 * failure that must never masquerade as a genuine "no contradiction" miss, or a
 * dead model would score precision 1.000).
 * @param {(typeof dataset)[number]} c
 * @returns {Promise<{got: any, errored: boolean}>}
 */
async function runCase(c) {
  try {
    const got = await judgeContradiction(c.newMessage, c.priorDecisions);
    const errored = typeof got.reasoning === 'string' && got.reasoning.startsWith('ERROR');
    return { got, errored };
  } catch (e) {
    return {
      got: {
        isContradiction: false,
        conflictingDecisionId: null,
        confidence: 0,
        reasoning: `ERROR: ${e?.message || e}`,
        reopensDecision: false,
      },
      errored: true,
    };
  }
}

async function main() {
  const results = [];

  console.log(`Running ${dataset.length} cases...\n`);
  for (let i = 0; i < dataset.length; i++) {
    const c = dataset[i];
    process.stdout.write(`[${i + 1}/${dataset.length}] ${c.name} ... `);
    let { got, errored } = await runCase(c);
    // Transient tolerance: an errored case (thrown OR 'ERROR' reasoning) gets ONE
    // retry before it is recorded as a hard failure.
    if (errored) {
      ({ got, errored } = await runCase(c));
    }
    const pass = !errored && got.isContradiction === c.expected.isContradiction;
    console.log(
      errored
        ? `ERRORED (${(got.reasoning || '').slice(0, 60)})`
        : pass
          ? 'PASS'
          : `FAIL (got ${got.isContradiction}, want ${c.expected.isContradiction})`,
    );
    results.push({ case: c, got, pass, errored });
  }

  // Confusion matrix over the whole set.
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of results) {
    const want = r.case.expected.isContradiction;
    const gotIt = r.got.isContradiction;
    if (want && gotIt) tp++;
    else if (!want && gotIt) fp++;
    else if (!want && !gotIt) tn++;
    else fn++;
  }

  // With zero predicted positives, precision is UNDEFINED — never report 1.0
  // (a dead model predicting all-negative must not look perfect).
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const erroredCount = results.filter((r) => r.errored).length;

  // False positives specifically on the 10 must-not-fire near-miss cases.
  const nearMiss = results.filter((r) => r.case.name.startsWith('near-miss:'));
  const nearMissFalsePositives = nearMiss.filter((r) => r.got.isContradiction);

  const failures = results.filter((r) => !r.pass);

  console.log('\n================ FAILURES ================');
  if (failures.length === 0) {
    console.log('(none)');
  } else {
    for (const r of failures) {
      const snippet = (r.got.reasoning || '').slice(0, 90);
      console.log(
        `- ${r.case.name}\n    expected=${r.case.expected.isContradiction} got=${r.got.isContradiction} ` +
          `confidence=${r.got.confidence}\n    reasoning: ${snippet}`,
      );
    }
  }

  console.log('\n================ METRICS ================');
  console.log(`Total cases:            ${results.length}`);
  console.log(`Passed:                 ${results.filter((r) => r.pass).length}`);
  console.log(`TP=${tp}  FP=${fp}  TN=${tn}  FN=${fn}`);
  console.log(`Errored (hard fails):   ${erroredCount}`);
  console.log(
    `Precision:              ${precision === null ? 'UNDEFINED (no predicted positives)' : precision.toFixed(3)}`,
  );
  console.log(`Recall:                 ${recall === null ? 'UNDEFINED' : recall.toFixed(3)}`);
  console.log(`Near-miss FP count:     ${nearMissFalsePositives.length} / ${nearMiss.length}`);
  if (nearMissFalsePositives.length > 0) {
    console.log('  Near-miss false positives:');
    for (const r of nearMissFalsePositives) console.log(`    - ${r.case.name}`);
  }

  const goalMet =
    erroredCount === 0 &&
    precision !== null &&
    precision >= 0.85 &&
    recall !== null &&
    recall >= 0.85 &&
    nearMissFalsePositives.length === 0;
  console.log(
    `\nGoal (0 errors AND precision >= 0.85 AND recall >= 0.85 AND zero near-miss FPs): ${goalMet ? 'MET' : 'NOT MET'}`,
  );
  process.exitCode = goalMet ? 0 : 1;
}

main().catch((e) => {
  console.error('Eval harness error:', e);
  process.exitCode = 1;
});
