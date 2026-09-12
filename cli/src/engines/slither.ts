/**
 * Adapter for hookrisk's own Slither detectors.
 *
 * The static engine hookrisk ships. It runs `slither` with the
 * `slither-hookrisk` plugin registered, reads the JSON report, and normalises
 * each finding into the shared shape so it can be reconciled against other
 * engines.
 *
 * Three things this adapter does that a naive wrapper would not:
 *
 * **It writes the report to a file, not stdout.** `--json -` makes Slither
 * capture *both* of its streams into a buffer it only flushes on a clean exit.
 * A compile failure raises crytic-compile's `InvalidCompilation`, which is not
 * a `SlitherException`, so the buffer is never flushed and the process exits
 * with nothing on either stream — the observed "could not parse Slither output:"
 * with nothing after the colon. The same capture swallowed every
 * `Impossible to generate IR` line on a successful run, so the coverage
 * reporting below never saw one from the CLI. With `--json <file>` Slither
 * mirrors the streams instead of blocking them, and both problems go away.
 *
 * **It reads the streams for coverage gaps.** Slither logs
 * `Impossible to generate IR for <function>` and carries on, then reports a
 * normal result count. Any detector that relies on SlithIR never sees those
 * functions. We observed this on OpenZeppelin's own `AntiSandwichHook`, where
 * `_afterSwap` — the function that matters — fails to lift. Reporting a clean
 * scan without saying so would convert Slither's blind spot into false
 * assurance, so uncovered functions are collected and surfaced in the manifest.
 *
 * **It treats a non-zero exit as normal.** Slither exits non-zero when it merely
 * *found* something. Only a missing or unparseable report is a failure, and a
 * failure always carries a reason: classified against the error catalogue when
 * the output matches an entry, the last lines of output when it does not.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describeFailure } from '../errors.js';
import type {
  Confidence,
  Engine,
  EngineContext,
  EngineResult,
  Finding,
  RuleClass,
  Severity,
} from '../types.js';
import { callbackSelector, makeFindingId } from './dedupe.js';

/** Slither impact levels mapped onto our severity scale. */
const SEVERITY_MAP: Record<string, Severity> = {
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Informational: 'info',
  Optimization: 'info',
};

const CONFIDENCE_MAP: Record<string, Confidence> = {
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

/** `ERROR:ContractSolcParsing:Impossible to generate IR for X.y (path#1-2):` */
const UNCOVERED_RE = /Impossible to generate IR for ([\w.]+)\s*\(([^)]*)\)/g;

export interface SlitherElement {
  type: string;
  name: string;
  source_mapping?: {
    filename_relative?: string;
    filename_short?: string;
    lines?: number[];
    is_dependency?: boolean;
  };
  type_specific_fields?: Record<string, unknown>;
}

export interface SlitherDetectorResult {
  check: string;
  impact: string;
  confidence: string;
  description: string;
  elements: SlitherElement[];
  /** Injected by HookriskDetector._report. */
  hookrisk?: {
    ruleClass: RuleClass;
    informsDimensions: string[];
    informsTriggers: string[];
    isClassification: boolean;
    /** See `Finding.discriminator`. Optional: older detectors do not send one. */
    discriminator?: string;
  };
}

interface SlitherReport {
  success: boolean;
  error: string | null;
  results?: { detectors?: SlitherDetectorResult[] };
}

export interface UncoveredFunction {
  contract: string;
  function: string;
  reason: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How the engine runs a process. Injectable so the failure paths are testable without Slither. */
export type ExecFn = (cmd: string, args: string[], timeoutMs: number, cwd?: string) => Promise<ExecResult>;

export interface SlitherOptions {
  /** Path to the slither executable. Defaults to `slither` on PATH. */
  binary?: string;
  enabled?: boolean;
  exec?: ExecFn;
}

export class SlitherEngine implements Engine {
  readonly id = 'hookrisk';
  readonly displayName = 'hookrisk Slither detectors';

  /** Populated by `run`, consumed by the manifest builder. */
  uncoveredFunctions: UncoveredFunction[] = [];

  private readonly binary: string;
  private readonly enabled: boolean;
  private readonly exec: ExecFn;

  constructor(opts: SlitherOptions = {}) {
    this.binary = opts.binary ?? process.env.HOOKRISK_SLITHER_BIN ?? 'slither';
    this.enabled = opts.enabled ?? true;
    this.exec = opts.exec ?? exec;
  }

