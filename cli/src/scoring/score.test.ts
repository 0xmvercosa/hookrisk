/**
 * Tests for the scoring engine.
 *
 * The most valuable cases here are the four worked examples the framework itself
 * gives in §5, *Combined Trigger Logic (How it Works in Practice)*. They are the
 * only place the Foundation states an end-to-end expected outcome, so they are
 * the closest thing to a conformance suite our port can be held to. If one of
 * them fails, our reading of the framework is wrong, not the test.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EngineResult, Finding, RuleClass } from '../types.js';
import { deriveScoringInput, enginesThatLooked } from './derive.js';
import { loadRubric } from './rubric.js';
import { type ScoringInput, evaluateCondition, score } from './score.js';

const rubric = loadRubric();

/** Build an input with every dimension measured at 0, then override. */
function dims(overrides: Record<string, number>): ScoringInput['dimensions'] {
  const out: ScoringInput['dimensions'] = {};
  for (const dimension of rubric.dimensions) {
    out[dimension.id] = { value: overrides[dimension.id] ?? 0, source: 'measured' };
  }
  return out;
}

const strengthOf = (result: ReturnType<typeof score>, action: string): string | undefined =>
  result.recommendations.find((r) => r.action === action)?.strength;

describe('rubric', () => {
  test('loads and validates', () => {
    assert.equal(rubric.dimensions.length, 9, 'the framework defines nine dimensions');
    assert.equal(rubric.triggers.length, 7, 'and seven feature triggers');
    assert.equal(rubric.totalRange.max, 33, '5+5+3+3+5+3+3+3+3');
  });

  test('tier boundaries match the framework exactly', () => {
    const byId = Object.fromEntries(rubric.tiers.map((t) => [t.id, t]));
    assert.deepEqual([byId.low!.min, byId.low!.max], [0, 6]);
    assert.deepEqual([byId.medium!.min, byId.medium!.max], [7, 17]);
    assert.deepEqual([byId.high!.min, byId.high!.max], [18, 33]);
  });
});

describe('tier assignment', () => {
  test('6 is Low and 7 is Medium', () => {
    assert.equal(score({ dimensions: dims({ complexity: 5, teamMaturity: 1 }) }).tier.id, 'low');
    assert.equal(score({ dimensions: dims({ complexity: 5, teamMaturity: 2 }) }).tier.id, 'medium');
  });

  test('17 is Medium and 18 is High', () => {
    const at17 = dims({ complexity: 5, customMath: 5, tvlPotential: 4, teamMaturity: 3 });
    const at18 = dims({ complexity: 5, customMath: 5, tvlPotential: 5, teamMaturity: 3 });
    assert.equal(score({ dimensions: at17 }).total, 17);
    assert.equal(score({ dimensions: at17 }).tier.id, 'medium');
    assert.equal(score({ dimensions: at18 }).total, 18);
    assert.equal(score({ dimensions: at18 }).tier.id, 'high');
  });
});

