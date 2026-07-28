/**
 * Adapter for BlockSec's HookScan (https://github.com/blocksecteam/hookscan).
 *
 * Why an adapter and not a reimplementation
 * -----------------------------------------
 * HookScan is a Yul/CFG-level static analyzer for v4 hooks, derived from
 * BlockSec's Phalcon Inspector and backed by their published research. Two of
 * its four detectors cover the same ground as our HS-01 and HS-04, and it does
 * so from bytecode, which catches cases source-level analysis misses. The other
 * two — unprotected `unlockCallback` and `SELFDESTRUCT` — are coverage hookrisk
 * does not have at all.
 *
 * Rewriting that would be worse in every direction: more code, less accurate,
 * and it would misrepresent whose work it is. So hookrisk runs their tool and
 * attributes it. Findings the two engines agree on are merged into a single
 * corroborated finding with raised confidence (see `dedupe.ts`), never counted
 * twice.
 *
 * Licensing
 * ---------
 * HookScan is AGPL-3.0. hookrisk invokes it as an isolated process — a container
 * or a separate interpreter — and never links against it or redistributes it.
 * That is mere aggregation, so hookrisk's own MIT licensing is unaffected, and
 * no HookScan code ships in this repository. The user obtains it themselves via
 * `docker pull`. See NOTICE and docs/PRIOR_ART.md.
 *
 * This engine is opt-in and never required: if Docker is absent the scan
 * proceeds without it and the manifest records the engine as skipped, so a
 * reader can tell "no unprotected callback was found" apart from "nothing
 * looked".
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  Confidence,
  Engine,
  EngineContext,
  EngineResult,
  Finding,
  RuleClass,
  Severity,
} from '../types.js';
import { makeFindingId } from './dedupe.js';

/** Default published image. Overridable for air-gapped or pinned deployments. */
const DEFAULT_IMAGE = 'futuretech6/hookscan';

/**
 * BlockSec detector name -> our canonical class.
 *
 * The two entries that map onto classes we also detect are what make dedupe
 * work; the two that do not are pure coverage gain.
 */
const RULE_CLASS_MAP: Record<string, RuleClass> = {
  UniswapPublicHook: 'unprotected-hook-callback',
  UniswapUpgradableHook: 'upgradeable-hook',
  UniswapPublicCallback: 'unprotected-unlock-callback',
  UniswapSuicidalHook: 'selfdestruct',
};

/**
 * HookScan reports `high | medium | low | info`. Our scale adds `critical`.
 *
 * We deliberately do not promote anything to `critical` here. Severity escalation
 * is hookrisk's judgement, applied later with context the engine does not have
 * (TVL declaration, whether the pool is live), and silently upgrading another
 * tool's rating would misattribute an opinion to BlockSec that they did not make.
 */
const SEVERITY_MAP: Record<string, Severity> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

const CONFIDENCE_MAP: Record<string, Confidence> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Which framework dimensions and triggers each class informs. */
const FRAMEWORK_LINKS: Partial<
  Record<RuleClass, { dimensions?: string[]; triggers?: string[] }>
> = {
  'unprotected-hook-callback': { dimensions: ['complexity'] },
  'unprotected-unlock-callback': { dimensions: ['complexity'] },
  'upgradeable-hook': { dimensions: ['upgradeability'], triggers: ['upgradeable'] },
  selfdestruct: { dimensions: ['upgradeability'], triggers: ['upgradeable'] },
};

/** Shape of one entry in HookScan's `detection_results` array. */
interface BlockSecResult {
  detector_name: string;
  vulnerability: string;
  external_function?: string | null;
  function_selector?: string;
  yul_call_stack?: string[];
  source_location?: string;
  severity: string;
  confidence: string;
  additional_info?: unknown;
}

interface BlockSecOutput {
  detection_results?: BlockSecResult[];
  error?: string;
  error_type?: string;
}

export interface BlockSecOptions {
  /** Container image. Defaults to the published one. */
  image?: string;
  /** Container runtime. `podman` works unchanged. */
  runtime?: string;
  /** Skip entirely, e.g. when the user has not accepted pulling a third-party image. */
  enabled?: boolean;
}

export class BlockSecEngine implements Engine {
  readonly id = 'blocksec';
  readonly displayName = 'BlockSec HookScan';
  readonly upstream = {
    url: 'https://github.com/blocksecteam/hookscan',
    license: 'AGPL-3.0',
  };

