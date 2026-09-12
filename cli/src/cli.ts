#!/usr/bin/env node
/**
 * hookrisk command line.
 *
 * `hookrisk scan <file>:<Contract>` runs every enabled engine over a hook,
 * reconciles their findings, scores the result against the Uniswap Foundation's
 * framework, and writes a manifest, a human report and a SARIF file.
 *
 * Exit codes are meaningful and documented in `errors/catalog.json`:
 *   0   scan completed, gate passed
 *   2   scan completed, gate failed — a result, not an error
 *   10+ hookrisk could not run; the code identifies why
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDeclarationsComplete,
  configTemplate,
  loadConfig,
  type HookriskConfig,
} from './config.js';
import { HookriskError, supportsColour } from './errors.js';
import { BlockSecEngine } from './engines/blocksec.js';
import { mergeEngineResults } from './engines/dedupe.js';
import { SlitherEngine } from './engines/slither.js';
import {
  buildManifest,
  renderMarkdown,
  validateManifest,
  type HarnessSummary,
  type InvariantResult,
} from './manifest.js';
import { parseDeclaredPermissions, permissionsFrom, resolveProject, runHarness } from './harness.js';
import { toSarif } from './sarif.js';
import { deriveScoringInput } from './scoring/derive.js';
import { loadRubric } from './scoring/rubric.js';
import { score } from './scoring/score.js';
import type { Engine, EngineContext, EngineResult } from './types.js';

const VERSION = '0.1.0';

interface ScanArgs {
  target?: string;
  projectRoot: string;
  configPath: string;
  outDir: string;
  timeoutMs: number;
  skipStatic: boolean;
  skipDynamic: boolean;
  noGate: boolean;
  noValidate: boolean;
  verbose: boolean;
  json: boolean;
}

function usage(): string {
  return `hookrisk ${VERSION} — executable risk assessment for Uniswap v4 hooks

USAGE
  hookrisk scan <file.sol:Contract> [options]
  hookrisk init [--config <path>]
  hookrisk engines
  hookrisk --version

SCAN OPTIONS
  --root <dir>        Foundry project root (default: cwd)
  --config <path>     hookrisk.toml (default: <root>/hookrisk.toml)
  --out <dir>         Where to write artifacts (default: <root>)
  --timeout <sec>     Per-engine budget (default: 600)
  --skip-static       Do not run static analysis; affected dimensions are
                      reported unmeasured, never as zero
  --skip-dynamic      Do not run the differential harness
  --no-gate           Report without failing on the configured thresholds
  --no-validate       Emit the manifest even if it fails schema validation
  --verbose           Print engine invocations and progress
  --json              Print the manifest to stdout instead of a summary

OUTPUT
  hook-risk.json      Machine-readable manifest, validated against
                      schema/hook-risk.schema.json
  HOOK_RISK.md        Human report
  hookrisk.sarif      For GitHub code scanning

Full documentation: https://github.com/0xmvercosa/hookrisk
`;
}

// --------------------------------------------------------------------------- //
// Argument parsing
// --------------------------------------------------------------------------- //

function parseScanArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = {
    projectRoot: process.cwd(),
    configPath: '',
    outDir: '',
    timeoutMs: 600_000,
    skipStatic: false,
    skipDynamic: false,
    noGate: false,
    noValidate: false,
    verbose: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new HookriskError('HR-E102', { detail: `${arg} requires a value.` });
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--root':
        args.projectRoot = resolve(next());
        break;
      case '--config':
        args.configPath = resolve(next());
        break;
      case '--out':
        args.outDir = resolve(next());
        break;
      case '--timeout':
        args.timeoutMs = Number.parseInt(next(), 10) * 1000;
        break;
      case '--skip-static':
        args.skipStatic = true;
        break;
      case '--skip-dynamic':
        args.skipDynamic = true;
        break;
      case '--no-gate':
        args.noGate = true;
        break;
      case '--no-validate':
        args.noValidate = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new HookriskError('HR-E102', { detail: `Unknown option ${arg}.` });
        }
        if (args.target) {
          throw new HookriskError('HR-E102', {
            detail: `Multiple targets given: ${args.target} and ${arg}.`,
          });
        }
        args.target = arg;
    }
  }

  args.configPath ||= join(args.projectRoot, 'hookrisk.toml');
  args.outDir ||= args.projectRoot;
  return args;
}

/** Split `path/to/File.sol:Contract` into its parts. */
function resolveTarget(target: string | undefined, projectRoot: string): {
  sourceFile: string;
  contractName: string;
} {
  if (!target) {
    throw new HookriskError('HR-E102', {
      detail: 'No target given. Pass `path/to/Hook.sol:ContractName`.',
    });
  }

  const colon = target.lastIndexOf(':');
  if (colon <= 0) {
    throw new HookriskError('HR-E102', {
      detail: `\`${target}\` is not of the form path/to/Hook.sol:ContractName.`,
    });
  }

  const sourceFile = target.slice(0, colon);
  const contractName = target.slice(colon + 1);

  if (!existsSync(resolve(projectRoot, sourceFile))) {
    throw new HookriskError('HR-E102', {
      detail: `Source file not found: ${sourceFile}`,
      context: { root: projectRoot },
    });
  }

  return { sourceFile, contractName };
}