describe("the framework's own worked examples (§5)", () => {
  // "A hook with a score of 4 but with custom math, must include an audit from
  //  a math specialist"
  test('score 4 with custom math requires a math specialist audit', () => {
    const result = score({ dimensions: dims({ customMath: 3, teamMaturity: 1 }) });

    assert.equal(result.total, 4);
    assert.equal(result.tier.id, 'low', 'the tier alone would ask for no math review');
    assert.ok(
      result.triggers.some((t) => t.id === 'custom-math'),
      'the custom-math trigger must fire',
    );
    assert.equal(strengthOf(result, 'math-specialist-audit'), 'required');
  });

  // "A hook with a score of 5 but with TVL 5, must implement monitoring and bug
  //  bounty"
  test('score 5 with TVL 5 requires monitoring and a bug bounty', () => {
    const result = score({ dimensions: dims({ tvlPotential: 5 }) });

    assert.equal(result.total, 5);
    assert.equal(result.tier.id, 'low', 'Low tier says both are optional');
    assert.ok(result.triggers.some((t) => t.id === 'tvl-5'));
    assert.equal(strengthOf(result, 'monitoring'), 'required');
    assert.equal(strengthOf(result, 'bug-bounty'), 'required');
  });

  // "A hook with a score of 3 but with autonomy, requires state invariant
  //  testing"
  test('score 3 with autonomy requires invariant testing', () => {
    const result = score({ dimensions: dims({ autonomousParameterUpdates: 3 }) });

    assert.equal(result.total, 3);
    assert.equal(result.tier.id, 'low');
    assert.ok(result.triggers.some((t) => t.id === 'autonomous'));
    assert.equal(strengthOf(result, 'invariant-testing'), 'required');
  });

  // "A medium-risk hook with a score of 7 but has custom math and price impact,
  //  looks like a high-risk hook regardless"
  //
  // This example does not hold under the framework's own rules, and this test
  // pins the gap rather than papering over it. Applying §3 and §4 mechanically,
  // the hook picks up three of the four measures the High tier makes mandatory
  // and misses `monitoring`, because the only two rules that could demand it are
  // §4.1 ("monitoring is recommended when combined with autonomy or
  // price-modifying behavior" — recommended, not required) and §4.5 ("monitoring
  // required if TVL score is 5" — TVL is 0 here). `second-audit` likewise stays
  // optional while the High tier calls for two audits.
  //
  // Reported upstream as FEEDBACK.md #11. If the Foundation tightens §4.1 or
  // §4.5, this test fails and tells us to update the port.
  test('score 7 with custom math and price impact reaches most, not all, High-tier measures', () => {
    const result = score({
      dimensions: dims({ customMath: 3, priceImpactingBehavior: 3, teamMaturity: 1 }),
    });

    assert.equal(result.total, 7);
    assert.equal(result.tier.id, 'medium', 'the raw tier is still Medium');
    assert.deepEqual(
      result.triggers.map((t) => t.id).sort(),
      ['custom-math', 'price-impact'],
      'both features must trigger independently of the tier',
    );

    // What the triggers do achieve, which is the framework's real point: a
    // Medium-tier hook is held to High-tier practice on the axes that matter.
    assert.equal(strengthOf(result, 'math-specialist-audit'), 'required');
    assert.equal(strengthOf(result, 'bug-bounty'), 'required');
    assert.equal(strengthOf(result, 'adversarial-simulation'), 'required');

    // And what they do not. Asserted explicitly so the shortfall is visible in
    // the test output rather than being an absence nobody notices.
    assert.equal(
      strengthOf(result, 'monitoring'),
      'recommended',
      'no rule in §3 or §4 raises monitoring to required for this hook',
    );
    assert.equal(strengthOf(result, 'second-audit'), 'optional');

    const high = rubric.tiers.find((t) => t.id === 'high')!;
    const highRequired = high.baseline
      .filter((r) => r.strength === 'required')
      .map((r) => r.action);
    const shortfall = highRequired.filter((action) => strengthOf(result, action) !== 'required');
    assert.deepEqual(
      shortfall,
      ['monitoring'],
      'the shortfall against the High tier is exactly monitoring',
    );
  });
});

describe('recommendation merging', () => {
  test('the strongest request wins and every request is kept as a source', () => {
    // Low tier calls a bug bounty optional; the TVL-5 trigger calls it required.
    const result = score({ dimensions: dims({ tvlPotential: 5 }) });
    const bounty = result.recommendations.find((r) => r.action === 'bug-bounty')!;

    assert.equal(bounty.strength, 'required');
    assert.ok(bounty.sources.length >= 2, 'both the tier and the trigger are recorded');
    assert.ok(bounty.sources.some((s) => s.from === 'tier:low' && s.strength === 'optional'));
    assert.ok(bounty.sources.some((s) => s.from === 'trigger:tvl-5' && s.strength === 'required'));
  });

  test('recommendations are ordered strongest first', () => {
    const result = score({ dimensions: dims({ tvlPotential: 5, customMath: 4 }) });
    const ranks = result.recommendations.map(
      (r) => rubric.strengths.find((s) => s.id === r.strength)!.rank,
    );
    for (let i = 1; i < ranks.length; i += 1) {
      assert.ok(ranks[i]! <= ranks[i - 1]!, 'strength must be non-increasing');
    }
  });

  test('a conditional requirement stays out when its condition is false', () => {
    // The upgradeable trigger requires a bug bounty only at TVL 5.
    const lowTvl = score({ dimensions: dims({ upgradeability: 2, tvlPotential: 1 }) });
    const bounty = lowTvl.recommendations.find((r) => r.action === 'bug-bounty');
    assert.ok(
      !bounty?.sources.some((s) => s.from === 'trigger:upgradeable'),
      'the upgradeable trigger must not demand a bounty below TVL 5',
    );

    const highTvl = score({ dimensions: dims({ upgradeability: 2, tvlPotential: 5 }) });
    assert.equal(strengthOf(highTvl, 'bug-bounty'), 'required');
  });
});