  private readonly image: string;
  private readonly runtime: string;
  private readonly enabled: boolean;

  constructor(opts: BlockSecOptions = {}) {
    this.image = opts.image ?? process.env.HOOKRISK_BLOCKSEC_IMAGE ?? DEFAULT_IMAGE;
    this.runtime = opts.runtime ?? process.env.HOOKRISK_CONTAINER_RUNTIME ?? 'docker';
    this.enabled = opts.enabled ?? true;
  }

  async probe(): Promise<{ available: boolean; version: string; reason?: string }> {
    if (!this.enabled) {
      return { available: false, version: 'n/a', reason: 'disabled in configuration' };
    }

    const runtime = await exec(this.runtime, ['--version'], 15_000).catch(() => null);
    if (!runtime || runtime.code !== 0) {
      return {
        available: false,
        version: 'n/a',
        reason: `\`${this.runtime}\` not available; BlockSec HookScan runs as a container`,
      };
    }

    // `image inspect` succeeds only when the image is present locally. We do not
    // pull implicitly: downloading a third-party image is the user's decision,
    // and a scan that silently fetches hundreds of megabytes is a bad surprise
    // in CI.
    const img = await exec(this.runtime, ['image', 'inspect', this.image], 30_000).catch(
      () => null,
    );
    if (!img || img.code !== 0) {
      return {
        available: false,
        version: 'n/a',
        reason: `image \`${this.image}\` not present locally — run \`${this.runtime} pull ${this.image}\` to enable this engine`,
      };
    }

    const digest = firstLine(img.stdout.match(/"Id":\s*"([^"]+)"/)?.[1] ?? 'unknown');
    return { available: true, version: `${this.image}@${digest.slice(0, 19)}` };
  }

  async run(ctx: EngineContext): Promise<EngineResult> {
    const started = Date.now();
    const probe = await this.probe();

    if (!probe.available) {
      ctx.log(`blocksec: skipped (${probe.reason})`);
      return {
        engine: this.id,
        version: probe.version,
        status: 'skipped',
        reason: probe.reason,
        findings: [],
        durationMs: Date.now() - started,
      };
    }

    const projectRoot = resolve(ctx.projectRoot);
    if (!existsSync(projectRoot)) {
      return this.failure(probe.version, started, `project root does not exist: ${projectRoot}`);
    }

    // Mirrors the invocation documented in HookScan's README. `CONTRACT` is
    // resolved inside the container relative to /project, and `--silent` makes
    // the tool report failures as JSON instead of a stack trace, which keeps a
    // crash in their analyzer from taking down the whole hookrisk run.
    const args = [
      'run',
      '--rm',
      '--network',
      'none', // static analysis needs no network; deny it.
      '-v',
      `${projectRoot}:/project`,
      '-e',
      `SOLC_VERSION=${ctx.solcVersion}`,
      '-e',
      `CONTRACT=${ctx.sourceFile}:${ctx.contractName}`,
      this.image,
      '--silent',
    ];

    ctx.log(`blocksec: ${this.runtime} run ${this.image} (${ctx.sourceFile}:${ctx.contractName})`);

    const proc = await exec(this.runtime, args, ctx.timeoutMs).catch((err: Error) => {
      return { code: -1, stdout: '', stderr: err.message };
    });

    if (proc.code !== 0 && !proc.stdout.trim()) {
      return this.failure(
        probe.version,
        started,
        `container exited ${proc.code}: ${lastLines(proc.stderr, 3)}`,
      );
    }

    let parsed: BlockSecOutput;
    try {
      parsed = JSON.parse(extractJson(proc.stdout));
    } catch {
      return this.failure(
        probe.version,
        started,
        `could not parse HookScan output: ${lastLines(proc.stdout || proc.stderr, 3)}`,
      );
    }

    if (parsed.error) {
      // HookScan itself failed on this contract. That is informative — often it
      // means the contract does not compile under the requested solc — but it is
      // not a hookrisk failure and must not abort the scan.
      return this.failure(
        probe.version,
        started,
        `HookScan reported ${parsed.error_type ?? 'an error'}: ${firstLine(parsed.error)}`,
      );
    }

    const findings = (parsed.detection_results ?? []).map((r) =>
      this.normalise(r, ctx.sourceFile),
    );

    ctx.log(`blocksec: ${findings.length} finding(s)`);
    return {
      engine: this.id,
      version: probe.version,
      status: 'ok',
      findings,
      durationMs: Date.now() - started,
    };
  }

