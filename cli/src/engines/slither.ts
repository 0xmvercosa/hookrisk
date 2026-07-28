/**
 * Adapter for hookrisk's own Slither detectors.
 *
 * The static engine hookrisk ships. It runs `slither` with the
 * `slither-hookrisk` plugin registered, reads the JSON report, and normalises
 * each finding into the shared shape so it can be reconciled against other
 * engines.
 *
 * Two things this adapter does that a naive wrapper would not:
 *
 * **It reads stderr for coverage gaps.** Slither logs
 * `Impossible to generate IR for <function>` and carries on, then reports a
 * normal result count. Any detector that relies on SlithIR never sees those
 * functions. We observed this on OpenZeppelin's own `AntiSandwichHook`, where
 * `_afterSwap` — the function that matters — fails to lift. Reporting a clean
 * scan without saying so would convert Slither's blind spot into false
 * assurance, so uncovered functions are collected and surfaced in the manifest.
 *
 * **It treats a non-zero exit as normal.** Slither exits non-zero when it merely
 * *found* something. Only an empty or unparseable report is a failure.
 */

import { spawn } from 'node:child_process';
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

interface SlitherElement {
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

interface SlitherDetectorResult {
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

export interface SlitherOptions {
  /** Path to the slither executable. Defaults to `slither` on PATH. */
  binary?: string;
  enabled?: boolean;
}

export class SlitherEngine implements Engine {
  readonly id = 'hookrisk';
  readonly displayName = 'hookrisk Slither detectors';

  /** Populated by `run`, consumed by the manifest builder. */
  uncoveredFunctions: UncoveredFunction[] = [];

  private readonly binary: string;
  private readonly enabled: boolean;

  constructor(opts: SlitherOptions = {}) {
    this.binary = opts.binary ?? process.env.HOOKRISK_SLITHER_BIN ?? 'slither';
    this.enabled = opts.enabled ?? true;
  }

  async probe(): Promise<{ available: boolean; version: string; reason?: string }> {
    if (!this.enabled) {
      return { available: false, version: 'n/a', reason: 'disabled in configuration' };
    }

    const version = await exec(this.binary, ['--version'], 30_000).catch(() => null);
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
    const detectors = await exec(this.binary, ['--list-detectors'], 60_000).catch(() => null);
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

    const proc = await exec(
      this.binary,
      ['.', '--exclude-dependencies', '--json', '-'],
      ctx.timeoutMs,
      projectRoot,
    ).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));

    // Slither writes progress and IR-lifting failures to stderr regardless of
    // outcome, so parse it before deciding whether the run succeeded.
    this.uncoveredFunctions = collectUncovered(proc.stderr);
    if (this.uncoveredFunctions.length > 0) {
      ctx.log(
        `hookrisk: ${this.uncoveredFunctions.length} function(s) could not be lifted to IR ` +
          'and were not analysed (HR-E205)',
      );
    }

    let report: SlitherReport;
    try {
      report = JSON.parse(proc.stdout) as SlitherReport;
    } catch {
      return {
        engine: this.id,
        version: probe.version,
        status: 'failed',
        reason: `could not parse Slither output: ${lastLines(proc.stderr, 3)}`,
        findings: [],
        durationMs: Date.now() - started,
      };
    }

    if (report.success === false) {
      return {
        engine: this.id,
        version: probe.version,
        status: 'failed',
        reason: report.error ?? 'Slither reported failure',
        findings: [],
        durationMs: Date.now() - started,
      };
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
    const findings = all.filter((f) => !f.location || f.location.file === ctx.sourceFile);
    const elsewhere = all.length - findings.length;
    if (elsewhere > 0) {
      ctx.log(`hookrisk: ${elsewhere} finding(s) in other files, not attributed to this target`);
    }

    ctx.log(`hookrisk: ${findings.length} finding(s)`);
    return {
      engine: this.id,
      version: probe.version,
      status: 'ok',
      findings,
      durationMs: Date.now() - started,
    };
  }
}

/** Translate one Slither detector result into hookrisk's shape. */
function normalise(result: SlitherDetectorResult): Finding | null {
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

  return {
    id: makeFindingId(meta.ruleClass, location, undefined),
    ruleClass: meta.ruleClass,
    title,
    description,
    severity,
    confidence,
    location,
    function: element?.type === 'function' ? { name: element.name } : undefined,
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
 * Collect functions Slither could not lift to IR.
 *
 * These are the silent gaps. Slither logs them and continues; without this the
 * manifest would say "0 findings" for a contract whose most interesting function
 * was never examined.
 */
export function collectUncovered(stderr: string): UncoveredFunction[] {
  const out: UncoveredFunction[] = [];
  const seen = new Set<string>();

  for (const match of stderr.matchAll(UNCOVERED_RE)) {
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

const lastLines = (s: string, n: number): string => s.trim().split('\n').slice(-n).join(' | ');

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
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
      // Slither exits non-zero when it found something. That is a result.
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