describe('unmeasured dimensions', () => {
  test('are excluded from the total rather than counted as zero', () => {
    const partial: ScoringInput['dimensions'] = {
      ...dims({ complexity: 2 }),
      upgradeability: { source: 'unmeasured' },
      teamMaturity: { source: 'unmeasured' },
    };
    const result = score({ dimensions: partial });

    assert.equal(result.total, 2, 'only known values are summed');
    assert.equal(result.totalUpperBound, 2 + 3 + 3, 'plus the maxima of what is unknown');
    assert.deepEqual(result.unmeasured.sort(), ['teamMaturity', 'upgradeability']);
  });

  test('mark the result inconclusive when they straddle a tier boundary', () => {
    const partial: ScoringInput['dimensions'] = {
      ...dims({ complexity: 5, customMath: 1 }),
      tvlPotential: { source: 'unmeasured' },
    };
    const result = score({ dimensions: partial });

    assert.equal(result.total, 6);
    assert.equal(result.tier.id, 'low');
    assert.equal(result.totalUpperBound, 11);
    assert.equal(result.tierUpperBound.id, 'medium');
    assert.equal(result.inconclusive, true);
    assert.ok(result.warnings.some((w) => w.includes('unmeasured')));
  });

  test('do not silently suppress a trigger they would have decided', () => {
    const partial: ScoringInput['dimensions'] = {
      ...dims({}),
      upgradeability: { source: 'unmeasured' },
    };
    const result = score({ dimensions: partial });

    assert.ok(
      result.warnings.some((w) => w.includes("trigger 'upgradeable'")),
      'an unevaluable trigger must be reported, not treated as not firing',
    );
  });

  test('detector evidence fires a trigger even when the dimension is unknown', () => {
    const partial: ScoringInput['dimensions'] = {
      ...dims({}),
      upgradeability: { source: 'unmeasured' },
    };
    const result = score({
      dimensions: partial,
      evidence: ['detector:upgradeable-hook'],
    });

    const fired = result.triggers.find((t) => t.id === 'upgradeable');
    assert.ok(fired, 'evidence alone must be able to fire a trigger');
    assert.deepEqual(fired.firedBy, ['detector:upgradeable-hook']);
    assert.equal(strengthOf(result, 'storage-collision-review'), 'required');
  });
});

describe('provenance', () => {
  test('measured and declared values stay distinguishable', () => {
    const result = score({
      dimensions: {
        ...dims({}),
        upgradeability: { value: 2, source: 'measured', evidence: ['HS-04: EIP-1967 slot'] },
        teamMaturity: { value: 1, source: 'declared' },
      },
    });

    const upgrade = result.dimensions.find((d) => d.id === 'upgradeability')!;
    const team = result.dimensions.find((d) => d.id === 'teamMaturity')!;

    assert.equal(upgrade.source, 'measured');
    assert.deepEqual(upgrade.evidence, ['HS-04: EIP-1967 slot']);
    assert.equal(team.source, 'declared');
  });

  test('flags which brackets are our interpretation rather than the framework’s', () => {
    const result = score({ dimensions: dims({}) });
    const tvl = result.dimensions.find((d) => d.id === 'tvlPotential')!;
    const complexity = result.dimensions.find((d) => d.id === 'complexity')!;

    assert.equal(tvl.bracketsAreInterpretation, false, 'the framework publishes TVL brackets');
    assert.equal(complexity.bracketsAreInterpretation, true, 'it does not publish these');
  });

  test('out-of-range values are clamped and warned about', () => {
    const result = score({
      dimensions: { ...dims({}), complexity: { value: 9, source: 'measured' } },
    });
    assert.equal(result.dimensions.find((d) => d.id === 'complexity')!.value, 5);
    assert.ok(result.warnings.some((w) => w.includes('clamped')));
  });
});