  /** Translate one HookScan result into hookrisk's shape. */
  private normalise(r: BlockSecResult, fallbackFile: string): Finding {
    const ruleClass: RuleClass =
      RULE_CLASS_MAP[r.detector_name] ?? 'unprotected-hook-callback';
    const severity = SEVERITY_MAP[r.severity] ?? 'medium';
    const confidence = CONFIDENCE_MAP[r.confidence] ?? 'medium';

    // `source_location` is "path/to/File.sol:123". Split on the last colon so
    // Windows drive letters and paths containing colons survive.
    let location: Finding['location'] = null;
    if (r.source_location) {
      const idx = r.source_location.lastIndexOf(':');
      const file = idx > 0 ? r.source_location.slice(0, idx) : r.source_location;
      const line = idx > 0 ? Number.parseInt(r.source_location.slice(idx + 1), 10) : NaN;
      location = {
        file: normaliseContainerPath(file, fallbackFile),
        line: Number.isFinite(line) ? line : 1,
      };
    }

    const evidence: string[] = [`BlockSec HookScan: ${r.vulnerability}`];
    if (r.yul_call_stack?.length) {
      evidence.push(`Yul call stack: ${r.yul_call_stack.join(' -> ')}`);
    }

    const links = FRAMEWORK_LINKS[ruleClass] ?? {};

    return {
      id: makeFindingId(ruleClass, location, r.function_selector),
      ruleClass,
      title: humanTitle(ruleClass, r),
      description: r.vulnerability,
      severity,
      confidence,
      location,
      function: {
        name: r.external_function ?? undefined,
        selector: r.function_selector,
      },
      evidence,
      engines: [
        {
          engine: this.id,
          nativeRule: r.detector_name,
          severity,
          confidence,
          detail: r.additional_info ? { additionalInfo: r.additional_info } : undefined,
        },
      ],
      informsDimensions: links.dimensions,
      informsTriggers: links.triggers,
      references: ['https://github.com/blocksecteam/hookscan'],
    };
  }

  private failure(version: string, started: number, reason: string): EngineResult {
    return {
      engine: this.id,
      version,
      status: 'failed',
      reason,
      findings: [],
      durationMs: Date.now() - started,
    };
  }
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function humanTitle(ruleClass: RuleClass, r: BlockSecResult): string {
  const fn = r.external_function ? `\`${r.external_function}\`` : 'a callback';
  switch (ruleClass) {
    case 'unprotected-hook-callback':
      return `${fn} does not restrict callers to the PoolManager`;
    case 'unprotected-unlock-callback':
      return `${fn} does not restrict callers to the contract itself`;
    case 'upgradeable-hook':
      return 'Contract delegate-calls a mutable address';
    case 'selfdestruct':
      return 'Contract can self-destruct';
    default:
      return r.vulnerability;
  }
}

/**
 * Map a container path back onto the host project.
 *
 * HookScan sees the project mounted at /project, so its paths are prefixed with
 * it. Stripping the prefix yields the project-relative path the rest of hookrisk
 * uses, keeping SARIF locations clickable in a GitHub diff.
 */
function normaliseContainerPath(file: string, fallback: string): string {
  const stripped = file.replace(/^\/project\/?/, '');
  return stripped.length > 0 ? stripped : fallback;
}

/**
 * Pull the JSON object out of mixed output.
 *
 * The container entrypoint prints `arg list: ...` before handing over, so stdout
 * is not pure JSON. Scanning to the first `{` is enough because the tool emits
 * exactly one top-level object.
 */
function extractJson(stdout: string): string {
  const start = stdout.indexOf('{');
  return start >= 0 ? stdout.slice(start) : stdout;
}

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? '';
const lastLines = (s: string, n: number): string =>
  s.trim().split('\n').slice(-n).join(' | ');

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command with a hard timeout, capturing both streams.
 *
 * Never uses a shell: the contract name and file path reach us from user input
 * and from on-chain data, and neither is trustworthy enough to interpolate into
 * a command line.
 */
function exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`\`${cmd}\` exceeded ${Math.round(timeoutMs / 1000)}s`));
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