// --------------------------------------------------------------------------- //
// Commands
// --------------------------------------------------------------------------- //

async function commandScan(argv: string[]): Promise<number> {
  const args = parseScanArgs(argv);
  const { sourceFile, contractName } = resolveTarget(args.target, args.projectRoot);

  const log = (message: string): void => {
    if (args.verbose) process.stderr.write(`  ${message}\n`);
  };

  let config: HookriskConfig;
  if (existsSync(args.configPath)) {
    config = loadConfig(args.configPath);
  } else {
    throw new HookriskError('HR-E101', {
      detail: `No config at ${args.configPath}.`,
      context: { fix: 'run `hookrisk init` to generate one' },
    });
  }
  assertDeclarationsComplete(config);

  // --- engines ---
  const engines: Engine[] = [];
  if (!args.skipStatic && config.engines.hookrisk !== false) {
    engines.push(new SlitherEngine());
  }
  if (!args.skipStatic && config.engines.blocksec === true) {
    engines.push(new BlockSecEngine());
  }

  // Where the artifacts are and which solc built them, from forge itself. Both
  // the static engines (solc version) and the harness (artifact path) depend
  // on it, and guessing either is how a built project gets told to build.
  const project = await resolveProject(args.projectRoot, sourceFile, contractName);
  for (const note of project.notes) log(`project: ${note}`);
  log(
    `project: out=${project.artifactDir} solc=${project.solcVersion} (${project.solcSource})` +
      (project.artifactPath ? ` artifact=${project.artifactPath}` : ` artifact: ${project.artifactReason}`),
  );

  const context: EngineContext = {
    projectRoot: args.projectRoot,
    sourceFile,
    contractName,
    solcVersion: project.solcVersion,
    timeoutMs: args.timeoutMs,
    log,
  };

  const engineResults: EngineResult[] = [];
  const engineMeta = new Map<string, { displayName: string; upstream?: { url: string; license: string } }>();
  let uncoveredFunctions: Array<{ contract: string; function: string; reason: string }> = [];

  for (const engine of engines) {
    engineMeta.set(engine.id, {
      displayName: engine.displayName,
      ...(engine.upstream ? { upstream: engine.upstream } : {}),
    });
    const result = await engine.run(context);
    engineResults.push(result);
    if (engine instanceof SlitherEngine) {
      uncoveredFunctions = engine.uncoveredFunctions;
    }
  }

  if (engines.length === 0) {
    engineResults.push({
      engine: 'hookrisk',
      version: 'n/a',
      status: 'skipped',
      reason: args.skipStatic ? '--skip-static' : 'disabled in configuration',
      findings: [],
      durationMs: 0,
    });
    engineMeta.set('hookrisk', { displayName: 'hookrisk Slither detectors' });
  }

  const { findings, stats } = mergeEngineResults(engineResults);

  // --- score ---
  const rubric = loadRubric();
  const scoringInput = deriveScoringInput({
    findings,
    engineResults,
    declared: config.declared,
    dimensionIds: rubric.dimensions.map((d) => d.id),
  });
  const scored = score(scoringInput, rubric);

  // --- invariants ---
  // The dynamic layer executes the hook rather than reading it, so it needs the
  // permission set to place the hook at a flag-bearing address. Null when this
  // file inherits getHookPermissions(); the harness then derives the flags from
  // the compiled runtime code and reports what it found.
  const permissions = parseDeclaredPermissions(readFileSync(resolve(args.projectRoot, sourceFile), 'utf8'));

  let invariants: InvariantResult[] = [];
  let harness: HarnessSummary = { version: 'n/a', status: 'skipped', reason: '--skip-dynamic', durationMs: 0 };
  const permissionsSection: Record<string, unknown> = {};
  if (permissions) permissionsSection.fromSource = permissions;

  if (!args.skipDynamic) {
    const outcome = await runHarness({
      project,
      sourceFile,
      contractName,
      permissions,
      ...(config.harness.constructorArgs ? { constructorArgs: config.harness.constructorArgs } : {}),
      maxFeeBips: config.declared.maxFeeBips ?? 0,
      timeoutMs: args.timeoutMs,
      log,
    });
    invariants = outcome.invariants;
    harness = {
      version: outcome.version,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      durationMs: outcome.durationMs,
    };
    if (outcome.status !== 'ok') {
      log(`harness: ${outcome.status} — ${outcome.reason ?? ''}`);
    }
    if (outcome.run) {
      // What the harness actually deployed under. Recorded even when it agrees
      // with the source declaration: this is the set the PoolManager obeyed.
      permissionsSection.fromRuntime = permissionsFrom(outcome.run.flags);
      permissionsSection.harnessRun = {
        flags: outcome.run.flags,
        permissionsDerived: outcome.run.permissionsDerived,
        customCurve: outcome.run.customCurve,
        dynamicFee: outcome.run.dynamicFee,
        seeded: outcome.run.seeded,
        ...(outcome.run.hookedSeedRevert ? { hookedSeedRevert: outcome.run.hookedSeedRevert } : {}),
      };
    }
  }

  // --- manifest ---
  const manifest = buildManifest({
    toolVersion: VERSION,
    commandLine: `hookrisk scan ${args.target}`,
    target: {
      mode: 'source',
      contractName,
      sourceFile,
      solcVersion: context.solcVersion,
      artifactDir: relative(args.projectRoot, project.artifactDir) || '.',
      projectConfigSource: project.configSource,
    },
    ...(Object.keys(permissionsSection).length > 0 ? { permissions: permissionsSection } : {}),
    findings,
    invariants,
    score: scored,
    engineResults,
    engineMeta,
    harness,
    corroboratedFindings: stats.corroborated,
    uncoveredFunctions,
    staticAnalysisSkipped: args.skipStatic,
    ...(args.noGate ? {} : { gate: config.gate }),
  });

  if (!args.noValidate) {
    try {
      validateManifest(manifest);
    } catch (err) {
      // Write the rejected manifest so it can be attached to a bug report.
      mkdirSync(args.outDir, { recursive: true });
      writeFileSync(join(args.outDir, 'hook-risk.invalid.json'), JSON.stringify(manifest, null, 2));
      throw err;
    }
  }

  // --- write ---
  mkdirSync(args.outDir, { recursive: true });
  const manifestPath = join(args.outDir, 'hook-risk.json');
  const reportPath = join(args.outDir, 'HOOK_RISK.md');
  const sarifPath = join(args.outDir, 'hookrisk.sarif');

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(reportPath, `${renderMarkdown(manifest)}\n`);
  writeFileSync(sarifPath, `${JSON.stringify(toSarif(findings, VERSION), null, 2)}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    printSummary(manifest, { manifestPath, reportPath, sarifPath });
  }

  const gate = manifest.gate as { passed?: boolean } | undefined;
  return gate && gate.passed === false ? 2 : 0;
}

function printSummary(
  manifest: Record<string, unknown>,
  paths: { manifestPath: string; reportPath: string; sarifPath: string },
): void {
  const colour = supportsColour();
  const bold = colour ? '[1m' : '';
  const dim = colour ? '[2m' : '';
  const reset = colour ? '[0m' : '';

  const scored = manifest.score as Record<string, unknown>;
  const findings = (manifest.findings ?? []) as Array<Record<string, unknown>>;
  const coverage = (manifest.coverage ?? {}) as Record<string, unknown>;
  const engines = (manifest.engines ?? []) as Array<Record<string, unknown>>;
  const gate = manifest.gate as { passed?: boolean; failures?: string[] } | undefined;

  const out = process.stderr;
  out.write('\n');
  out.write(
    `${bold}${String(scored.tier).toUpperCase()} risk${reset}  ${scored.total}/33` +
      (scored.inconclusive ? `  ${dim}(undetermined: up to ${scored.totalUpperBound}/33)${reset}` : '') +
      '\n\n',
  );

  const bySeverity = new Map<string, number>();
  for (const f of findings) {
    const key = String(f.severity);
    bySeverity.set(key, (bySeverity.get(key) ?? 0) + 1);
  }
  if (bySeverity.size > 0) {
    const parts = [...bySeverity.entries()].map(([sev, n]) => `${n} ${sev}`);
    out.write(`  findings    ${parts.join(', ')}\n`);
  } else {
    out.write('  findings    none\n');
  }

  const corroborated = Number(coverage.corroboratedFindings ?? 0);
  if (corroborated > 0) {
    out.write(`  ${dim}          ${corroborated} corroborated across engines${reset}\n`);
  }

  for (const engine of engines) {
    const mark = engine.status === 'ok' ? '✓' : engine.status === 'skipped' ? '-' : '✗';
    out.write(
      `  ${mark} ${String(engine.engine).padEnd(10)} ${engine.status}` +
        (engine.reason ? `  ${dim}${engine.reason}${reset}` : '') +
        '\n',
    );
  }

  // The invariants are the harness's output; one line so a reader sees
  // "I1 passed, I2 not-applicable" rather than inferring it from the engine row.
  const invariants = (manifest.invariants ?? []) as Array<{ id: string; status: string }>;
  if (invariants.length > 0) {
    out.write(`  invariants  ${invariants.map((i) => `${i.id} ${i.status}`).join(', ')}\n`);
  }

  const uncovered = (coverage.uncoveredFunctions ?? []) as unknown[];
  if (uncovered.length > 0) {
    out.write(
      `\n  ${bold}⚠ ${uncovered.length} function(s) were not analysed${reset} ` +
        `${dim}(HR-E205) — a clean result does not cover them${reset}\n`,
    );
  }

  const warnings = (scored.warnings ?? []) as string[];
  for (const warning of warnings) {
    out.write(`  ${dim}! ${warning}${reset}\n`);
  }

  out.write('\n');
  out.write(`  ${dim}${paths.reportPath}${reset}\n`);
  out.write(`  ${dim}${paths.manifestPath}${reset}\n`);
  out.write(`  ${dim}${paths.sarifPath}${reset}\n`);

  if (gate) {
    out.write('\n');
    if (gate.passed) {
      out.write(`  ${bold}gate passed${reset}\n`);
    } else {
      out.write(`  ${bold}gate failed${reset}\n`);
      for (const failure of gate.failures ?? []) out.write(`    - ${failure}\n`);
    }
  }
  out.write('\n');
}

function commandInit(argv: string[]): number {
  let path = join(process.cwd(), 'hookrisk.toml');
  const flag = argv.indexOf('--config');
  if (flag >= 0 && argv[flag + 1]) path = resolve(argv[flag + 1]!);

  if (existsSync(path)) {
    process.stderr.write(`${path} already exists; leaving it alone.\n`);
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configTemplate());
  process.stderr.write(
    `Wrote ${path}.\n\n` +
      'It declares the most conservative values for everything hookrisk cannot\n' +
      'measure — unproven team, no fee. Edit them to match reality before relying\n' +
      'on the score.\n',
  );
  return 0;
}

async function commandEngines(): Promise<number> {
  const engines: Engine[] = [new SlitherEngine(), new BlockSecEngine()];
  process.stderr.write('\n');
  for (const engine of engines) {
    const probe = await engine.probe();
    const mark = probe.available ? '✓' : '-';
    process.stderr.write(`  ${mark} ${engine.id.padEnd(10)} ${engine.displayName}\n`);
    process.stderr.write(`      ${probe.available ? probe.version : probe.reason}\n`);
    if (engine.upstream) {
      process.stderr.write(`      ${engine.upstream.url} (${engine.upstream.license})\n`);
    }
    process.stderr.write('\n');
  }
  return 0;
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'scan':
      return commandScan(rest);
    case 'init':
      return commandInit(rest);
    case 'engines':
      return commandEngines();
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stderr.write(usage());
      return command === undefined ? 64 : 0;
    default:
      process.stderr.write(`Unknown command \`${command}\`.\n\n${usage()}`);
      return 64;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof HookriskError) {
      process.stderr.write(`\n${err.render()}\n\n`);
      process.exit(err.exitCode);
    }
    // Anything unmapped is a gap in the catalogue, which we treat as a bug.
    const wrapped = new HookriskError('HR-E901', {
      detail: err instanceof Error ? err.message : String(err),
      rawOutput: err instanceof Error ? err.stack : undefined,
    });
    process.stderr.write(`\n${wrapped.render()}\n\n`);
    process.exit(wrapped.exitCode);
  });

export { fileURLToPath, basename };