describe('condition evaluation', () => {
  const values = { tvlPotential: 5, priceImpactingBehavior: 1 };
  const triggers = new Set(['autonomous']);
  const flags = { dependencyInfluencesPricing: true };

  test('numeric comparisons', () => {
    assert.equal(evaluateCondition('tvlPotential == 5', values, triggers, flags), true);
    assert.equal(evaluateCondition('tvlPotential >= 5', values, triggers, flags), true);
    assert.equal(evaluateCondition('tvlPotential > 5', values, triggers, flags), false);
    assert.equal(evaluateCondition('priceImpactingBehavior >= 2', values, triggers, flags), false);
  });

  test('trigger references and boolean flags', () => {
    assert.equal(evaluateCondition('trigger:autonomous', values, triggers, flags), true);
    assert.equal(evaluateCondition('trigger:price-impact', values, triggers, flags), false);
    assert.equal(evaluateCondition('dependencyInfluencesPricing', values, triggers, flags), true);
    assert.equal(evaluateCondition('somethingElse', values, triggers, flags), false);
  });

  test('disjunction and conjunction', () => {
    assert.equal(
      evaluateCondition('trigger:autonomous || trigger:price-impact', values, triggers, flags),
      true,
    );
    assert.equal(
      evaluateCondition('trigger:autonomous && trigger:price-impact', values, triggers, flags),
      false,
    );
    assert.equal(
      evaluateCondition('tvlPotential == 5 || priceImpactingBehavior >= 2', values, triggers, flags),
      true,
    );
  });

  test('an unmeasured dimension cannot satisfy a threshold', () => {
    assert.equal(evaluateCondition('upgradeability >= 1', values, triggers, flags), false);
  });

  test('an unparseable condition is false, never true by accident', () => {
    assert.equal(evaluateCondition('!!!garbage!!!', values, triggers, flags), false);
    assert.equal(evaluateCondition('', values, triggers, flags), false);
  });
});

// --------------------------------------------------------------------------- //
// Deriving dimensions from findings and engine outcomes
// --------------------------------------------------------------------------- //