  async probe(): Promise<{ available: boolean; version: string; reason?: string }> {
    if (!this.enabled) {
      return { available: false, version: 'n/a', reason: 'disabled in configuration' };
    }

    const version = await this.exec(this.binary, ['--version'], 30_000).catch(() => null);
    if (!version || version.code !== 0) {
      return {
        available: false,
        version: 'n/a',
        reason: '`slither` not available — install with `pipx install slither-analyzer` (HR-E002)',
      };
    }

    // Registration is separate from installation: the plugin can be on disk in a
    // different environment than the one running Slither, in which case the
    // detectors exist and are invisible.
    const detectors = await this.exec(this.binary, ['--list-detectors'], 60_000).catch(() => null);
    if (!detectors || !/hookrisk-/.test(detectors.stdout)) {
      return {
        available: false,
        version: version.stdout.trim(),
        reason:
          'hookrisk detectors are not registered with this Slither — run `make install-detectors` (HR-E004)',
      };
    }

    return { available: true, version: version.stdout.trim() };
  }

  async run(ctx: EngineContext): Promise<EngineResult> {
    const started = Date.now();
    const probe = await this.probe();

    if (!probe.available) {
      ctx.log(`hookrisk: skipped (${probe.reason})`);
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
    ctx.log(`hookrisk: slither ${ctx.sourceFile}:${ctx.contractName}`);

    const failed = (reason: string): EngineResult => ({
      engine: this.id,
      version: probe.version,
      status: 'failed',
      reason,
      findings: [],
      durationMs: Date.now() - started,
    });

    // The report goes to a scratch file rather than stdout: see the module
    // comment for why `--json -` loses every diagnostic on the paths that matter.
    const scratch = mkdtempSync(join(tmpdir(), 'hookrisk-slither-'));
    const reportPath = join(scratch, 'report.json');
    try {
      const proc = await this.exec(
        this.binary,
        ['.', '--exclude-dependencies', '--json', reportPath],
        ctx.timeoutMs,
        projectRoot,
      ).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));

      // Which stream a message lands on depends on how Slither was asked to
      // report (its logger goes to stdout unless JSON is on stdout), so both are
      // read together and neither is trusted to be the "diagnostic" one.
      const output = `${proc.stdout}\n${proc.stderr}`;
      this.uncoveredFunctions = collectUncovered(output);
      if (this.uncoveredFunctions.length > 0) {
        ctx.log(
          `hookrisk: ${this.uncoveredFunctions.length} function(s) could not be lifted to IR ` +
            'and were not analysed (HR-E205)',
        );
      }

      let report: SlitherReport;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8')) as SlitherReport;
      } catch {
        const reason = describeSlitherFailure(output, proc.code);
        ctx.log(`hookrisk: failed — ${reason}`);
        return failed(reason);
      }

      if (report.success === false) {
        const reason = describeSlitherFailure(`${report.error ?? ''}\n${output}`, proc.code);
        ctx.log(`hookrisk: failed — ${reason}`);
        return failed(reason);
      }

      const all = (report.results?.detectors ?? [])
        .filter((r) => r.check.startsWith('hookrisk-'))
        .map((r) => normalise(r))
        .filter((f): f is Finding => f !== null);

      // Slither has to compile the whole project — imports and inheritance make
      // anything narrower unreliable — but a scan of `src/MyHook.sol:MyHook` must
      // report on that hook, not on every other contract in the repository.
      // Reporting a neighbour's problems against this target would inflate its
      // score with findings its author cannot act on, and the score is the point.
      const { findings, unattributed } = partitionByTarget(all, ctx.sourceFile);
      if (unattributed.length > 0) {
        const elsewhere = unattributed.reduce((n, u) => n + u.count, 0);
        ctx.log(
          `hookrisk: ${elsewhere} finding(s) in other files, not attributed to this target: ` +
            unattributed.map((u) => `${u.file} (${u.count})`).join(', '),
        );
      }

      const targetCoverage = coverageOf(findings, ctx.contractName);
      if (!targetCoverage.covered) {
        ctx.log(`hookrisk: did not analyse the target — ${targetCoverage.reason}`);
      }

