/**
 * Tests for cross-layer reconciliation.
 *
 * Fixtures are the real Orbital scan: hookrisk's two `callback-intentionally-
 * disabled` findings and the harness run record with the seed revert
 * `Error("Use custom addLiquidity")`, verbatim from
 * docs/hackathon/evidence/scans/after/orbital-hook-ctor/hook-risk.json.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { HarnessRunInfo } from './harness.js';
import type { InvariantResult } from './manifest.js';
import { reconcileLayers } from './reconcile.js';
import type { Finding } from './types.js';

/** `Error("Use custom addLiquidity")`, already unwrapped by the harness. */
const SEED_REVERT =
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000175573652063757374' +
  '6f6d206164644c6971756964697479000000000000000000';

const HOOKED_FAILED: HarnessRunInfo = {
  flags: 2696,
  customCurve: true,
  dynamicFee: false,
  permissionsDerived: false,
  seeded: 'hooked-failed',
  hookedSeedRevert: SEED_REVERT,
};

function disabledFinding(callback: 'beforeAddLiquidity' | 'beforeRemoveLiquidity', line: number): Finding {
  return {
    id: `id-${callback}`,
    ruleClass: 'callback-intentionally-disabled',
    title: `OrbitalHook._${callback}(...) overrides \`${callback}\` with \`revert "Use custom ..."\``,
    description: 'disabled by design',
    severity: 'info',
    confidence: 'high',
    location: { file: 'src/OrbitalHook.sol', line },
    function: { name: `_${callback}` },
    discriminator: callback,
    evidence: ['static evidence'],
    engines: [{ engine: 'hookrisk', nativeRule: 'hookrisk-disabled-callback', severity: 'info', confidence: 'high' }],
  };
}

const UNRELATED: Finding = {
  id: 'id-hs01',
  ruleClass: 'unprotected-hook-callback',
  title: 'beforeSwap is callable by anyone',
  description: '',
  severity: 'high',
  confidence: 'medium',
  location: { file: 'src/OrbitalHook.sol', line: 200 },
  function: { name: 'beforeSwap' },
  evidence: ['no onlyPoolManager'],
  engines: [{ engine: 'hookrisk', nativeRule: 'hookrisk-unprotected-callback', severity: 'high', confidence: 'medium' }],
};

function invariants(i3: Partial<InvariantResult> = {}): InvariantResult[] {
  return [
    { id: 'I1', name: 'Conservation and solvency', status: 'passed', runs: 256, calls: 8192 },
    { id: 'I2', name: 'Price monotonicity (custom curve)', status: 'inconclusive', detail: 'passed vacuously' },
    { id: 'I3', name: 'Exit liveness', status: 'inconclusive', detail: 'passed vacuously: 0 positions opened', runs: 256, ...i3 },
  ];
}

