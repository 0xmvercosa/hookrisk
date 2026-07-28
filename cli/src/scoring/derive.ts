/**
 * Turning findings into dimension scores.
 *
 * This is the join between the two halves of hookrisk, and the place where it
 * would be easiest to be quietly dishonest.
 *
 * The rule that governs everything here: **a dimension can be scored 0 only if a
 * detector capable of finding a non-zero value actually ran.** Absence of
 * evidence is evidence of absence only when someone looked.
 *
 * Consider `upgradeability`. If nothing reported a proxy, it is tempting to
 * record 0 — the hook is immutable, three points off the total, possibly a tier
 * lower. But if no engine capable of detecting a proxy ran, that 0 is fabricated,
 * and it is fabricated in the direction that makes the hook look safer. Over a
 * whole report those biases compound in one direction, which is exactly how a
 * scoring tool ends up understating risk precisely when it knows least.
 *
 * So each dimension declares which rule classes can raise it, and which engines
 * can produce those classes. A dimension is scored `measured` when every
 * responsible engine ran, and `unmeasured` otherwise. Unmeasured dimensions are
 * excluded from the total and reported as a range — see `score.ts`.
 *
 * A consequence worth stating plainly: with only HS-01, HS-02 and HS-07
 * implemented, most dimensions come back unmeasured and the tier is a range
 * rather than a point. That is the correct output for the current state of the
 * tool, and it is preferable to a confident-looking number built on detectors
 * that do not exist yet.
 */

import type { DeclaredInputs } from '../config.js';
import type { EngineResult, Finding, RuleClass } from '../types.js';
import type { DimensionInput, ScoringInput, ValueSource } from './score.js';

/**
 * Which engine can produce each rule class.
 *
 * `hookrisk` is our Slither plugin, `blocksec` is BlockSec's HookScan. Classes
 * only one engine covers become unmeasurable when that engine is unavailable,
 * which is why the BlockSec integration widens what hookrisk can score rather
 * than merely duplicating it.
 */
const CLASS_COVERAGE: Record<RuleClass, string[]> = {
  'unprotected-hook-callback': ['hookrisk', 'blocksec'],
  'unprotected-unlock-callback': ['blocksec'],
  'flag-implementation-divergence': ['hookrisk'],
  'admin-surface': ['hookrisk'],
  'upgradeable-hook': ['hookrisk', 'blocksec'],
  selfdestruct: ['blocksec'],
  'external-call-in-swap-path': ['hookrisk'],
  'unbounded-dynamic-fee': ['hookrisk'],
  'custom-accounting': ['hookrisk'],
  'rounding-direction': ['hookrisk'],
};

/**
 * Rule classes hookrisk currently implements a detector for.
 *
 * Deliberately explicit and deliberately short. A class listed here but not
 * actually implemented would let a dimension be scored 0 by a detector that
 * never runs, which is the failure this whole module exists to prevent. Update
 * it when a detector lands, not when one is planned.
 */
const IMPLEMENTED_CLASSES: ReadonlySet<RuleClass> = new Set<RuleClass>([
  'unprotected-hook-callback',
  'flag-implementation-divergence',
  'custom-accounting',
]);

interface DimensionRule {
  /** Rule classes that can raise this dimension above 0. */
  raisedBy: RuleClass[];
  /** Score to assign when a class is present. Highest match wins. */
  scoreFor: Partial<Record<RuleClass, number>>;
  /** Why this mapping, shown in the manifest as evidence. */
  rationale: string;
}

const DIMENSION_RULES: Record<string, DimensionRule> = {
  upgradeability: {
    raisedBy: ['upgradeable-hook', 'selfdestruct'],
    // 2 rather than 3: a proxy is present, but source analysis cannot tell
    // whether an EOA or a multisig controls it. Deployed mode reads `owner()`
    // and its codesize, and can refine this to 1, 2 or 3.
    scoreFor: { 'upgradeable-hook': 2, selfdestruct: 2 },
    rationale:
      'A proxy, DELEGATECALL to mutable code, or SELFDESTRUCT was found. Scored 2 (multisig-equivalent) because source analysis cannot identify the controller; scan the deployed address to refine.',
  },
  priceImpactingBehavior: {
    raisedBy: ['custom-accounting', 'unbounded-dynamic-fee'],
    scoreFor: { 'custom-accounting': 3, 'unbounded-dynamic-fee': 2 },
    rationale:
      'A returns-delta permission lets the hook alter settled amounts, which is the framework’s definition of price-impacting behaviour.',
  },
  customMath: {
    raisedBy: ['custom-accounting', 'rounding-direction'],
    scoreFor: { 'custom-accounting': 3, 'rounding-direction': 2 },
    rationale:
      'Custom accounting implies a custom curve or non-standard settlement arithmetic.',
  },
  externalDependencies: {
    raisedBy: ['external-call-in-swap-path'],
    scoreFor: { 'external-call-in-swap-path': 2 },
    rationale:
      'An external call inside the swap path reopens the execution environment mid-swap.',
  },
  complexity: {
    raisedBy: ['flag-implementation-divergence', 'unprotected-hook-callback'],
    // These findings prove the hook has callbacks and non-trivial structure, but
    // they are a poor proxy for the framework's notion of complexity, so they
    // only ever establish a floor of 1.
    scoreFor: { 'flag-implementation-divergence': 1, 'unprotected-hook-callback': 1 },
    rationale:
      'The hook implements callbacks with non-trivial structure. This establishes a floor only; hookrisk has no dedicated complexity metric yet.',
  },
};

/** Dimensions hookrisk never measures. Declared or unmeasured, never invented. */
const NEVER_MEASURED = new Set(['teamMaturity', 'tvlPotential', 'externalLiquidityExposure', 'autonomousParameterUpdates']);