      ctx.log(`hookrisk: ${findings.length} finding(s)`);
      return {
        engine: this.id,
        version: probe.version,
        status: 'ok',
        findings,
        durationMs: Date.now() - started,
        targetCoverage,
        ...(unattributed.length > 0 ? { unattributed } : {}),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Translate one Slither detector result into hookrisk's shape. */
export function normalise(result: SlitherDetectorResult): Finding | null {
  const meta = result.hookrisk;
  if (!meta) {
    // A hookrisk-prefixed check with no metadata means a detector forgot to use
    // `HookriskDetector._report`. Dropping it is deliberate: without a rule
    // class it cannot be reconciled with other engines or mapped to a scoring
    // dimension, so admitting it would put an unattributable row in the report.
    return null;
  }

  // Prefer the first element that is not a dependency; findings anchored in
  // lib/ point at code the user did not write.
  const element =
    result.elements.find((e) => e.source_mapping && !e.source_mapping.is_dependency) ??
    result.elements[0];

  const mapping = element?.source_mapping;
  const location =
    mapping?.filename_relative && mapping.lines?.length
      ? {
          file: mapping.filename_relative,
          line: mapping.lines[0]!,
          endLine: mapping.lines[mapping.lines.length - 1]!,
        }
      : null;

  const severity = SEVERITY_MAP[result.impact] ?? 'medium';
  const confidence = CONFIDENCE_MAP[result.confidence] ?? 'medium';

  const description = result.description.trim();
  const title = firstSentence(description);

  // A callback's selector is attached when the name resolves to one, so the id
  // and group key of an HS-01 here match the same defect seen by an engine
  // that only knows selectors.
  const fn =
    element?.type === 'function'
      ? { name: element.name, ...(callbackSelector(element.name) ? { selector: callbackSelector(element.name) } : {}) }
      : undefined;
  const discriminator =
    typeof meta.discriminator === 'string' && meta.discriminator.length > 0
      ? meta.discriminator
      : undefined;

  return {
    id: makeFindingId(meta.ruleClass, location, fn?.selector, discriminator),
    ruleClass: meta.ruleClass,
    title,
    description,
    severity,
    confidence,
    location,
    ...(fn ? { function: fn } : {}),
    ...(discriminator ? { discriminator } : {}),
    evidence: [description],
    engines: [
      {
        engine: 'hookrisk',
        nativeRule: result.check,
        severity,
        confidence,
      },
    ],
    informsDimensions: meta.informsDimensions,
    informsTriggers: meta.informsTriggers,
  };
}

/**
 * Split findings into those on the target file and those elsewhere, the latter
 * counted per file so the report can say what was set aside. A finding with no
 * location cannot be placed and is kept: dropping it would hide a detector's
 * output on the strength of a missing source mapping.
 */
export function partitionByTarget(
  all: Finding[],
  sourceFile: string,
): { findings: Finding[]; unattributed: Array<{ file: string; count: number }> } {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  for (const f of all) {
    if (!f.location || f.location.file === sourceFile) findings.push(f);
    else counts.set(f.location.file, (counts.get(f.location.file) ?? 0) + 1);
  }
  const unattributed = [...counts]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return { findings, unattributed };
}

/**
 * Whether hookrisk's detectors actually examined the target.
 *
 * An `unsupported-hook-abi` classification is the detectors saying "this is
 * hook-shaped and I could not read it". Every other finding — or none — on such
 * a target is silence from code that never looked, and the scorer must not
 * turn that silence into zeros.
 */
export function coverageOf(
  findings: Finding[],
  contractName: string,
): { covered: boolean; reason?: string } {
  const unsupported = findings.find((f) => f.ruleClass === 'unsupported-hook-abi');
  if (unsupported) {
    return { covered: false, reason: `${contractName} uses a hook ABI hookrisk cannot analyse: ${unsupported.title}` };
  }
  return { covered: true };
}

/**
 * Reason for a run that produced no readable report. Never empty: an engine
 * row that says "failed" with no reason is indistinguishable from a bug in the
 * adapter, and the user's next step depends on which it was.
 */
export function describeSlitherFailure(output: string, exitCode: number): string {
  return describeFailure(
    output,
    `Slither exited with code ${exitCode} and wrote nothing to stdout, stderr or its report ` +
      '(HR-E901); run `slither . --exclude-dependencies` in the project to see why',
  );
}

/**
 * Collect functions Slither could not lift to IR.
 *
 * These are the silent gaps. Slither logs them and continues; without this the
 * manifest would say "0 findings" for a contract whose most interesting function
 * was never examined.
 */
export function collectUncovered(output: string): UncoveredFunction[] {
  const out: UncoveredFunction[] = [];
  const seen = new Set<string>();

  for (const match of output.matchAll(UNCOVERED_RE)) {
    const qualified = match[1]!;
    const location = match[2] ?? '';
    if (seen.has(qualified)) continue;
    seen.add(qualified);

    const dot = qualified.lastIndexOf('.');
    out.push({
      contract: dot > 0 ? qualified.slice(0, dot) : qualified,
      function: dot > 0 ? qualified.slice(dot + 1) : qualified,
      reason: `Slither could not generate IR${location ? ` (${location})` : ''}; this function was not analysed`,
    });
  }
  return out;
}

function firstSentence(text: string): string {
  const line = text.split('\n')[0] ?? text;
  const stop = line.indexOf('. ');
  const sentence = stop > 0 ? line.slice(0, stop) : line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** Run a command with a hard timeout. Never uses a shell. */
function exec(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s`));
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
      // Slither exits non-zero when it found something. That is a result.
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