describe('reconcileLayers', () => {
  test('static disabled-callback + harness hooked-failed merge into one corroborated finding', () => {
    const input = {
      findings: [UNRELATED, disabledFinding('beforeAddLiquidity', 325), disabledFinding('beforeRemoveLiquidity', 338)],
      invariants: invariants(),
      runRecord: HOOKED_FAILED,
      observations: undefined,
    };
    const { findings, notes } = reconcileLayers(input);

    assert.equal(findings.length, 3, 'no finding added: the static one already names the fact');
    const merged = findings.find((f) => f.id === 'id-beforeAddLiquidity')!;
    assert.deepEqual(
      merged.engines.map((e) => [e.engine, e.nativeRule]),
      [['hookrisk', 'hookrisk-disabled-callback'], ['harness', 'seed-reverted']],
    );
    assert.equal(merged.confidence, 'high');
    assert.match(merged.evidence.at(-1)!, /seed position was rejected in beforeAddLiquidity \(0x259982e5\)/);
    assert.match(merged.evidence.at(-1)!, /Error\("Use custom addLiquidity"\)/);
    assert.match(merged.evidence.at(-1)!, /selector 0x08c379a0/);

    const remove = findings.find((f) => f.id === 'id-beforeRemoveLiquidity')!;
    assert.equal(remove.engines.length, 1, 'the harness never reached beforeRemoveLiquidity; it must not vouch for it');
    assert.deepEqual(findings.find((f) => f.id === 'id-hs01'), UNRELATED, 'unrelated findings pass through untouched');
    assert.equal(notes.length, 2);
  });

  test('both layers agreeing makes I3 not-applicable with the revert named, and leaves I1/I2 alone', () => {
    const { invariants: out } = reconcileLayers({
      findings: [disabledFinding('beforeAddLiquidity', 325)],
      invariants: invariants(),
      runRecord: HOOKED_FAILED,
      observations: {
        swapsExecuted: 0, swapsCompared: 0, swapsSkipped: 0, hookedSwapReverted: 1280, positionsOpened: 0,
        positionsClosed: 0, donations: 0, priceChecks: 0, monotonicityViolations: 0, exitFailures: 0,
      },
    });
    const i3 = out.find((i) => i.id === 'I3')!;
    assert.equal(i3.status, 'not-applicable');
    assert.match(i3.detail ?? '', /disabled by design/);
    assert.match(i3.detail ?? '', /hookrisk classifies beforeAddLiquidity as intentionally disabled/);
    assert.match(i3.detail ?? '', /rejected with Error\("Use custom addLiquidity"\)/);
    assert.match(i3.detail ?? '', /opened 0 position\(s\)/);
    assert.equal(i3.runs, undefined, 'a not-applicable invariant carries no run statistics');
    assert.equal(out.find((i) => i.id === 'I1')!.status, 'passed');
    assert.equal(out.find((i) => i.id === 'I2')!.status, 'inconclusive');
  });

  test('a failed I3 is never downgraded to not-applicable', () => {
    const { invariants: out } = reconcileLayers({
      findings: [disabledFinding('beforeAddLiquidity', 325)],
      invariants: invariants({ status: 'failed', detail: 'exit reverted' }),
      runRecord: HOOKED_FAILED,
    });
    assert.equal(out.find((i) => i.id === 'I3')!.status, 'failed');
  });

  test('hooked-failed with no static classification adds a harness-sourced finding at medium confidence', () => {
    const { findings, invariants: out, notes } = reconcileLayers({
      findings: [UNRELATED],
      invariants: invariants(),
      runRecord: HOOKED_FAILED,
    });
    assert.equal(findings.length, 2);
    const added = findings[1]!;
    assert.equal(added.ruleClass, 'callback-intentionally-disabled');
    assert.equal(added.confidence, 'medium');
    assert.equal(added.location, null);
    assert.deepEqual(added.function, { name: 'beforeAddLiquidity', selector: '0x259982e5' });
    assert.equal(added.discriminator, 'beforeAddLiquidity');
    assert.deepEqual(added.engines, [
      { engine: 'harness', nativeRule: 'seed-reverted', severity: 'info', confidence: 'medium' },
    ]);
    assert.match(added.title, /Error\("Use custom addLiquidity"\)/);
    assert.match(added.description, /not the intent/);
    assert.equal(added.id.length, 16, 'id comes from makeFindingId');
    assert.equal(out.find((i) => i.id === 'I3')!.status, 'inconclusive', 'one witness is not agreement; I3 stays as measured');
    assert.equal(notes.length, 1);
  });

  test('the harness-only finding names the selector when the revert is a custom error', () => {
    const { findings } = reconcileLayers({
      findings: [],
      invariants: invariants(),
      runRecord: { ...HOOKED_FAILED, hookedSeedRevert: '0xebdb4fd9' },
    });
    assert.match(findings[0]!.title, /custom error 0xebdb4fd9/);
    assert.match(findings[0]!.evidence[0]!, /\[selector 0xebdb4fd9\]/);
  });

  test('a static classification on beforeRemoveLiquidity only still counts as agreement, and the add path gets its own finding', () => {
    const { findings, invariants: out } = reconcileLayers({
      findings: [disabledFinding('beforeRemoveLiquidity', 338)],
      invariants: invariants(),
      runRecord: HOOKED_FAILED,
    });
    assert.equal(findings.length, 2, 'the seed revert is about beforeAddLiquidity, which nothing static names');
    assert.equal(findings[0]!.engines.length, 1);
    assert.equal(out.find((i) => i.id === 'I3')!.status, 'not-applicable');
  });

  test('the callback is recognised from a BlockSec-style selector too', () => {
    const bySelector: Finding = { ...disabledFinding('beforeAddLiquidity', 1), discriminator: undefined, function: { selector: '0x259982E5' } };
    const { findings } = reconcileLayers({ findings: [bySelector], invariants: invariants(), runRecord: HOOKED_FAILED });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.engines.length, 2);
  });

  test('nothing changes when the seed succeeded, the record is absent, or the harness never ran', () => {
    const findings = [disabledFinding('beforeAddLiquidity', 325)];
    for (const runRecord of [undefined, { ...HOOKED_FAILED, seeded: 'both' as const, hookedSeedRevert: '' }]) {
      const out = reconcileLayers({ findings, invariants: invariants(), runRecord });
      assert.deepEqual(out.findings, findings);
      assert.deepEqual(out.invariants, invariants());
      assert.deepEqual(out.notes, []);
    }
  });

  test('inputs are not mutated', () => {
    const findings = [disabledFinding('beforeAddLiquidity', 325)];
    const before = JSON.stringify({ findings, invariants: invariants() });
    reconcileLayers({ findings, invariants: invariants(), runRecord: HOOKED_FAILED });
    assert.equal(JSON.stringify({ findings, invariants: invariants() }), before);
  });
});
