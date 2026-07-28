/**
 * Running the differential harness against an arbitrary hook.
 *
 * The harness lives in this repository, as a Foundry project with v4-core, the
 * twin-pool fixture and the invariants. A user's hook lives somewhere else. This
 * module bridges the two without asking the user to write any Solidity.
 *
 * ## How
 *
 * The creation bytecode is read out of the user's Foundry artifact and handed to
 * the harness through `HOOKRISK_CREATION_CODE`, alongside the permission flags
 * and the declared fee bound. `TwinPools` etches it at a flag-bearing address,
 * runs the constructor and etches the resulting runtime code — the same
 * procedure `forge-std`'s `deployCodeTo` uses.
 *
 * Passing bytes rather than a name is what makes cross-project scanning work at
 * all. `vm.getCode("File.sol:Contract")` resolves against the *harness's* own
 * compilation index, so an artifact merely copied into its `out/` directory is
 * invisible and fails with `no matching artifact found` — which reads like a
 * missing file when the file is sitting right there.
 *
 * This is also more robust than generating Solidity and compiling it inside the
 * user's project: no remappings to reconcile, no solc version to agree on, and
 * the invariants under test are the same bytes CI runs against our own fixtures.
 *
 * ## What it cannot do
 *
 * The hook must be constructible from `IPoolManager` alone. That covers the
 * `BaseHook` convention and most hooks in the wild, but a hook taking extra
 * constructor arguments is out of reach for now and is reported as such rather
 * than silently skipped. Stated plainly here and in docs/INVARIANTS.md because
 * a dynamic layer that quietly declines to run is worse than one that says it
 * did not.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HookriskError } from './errors.js';
import type { InvariantResult } from './manifest.js';

/** Bit positions of the 14 hook permissions, from v4-core's Hooks library. */
export const FLAG_BITS: Record<string, number> = {
  beforeInitialize: 13,
  afterInitialize: 12,
  beforeAddLiquidity: 11,
  afterAddLiquidity: 10,
  beforeRemoveLiquidity: 9,
  afterRemoveLiquidity: 8,
  beforeSwap: 7,
  afterSwap: 6,
  beforeDonate: 5,
  afterDonate: 4,
  beforeSwapReturnDelta: 3,
  afterSwapReturnDelta: 2,
  afterAddLiquidityReturnDelta: 1,
  afterRemoveLiquidityReturnDelta: 0,
};

export interface HarnessOptions {
  /** Root of the user's Foundry project. */
  projectRoot: string;
  /** e.g. `src/MyHook.sol`. */
  sourceFile: string;
  contractName: string;
  /** Permission set, usually from `getHookPermissions()`. */
  permissions: Record<string, boolean>;
  /** Declared fee bound in basis points, from hookrisk.toml. */
  maxFeeBips: number;
  /** Foundry profile: `scan` for CI, `deep` for an overnight run. */
  profile?: 'scan' | 'deep';
  timeoutMs: number;
  log: (message: string) => void;
  /** Override for tests; normally derived from this module's location. */
  harnessRoot?: string;
}

const INVARIANT_MAP: Record<string, { id: 'I1' | 'I2' | 'I3'; name: string }> = {
  invariant_I1_tokensAreConserved: { id: 'I1', name: 'Conservation and solvency' },
  invariant_I2_noUndeclaredExtraction: { id: 'I2', name: 'No undeclared extraction' },
  invariant_I2b_priceIsMonotonic: { id: 'I2', name: 'Price monotonicity (custom curve)' },
  invariant_I2_hookDoesNotBlockSwaps: { id: 'I2', name: 'Hook does not block swaps' },
  invariant_I3_noExitReverted: { id: 'I3', name: 'Exit liveness' },
};

/**
 * Read the permission set a hook declares in `getHookPermissions()`.
 *
 * Parsed from source rather than obtained from Slither: the shape is a struct
 * literal of boolean fields, one regex covers every formatting style we have
 * seen, and it saves a second analysis pass just to learn fourteen bits.
 *
 * Only fields inside `getHookPermissions` are read, so an unrelated
 * `beforeSwap: true` elsewhere in the file cannot leak in. In deployed mode this
 * is not used at all — permissions come from the address, which is what the
 * PoolManager actually obeys.
 *
 * Returns null when the function is absent, which is meaningful in itself: the
 * hook relies entirely on address bits that nothing in its source verifies.
 */