export interface DeriveOptions {
  findings: Finding[];
  engineResults: EngineResult[];
  declared: DeclaredInputs;
  /** Dimension ids present in the rubric, so we never emit an unknown one. */
  dimensionIds: string[];
}

/**
 * Build the scoring input from findings, engine outcomes and declarations.
 *
 * Precedence: an explicit declaration always wins over a measurement, and the
 * manifest records both so a reviewer can see where a team disagreed with the
 * tool. Overriding a measured value upward is unremarkable; overriding one
 * downward is exactly the move the framework warns about, and making it visible
 * is the only defence a document can offer.
 */
export function deriveScoringInput(options: DeriveOptions): ScoringInput {
  const { findings, engineResults, declared, dimensionIds } = options;

  const enginesThatRan = new Set(
    engineResults.filter((r) => r.status === 'ok').map((r) => r.engine),
  );

  const byClass = new Map<RuleClass, Finding[]>();
  for (const finding of findings) {
    const bucket = byClass.get(finding.ruleClass);
    if (bucket) bucket.push(finding);
    else byClass.set(finding.ruleClass, [finding]);
  }

  const dimensions: Record<string, DimensionInput> = {};

  for (const id of dimensionIds) {
    const declaredValue = (declared as Record<string, number | undefined>)[id];

    if (NEVER_MEASURED.has(id)) {
      dimensions[id] =
        declaredValue === undefined
          ? { source: 'unmeasured' as ValueSource }
          : {
              value: declaredValue,
              source: 'declared' as ValueSource,
              evidence: [`Declared in hookrisk.toml. hookrisk does not measure ${id}.`],
            };
      continue;
    }

    const rule = DIMENSION_RULES[id];
    if (!rule) {
      dimensions[id] =
        declaredValue === undefined
          ? { source: 'unmeasured' as ValueSource }
          : { value: declaredValue, source: 'declared' as ValueSource };
      continue;
    }

    // Find the strongest evidence present.
    let measured: number | null = null;
    const evidence: string[] = [];
    for (const ruleClass of rule.raisedBy) {
      const hits = byClass.get(ruleClass);
      if (!hits?.length) continue;
      const value = rule.scoreFor[ruleClass] ?? 1;
      if (measured === null || value > measured) measured = value;
      evidence.push(`${hits.length} ${ruleClass} finding(s)`);
    }

    if (measured !== null) {
      evidence.push(rule.rationale);
      dimensions[id] =
        declaredValue !== undefined
          ? {
              value: declaredValue,
              source: 'declared' as ValueSource,
              evidence: [
                ...evidence,
                `hookrisk measured ${measured}; hookrisk.toml declares ${declaredValue}.` +
                  (declaredValue < measured
                    ? ' The declaration is lower than the measurement.'
                    : ''),
              ],
            }
          : { value: measured, source: 'measured' as ValueSource, evidence };
      continue;
    }

    // Nothing found. Whether that means zero depends entirely on whether anyone
    // capable of finding something actually looked.
    const missing = coverageGaps(rule.raisedBy, enginesThatRan);
    if (missing.length === 0) {
      dimensions[id] =
        declaredValue !== undefined
          ? { value: declaredValue, source: 'declared' as ValueSource }
          : {
              value: 0,
              source: 'measured' as ValueSource,
              evidence: [
                `No ${rule.raisedBy.join(' or ')} findings, and every detector that could ` +
                  'produce one ran.',
              ],
            };
    } else {
      dimensions[id] =
        declaredValue !== undefined
          ? {
              value: declaredValue,
              source: 'declared' as ValueSource,
              evidence: [`Not measurable: ${missing.join('; ')}. Value taken from hookrisk.toml.`],
            }
          : {
              source: 'unmeasured' as ValueSource,
              evidence: [`Not measured: ${missing.join('; ')}.`],
            };
    }
  }

  // Evidence that fires a trigger directly, independent of any dimension score.
  const evidence: string[] = [];
  if (byClass.has('custom-accounting')) evidence.push('returns-delta-permission');
  if (byClass.has('upgradeable-hook')) evidence.push('detector:upgradeable-hook');
  if (byClass.has('selfdestruct')) evidence.push('detector:selfdestruct');
  if (byClass.has('external-call-in-swap-path')) evidence.push('detector:external-call-in-swap-path');
  if (byClass.has('unbounded-dynamic-fee')) evidence.push('dynamic-fee-pool');

  return { dimensions, evidence };
}

/**
 * Explain why a rule class could not be ruled out.
 *
 * Two distinct reasons, and the distinction is worth keeping: hookrisk has no
 * detector for the class at all, or it has one but the engine did not run.
 */
function coverageGaps(classes: RuleClass[], enginesThatRan: Set<string>): string[] {
  const gaps: string[] = [];
  for (const ruleClass of classes) {
    const covering = CLASS_COVERAGE[ruleClass] ?? [];
    const available = covering.filter(
      (engine) =>
        enginesThatRan.has(engine) && (engine !== 'hookrisk' || IMPLEMENTED_CLASSES.has(ruleClass)),
    );
    if (available.length > 0) continue;

    if (covering.includes('hookrisk') && !IMPLEMENTED_CLASSES.has(ruleClass)) {
      const others = covering.filter((e) => e !== 'hookrisk');
      gaps.push(
        others.length > 0
          ? `no detector for ${ruleClass} (needs ${others.join(' or ')}, which did not run)`
          : `no detector for ${ruleClass} yet`,
      );
    } else {
      gaps.push(`${ruleClass} requires ${covering.join(' or ')}, which did not run`);
    }
  }
  return gaps;
}
