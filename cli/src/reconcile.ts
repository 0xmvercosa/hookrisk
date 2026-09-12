/**
 * Cross-layer reconciliation: one fact, seen by two engines, reported once.
 *
 * The static layer classifies a callback that is overridden with a deliberate
 * revert as `callback-intentionally-disabled`. The dynamic layer, when it seeds
 * the hooked pool, watches that same revert happen and records
 * `seeded: "hooked-failed"` with the hook's own error. Reported separately they
 * read as two observations; they are one — "this hook refuses PoolManager
 * liquidity" — and a reader deciding whether the harness's I3 means anything
 * needs them joined.
 *
 * Three outcomes, applied in order:
 *
 * 1. Static classification on a liquidity callback + harness `hooked-failed`:
 *    the finding gains a second engine attribution (`harness` / `seed-reverted`),
 *    confidence `high` and an evidence line naming the revert. Two independent
 *    methods — reading the AST, executing the code — reached the same fact,
 *    which is the strongest false-positive filter available without a human.
 * 2. Harness `hooked-failed` with no static classification for the callback:
 *    a harness-sourced classification is added, at `medium` confidence. The
 *    revert is a fact; that it is *by design* is not established by execution
 *    alone (a whitelist hook and a buggy one revert the same way).
 * 3. When both layers agree that PoolManager liquidity is disabled by design,
 *    I3 (exit liveness) becomes `not-applicable`: no position can exist on the
 *    hooked pool, so there is nothing whose exit could be tested. A vacuous
 *    pass or an `inconclusive` is replaced; a *failed* I3 is never touched —
 *    a failure is evidence whatever the static layer says.
 *
 * Pure: no I/O, inputs are not mutated, everything else passes through
 * unchanged. The CLI wires the single call between `runHarness` and
 * `buildManifest`.
 */

import { callbackSelector, makeFindingId } from './engines/dedupe.js';
import {
  CALLBACK_SELECTORS,
  describeRevert,
  unwrapRevert,
  type HarnessRunInfo,
  type Observations,
} from './harness.js';
import type { InvariantResult } from './manifest.js';
import type { EngineAttribution, Finding } from './types.js';

export interface ReconcileInput {
  findings: Finding[];
  invariants: InvariantResult[];
  /** The harness's run record, when it wrote one. */
  runRecord?: HarnessRunInfo;
  /** Summed handler counters, when the harness ran to completion. */
  observations?: Observations;
}

export interface ReconcileOutput {
  findings: Finding[];
  invariants: InvariantResult[];
  /** One line per change made, for the verbose log. Empty when nothing was reconciled. */
  notes: string[];
}

export const HARNESS_ENGINE = 'harness';
export const SEED_REVERTED_RULE = 'seed-reverted';

/** The callback the PoolManager invokes for the harness's seed position. */
const SEED_CALLBACK = 'beforeAddLiquidity';
const LIQUIDITY_CALLBACKS: ReadonlySet<string> = new Set([
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
]);