export function parseDeclaredPermissions(sourceText: string): Record<string, boolean> | null {
  const start = sourceText.indexOf('getHookPermissions');
  if (start < 0) return null;

  // Bound the search to the function body by matching braces from the first `{`
  // after the signature. Cheaper and more robust than trying to match the whole
  // function with one expression.
  const open = sourceText.indexOf('{', start);
  if (open < 0) return null;

  let depth = 0;
  let end = open;
  for (let i = open; i < sourceText.length; i += 1) {
    if (sourceText[i] === '{') depth += 1;
    else if (sourceText[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const body = sourceText.slice(open, end);
  const permissions: Record<string, boolean> = {};
  for (const match of body.matchAll(/(\w+)\s*[:=]\s*(true|false)\b/g)) {
    const field = match[1]!;
    if (field in FLAG_BITS) permissions[field] = match[2] === 'true';
  }

  return Object.keys(permissions).length > 0 ? permissions : null;
}

/** Compute the low-14-bit flag word from a permission set. */
export function flagsFrom(permissions: Record<string, boolean>): number {
  let flags = 0;
  for (const [name, bit] of Object.entries(FLAG_BITS)) {
    if (permissions[name]) flags |= 1 << bit;
  }
  return flags;
}

/** Locate the harness project shipped with hookrisk. */
function defaultHarnessRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(join(here, '..', '..', 'harness'));
}

export interface HarnessOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  invariants: InvariantResult[];
}

/** Run the differential harness and translate the result. */
export async function runHarness(options: HarnessOptions): Promise<HarnessOutcome> {
  const harnessRoot = options.harnessRoot ?? defaultHarnessRoot();

  if (!existsSync(join(harnessRoot, 'foundry.toml'))) {
    return skipped(
      `harness project not found at ${harnessRoot}. The dynamic layer ships with the hookrisk repository; ` +
        'install from source to use it.',
    );
  }
  if (!existsSync(join(harnessRoot, 'lib', 'v4-core'))) {
    return skipped(`harness dependencies are not materialised — run \`make deps\` in ${harnessRoot}.`);
  }

  // The artifact Foundry produced for the user's hook.
  const artifactName = basenameOf(options.sourceFile);
  const source = join(options.projectRoot, 'out', artifactName, `${options.contractName}.json`);
  if (!existsSync(source)) {
    return skipped(
      `no compiled artifact at ${source} — run \`forge build\` in the target project first.`,
    );
  }

  const artifact = readArtifact(source, options.contractName);
  if ('reason' in artifact) return skipped(artifact.reason);

  const flags = flagsFrom(options.permissions);
  if (flags === 0) {
    return skipped(
      'the hook declares no permissions, so the PoolManager would never invoke it and there is nothing to compare.',
    );
  }

  const customCurve = options.permissions.beforeSwapReturnDelta === true;
  options.log(
    `harness: ${artifactName}:${options.contractName} flags=0x${flags.toString(16)} ` +
      `maxFee=${options.maxFeeBips}bips${customCurve ? ' (custom curve: I2 -> monotonicity)' : ''}`,
  );

  const proc = await exec(
    'forge',
    ['test', '--match-contract', 'GenericHookInvariants', '--json'],
    options.timeoutMs,
    harnessRoot,
    {
      FOUNDRY_PROFILE: options.profile ?? 'scan',
      HOOKRISK_ARTIFACT: `${artifactName}:${options.contractName}`,
      HOOKRISK_CREATION_CODE: artifact.creationCode,
      HOOKRISK_FLAGS: String(flags),
      HOOKRISK_MAX_FEE_BIPS: String(options.maxFeeBips),
      HOOKRISK_CUSTOM_CURVE: customCurve ? '1' : '0',
    },
  ).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));

  if (!proc.stdout.trim()) {
    return {
      status: 'failed',
      reason: `forge produced no output: ${lastLines(proc.stderr, 3)}`,
      invariants: [],
    };
  }

  let report: Record<string, { test_results: Record<string, ForgeTestResult> }>;
  try {
    report = JSON.parse(proc.stdout);
  } catch {
    return {
      status: 'failed',
      reason: `could not parse forge output: ${lastLines(proc.stdout || proc.stderr, 3)}`,
      invariants: [],
    };
  }

  const invariants = translate(report, customCurve);
  const failures = invariants.filter((i) => i.status === 'failed').length;
  options.log(
    `harness: ${invariants.length} invariant(s), ${failures} failed`,
  );

  return { status: 'ok', invariants };
}

interface ForgeTestResult {
  status: string;
  reason?: string | null;
  counterexample?: unknown;
  kind?: { Invariant?: { runs: number; calls: number; reverts: number } };
}

/**
 * Turn forge's per-test results into manifest invariant entries.
 *
 * Several Foundry tests map onto one framework invariant — I2 is asserted by
 * three separate functions — so results are merged, with failure dominating.
 * Reporting three rows for one property would make a single defect look like
 * three, which is the same double-counting problem the engine dedupe layer
 * exists to solve.
 */