describe('deriveScoringInput', () => {
  const dimensionIds = rubric.dimensions.map((d) => d.id);

  const engine = (
    id: string,
    findings: Finding[] = [],
    extra: Partial<EngineResult> = {},
  ): EngineResult => ({ engine: id, version: 't', status: 'ok', findings, durationMs: 1, ...extra });

  const finding = (ruleClass: RuleClass, overrides: Partial<Finding> = {}): Finding => ({
    id: `${ruleClass}-id`,
    ruleClass,
    title: `${ruleClass} title`,
    description: 'd',
    severity: 'high',
    confidence: 'medium',
    location: { file: 'src/MyHook.sol', line: 18 },
    evidence: [],
    engines: [{ engine: 'hookrisk', nativeRule: 'r', severity: 'high', confidence: 'medium' }],
    ...overrides,
  });

  const derive = (findings: Finding[], engineResults: EngineResult[], declared = {}) =>
    deriveScoringInput({ findings, engineResults, declared, dimensionIds });

  test('complexity is unmeasured, never 0, when nothing raised it', () => {
    // Five legacy hooks were scored "measured 0 / Pass-through only; no hook
    // state" from exactly this input. HS-01 and HS-02 only ever set a floor of
    // 1; their silence measures nothing.
    const input = derive([], [engine('hookrisk')]);
    const complexity = input.dimensions.complexity!;

    assert.equal(complexity.source, 'unmeasured');
    assert.equal(complexity.value, undefined);
    assert.ok(complexity.evidence?.[0]?.includes('no complexity metric'), complexity.evidence?.join(' '));

    // Scoped to complexity: other dimensions are unmeasured for the reason they
    // always were (rule 2, a class with no detector yet), not for this one.
    const customMath = input.dimensions.customMath!;
    assert.equal(customMath.source, 'unmeasured');
    assert.ok(customMath.evidence?.[0]?.includes('no detector for rounding-direction yet'), customMath.evidence?.join(' '));
    assert.ok(!customMath.evidence?.[0]?.includes('complexity metric'));

    const scored = score(input, rubric);
    const scoredComplexity = scored.dimensions.find((d) => d.id === 'complexity')!;
    assert.equal(scoredComplexity.value, null);
    assert.equal(scoredComplexity.bracketLabel, null, 'no bracket is asserted from silence');
  });

  test('complexity keeps its floor of 1 when a structural finding fires', () => {
    const input = derive([finding('flag-implementation-divergence')], [engine('hookrisk')]);
    assert.deepEqual(
      { value: input.dimensions.complexity!.value, source: input.dimensions.complexity!.source },
      { value: 1, source: 'measured' },
    );
  });

  test('a declared complexity still wins when the detectors are silent', () => {
    const input = derive([], [engine('hookrisk')], { complexity: 3 });
    const complexity = input.dimensions.complexity!;
    assert.equal(complexity.source, 'declared');
    assert.equal(complexity.value, 3);
    assert.ok(complexity.evidence?.[0]?.startsWith('Not measurable'), complexity.evidence?.join(' '));
  });

  test('an unsupported-hook-abi finding revokes hookrisk coverage of the target', () => {
    // The engine ran (status ok) but the detectors never recognised the
    // contract. Every dimension hookrisk would have measured must come back
    // unmeasured, not 0.
    const input = derive(
      [finding('unsupported-hook-abi', { severity: 'info', title: '2023 getHooksCalls() ABI' })],
      [engine('hookrisk')],
    );

    for (const id of ['customMath', 'priceImpactingBehavior', 'complexity']) {
      const dimension = input.dimensions[id]!;
      assert.equal(dimension.source, 'unmeasured', `${id} must be unmeasured`);
      assert.ok(
        dimension.evidence?.[0]?.includes("did not recognise the target's hook ABI"),
        `${id}: ${dimension.evidence?.join(' ')}`,
      );
    }
    assert.deepEqual(input.evidence, [], 'a classification fires no trigger evidence');
  });

  test('an engine that disclaims the target through targetCoverage is treated as not having looked', () => {
    const input = derive(
      [],
      [engine('hookrisk', [], { targetCoverage: { covered: false, reason: 'no hook contract in src/MyHook.sol' } })],
    );
    const customMath = input.dimensions.customMath!;
    assert.equal(customMath.source, 'unmeasured');
    assert.ok(
      customMath.evidence?.[0]?.includes('ran but did not analyse the target (no hook contract in src/MyHook.sol)'),
      customMath.evidence?.join(' '),
    );
  });

  test('enginesThatLooked separates ran-and-looked from ran-and-disclaimed', () => {
    const { looked, declined } = enginesThatLooked(
      [
        engine('hookrisk', [], { targetCoverage: { covered: true } }),
        engine('blocksec', [], { status: 'skipped' }),
      ],
      [],
    );
    assert.deepEqual([...looked], ['hookrisk']);
    assert.equal(declined.size, 0, 'a skipped engine neither looked nor disclaimed; it simply did not run');
  });

  test('a genuine 0 still requires that the responsible engine looked', () => {
    // No hookrisk at all: customMath cannot be 0, whatever blocksec says.
    const input = derive([], [engine('blocksec')]);
    assert.equal(input.dimensions.customMath!.source, 'unmeasured');
    assert.ok(input.dimensions.customMath!.evidence?.[0]?.includes('which did not run'));
  });
});