export function reconcileLayers(input: ReconcileInput): ReconcileOutput {
  // Shallow copies down to the arrays that get appended to, so the caller's
  // findings are left as they were: a function that reports what it changed
  // must not also change what it was given.
  const findings = input.findings.map((f) => ({ ...f, evidence: [...f.evidence], engines: [...f.engines] }));
  const invariants = input.invariants.map((i) => ({ ...i }));
  const notes: string[] = [];

  const run = input.runRecord;
  if (!run || run.seeded !== 'hooked-failed') return { findings, invariants, notes };

  const revert = unwrapRevert(run.hookedSeedRevert || '0x');
  const revertText = describeRevert(revert);
  const seedEvidence =
    `harness: the seed position was rejected in ${SEED_CALLBACK} ` +
    `(${CALLBACK_SELECTORS_BY_NAME[SEED_CALLBACK]}) with ${revertText}` +
    (revert.selector ? ` [selector ${revert.selector}]` : '');

  const disabled = findings.filter(
    (f) => f.ruleClass === 'callback-intentionally-disabled' && LIQUIDITY_CALLBACKS.has(callbackOf(f) ?? ''),
  );
  const onSeedCallback = disabled.find((f) => callbackOf(f) === SEED_CALLBACK);

  if (onSeedCallback) {
    // Same fact, second witness.
    if (!onSeedCallback.engines.some((e) => e.engine === HARNESS_ENGINE)) {
      onSeedCallback.engines.push(attribution('high'));
    }
    onSeedCallback.confidence = 'high';
    onSeedCallback.evidence.push(seedEvidence);
    notes.push(
      `reconcile: ${SEED_CALLBACK} classified intentionally disabled by hookrisk and observed rejecting the ` +
        `harness's seed (${revertText}); merged into finding ${onSeedCallback.id} at confidence high`,
    );
  } else {
    findings.push(harnessOnlyFinding(revertText, seedEvidence));
    notes.push(
      `reconcile: the harness's seed was rejected in ${SEED_CALLBACK} (${revertText}) and no static ` +
        'classification names that callback; added a harness-sourced callback-intentionally-disabled finding',
    );
  }

  if (disabled.length > 0) {
    const i3 = invariants.find((i) => i.id === 'I3');
    if (i3 && i3.status !== 'failed') {
      const by = disabled.map((f) => callbackOf(f)).join(', ');
      const opened = input.observations ? ` The harness opened ${input.observations.positionsOpened} position(s).` : '';
      i3.status = 'not-applicable';
      i3.detail =
        `PoolManager liquidity is disabled by design: hookrisk classifies ${by} as intentionally disabled and ` +
        `the harness's seed position was rejected with ${revertText}. No position can exist on the hooked pool, ` +
        `so exit liveness has nothing to assert; liquidity held through the hook's own path is not exercised.${opened}`;
      delete i3.runs;
      delete i3.calls;
      delete i3.reverts;
      notes.push('reconcile: I3 not-applicable — both layers agree PoolManager liquidity is disabled by design');
    }
  }

  return { findings, invariants, notes };
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

const CALLBACK_SELECTORS_BY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CALLBACK_SELECTORS).map(([selector, name]) => [name, selector]),
);

/**
 * Which IHooks callback a finding is about, from whichever field the engine
 * filled in: the discriminator (hookrisk's disabled-callback and HS-01), the
 * function name (`_beforeAddLiquidity` on a BaseHook override resolves to the
 * callback) or a bare selector (BlockSec).
 */
function callbackOf(f: Finding): string | undefined {
  for (const candidate of [f.discriminator, f.function?.name]) {
    const selector = callbackSelector(candidate);
    if (selector) return CALLBACK_SELECTORS[selector];
  }
  if (f.function?.selector) return CALLBACK_SELECTORS[f.function.selector.toLowerCase()];
  return undefined;
}

function attribution(confidence: EngineAttribution['confidence']): EngineAttribution {
  return { engine: HARNESS_ENGINE, nativeRule: SEED_REVERTED_RULE, severity: 'info', confidence };
}

function harnessOnlyFinding(revertText: string, evidence: string): Finding {
  const selector = CALLBACK_SELECTORS_BY_NAME[SEED_CALLBACK]!;
  return {
    id: makeFindingId('callback-intentionally-disabled', null, selector, SEED_CALLBACK),
    ruleClass: 'callback-intentionally-disabled',
    title: `${SEED_CALLBACK} rejects PoolManager liquidity: the harness's seed position reverted with ${revertText}`,
    description:
      `The differential harness could not add liquidity to the hooked pool through the PoolManager: ${SEED_CALLBACK} ` +
      `reverted with ${revertText}. A hook that keeps its own reserves does this by design; a hook that meant to ` +
      'accept liquidity does not. No static classification names this callback as intentionally disabled, so ' +
      'execution alone establishes the refusal, not the intent — hence medium confidence. Invariants that need ' +
      'a position on the hooked pool were not exercised.',
    severity: 'info',
    confidence: 'medium',
    location: null,
    function: { name: SEED_CALLBACK, selector },
    discriminator: SEED_CALLBACK,
    evidence: [evidence],
    engines: [attribution('medium')],
  };
}