function translate(
  report: Record<string, { test_results: Record<string, ForgeTestResult> }>,
  customCurve: boolean,
): InvariantResult[] {
  const merged = new Map<string, InvariantResult>();

  for (const suite of Object.values(report)) {
    for (const [rawName, result] of Object.entries(suite.test_results ?? {})) {
      const name = rawName.replace(/\(\)$/, '');
      const mapping = INVARIANT_MAP[name];
      if (!mapping) continue;

      // The two I2 variants are mutually exclusive by design: one is skipped
      // whenever the other applies. Discarding the inapplicable one keeps a
      // vacuous pass out of the report.
      if (name === 'invariant_I2_noUndeclaredExtraction' && customCurve) continue;
      if (name === 'invariant_I2b_priceIsMonotonic' && !customCurve) continue;

      const invariant = toInvariant(mapping.id, mapping.name, result);
      const existing = merged.get(mapping.id);

      if (!existing) {
        merged.set(mapping.id, invariant);
      } else if (invariant.status === 'failed' && existing.status !== 'failed') {
        merged.set(mapping.id, invariant);
      } else if (existing.status !== 'failed') {
        existing.runs = Math.max(existing.runs ?? 0, invariant.runs ?? 0);
        existing.calls = Math.max(existing.calls ?? 0, invariant.calls ?? 0);
      }
    }
  }

  // I2 against a custom curve is not merely absent, it is inapplicable — a
  // distinction the schema keeps and a reader needs.
  if (customCurve && merged.has('I2')) {
    const entry = merged.get('I2')!;
    entry.detail =
      (entry.detail ? `${entry.detail} ` : '') +
      'Output comparison against an unhooked pool does not apply to a custom-curve hook; ' +
      'price monotonicity was asserted instead.';
  }

  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function toInvariant(
  id: 'I1' | 'I2' | 'I3',
  name: string,
  result: ForgeTestResult,
): InvariantResult {
  const stats = result.kind?.Invariant;
  const status =
    result.status === 'Success'
      ? 'passed'
      : result.status === 'Skipped'
        ? 'skipped'
        : 'failed';

  const entry: InvariantResult = {
    id,
    name,
    status,
    ...(stats ? { runs: stats.runs, calls: stats.calls, reverts: stats.reverts } : {}),
  };

  if (status === 'failed' && result.reason) {
    entry.detail = result.reason;
    entry.counterexample = { revertRaw: String(result.counterexample ?? '') };
  }

  return entry;
}

/**
 * Extract creation bytecode from a Foundry artifact, checking it is usable.
 *
 * Two things must hold. The constructor must take exactly the IPoolManager,
 * because that is what the harness passes; and the creation code must be
 * present, which it is not for an abstract contract or an interface. Both are
 * read from the artifact rather than inferred from source, since the artifact is
 * what actually gets deployed — and a mismatch surfaces otherwise as an opaque
 * revert deep inside `setUp`.
 */
function readArtifact(
  artifactPath: string,
  contractName: string,
): { creationCode: string } | { reason: string } {
  let parsed: {
    abi?: Array<{ type: string; inputs?: unknown[] }>;
    bytecode?: { object?: string };
  };
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    return { reason: `could not read artifact ${artifactPath}: ${(err as Error).message}` };
  }

  const object = parsed.bytecode?.object;
  if (!object || object === '0x' || object.length <= 2) {
    return {
      reason: `${contractName} has no creation bytecode — abstract contracts and interfaces cannot be deployed.`,
    };
  }

  const ctor = parsed.abi?.find((entry) => entry.type === 'constructor');
  const argc = ctor?.inputs?.length ?? 0;
  if (argc !== 1) {
    return {
      reason:
        `${contractName}'s constructor takes ${argc} argument(s); the harness supplies exactly one ` +
        '(the IPoolManager). Hooks with additional constructor arguments are not yet supported — ' +
        'see docs/INVARIANTS.md.',
    };
  }

  return { creationCode: object.startsWith('0x') ? object : `0x${object}` };
}

function skipped(reason: string): HarnessOutcome {
  return {
    status: 'skipped',
    reason,
    invariants: (['I1', 'I2', 'I3'] as const).map((id) => ({
      id,
      name: { I1: 'Conservation and solvency', I2: 'No undeclared extraction', I3: 'Exit liveness' }[
        id
      ],
      status: 'skipped' as const,
      detail: reason,
    })),
  };
}

const basenameOf = (path: string): string => path.split('/').pop() ?? path;
const lastLines = (s: string, n: number): string => s.trim().split('\n').slice(-n).join(' | ');

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  env: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new HookriskError('HR-E303', { detail: `forge exceeded ${Math.round(timeoutMs / 1000)}s.` }));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // forge exits non-zero when a test fails, which for us is a result.
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
