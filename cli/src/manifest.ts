/**
 * Building, validating and rendering the hook-risk manifest.
 *
 * The manifest is the product. Everything else — detectors, harness, scoring —
 * exists to fill it in. It is validated against `schema/hook-risk.schema.json`
 * before it is written, because downstream consumers rely on the schema and
 * emitting something that violates it would push the failure onto them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The 2020 build, not the default export: our schema declares
// $schema draft/2020-12, and Ajv's default entry point only understands
// draft-07. Compiling a 2020 schema with the draft-07 compiler fails with
// `no schema with key or ref "…/2020-12/schema"`, which reads like a
// missing file rather than a version mismatch.
import { Ajv2020 as Ajv, type ValidateFunction } from 'ajv/dist/2020.js';

import { HookriskError } from './errors.js';
import type { ScoreResult } from './scoring/score.js';
import type { EngineResult, Finding, Severity } from './types.js';
import { SEVERITIES, isClassification, severityRank } from './types.js';
import type { UncoveredFunction } from './engines/slither.js';
import type { GatePolicy } from './config.js';

export const SCHEMA_VERSION = '1.0.0';

export interface InvariantResult {
  id: 'I1' | 'I2' | 'I3';
  name: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'not-applicable' | 'skipped';
  runs?: number;
  calls?: number;
  reverts?: number;
  detail?: string;
  counterexample?: {
    sequence?: Array<{ target?: string; calldata?: string; signature?: string }>;
    revertSelector?: string;
    revertRaw?: string;
  };
}

/**
 * The differential harness as an engine row.
 *
 * It produces invariants rather than findings, so it does not go through the
 * engine reconciliation path, but it is an analysis the scan attempted and a
 * reader must be able to tell "ran and held" from "never ran" without diffing
 * the invariants array against their memory of what should be there.
 */
export interface HarnessSummary {
  version: string;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  durationMs: number;
}

export interface ManifestInputs {
  toolVersion: string;
  commandLine?: string;
  generatedAt?: string;
  target: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  findings: Finding[];
  invariants?: InvariantResult[];
  score: ScoreResult;
  engineResults: EngineResult[];
  engineMeta: Map<string, { displayName: string; upstream?: { url: string; license: string } }>;
  harness: HarnessSummary;
  corroboratedFindings: number;
  uncoveredFunctions: UncoveredFunction[];
  staticAnalysisSkipped: boolean;
  gate?: GatePolicy;
}

export const HARNESS_ENGINE_ID = 'harness';
export const HARNESS_DISPLAY_NAME = 'Differential harness (Foundry)';

export type Manifest = Record<string, unknown>;

// --------------------------------------------------------------------------- //
// Build
// --------------------------------------------------------------------------- //

export function buildManifest(input: ManifestInputs): Manifest {
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: {
      tool: 'hookrisk',
      version: input.toolVersion,
      // Omitted by default so two runs over identical input produce identical
      // bytes — a manifest that changes every run cannot be diffed in review.
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
      ...(input.commandLine ? { commandLine: input.commandLine } : {}),
    },
    target: input.target,
    findings: input.findings.map(serialiseFinding),
    score: serialiseScore(input.score),
    engines: [
      ...input.engineResults.map((result) => {
        const meta = input.engineMeta.get(result.engine);
        return {
          engine: result.engine,
          ...(meta?.displayName ? { displayName: meta.displayName } : {}),
          version: result.version,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          findingCount: result.findings.length,
          durationMs: result.durationMs,
          ...(meta?.upstream ? { upstream: meta.upstream } : {}),
        };
      }),
      {
        engine: HARNESS_ENGINE_ID,
        displayName: HARNESS_DISPLAY_NAME,
        version: input.harness.version,
        status: input.harness.status,
        ...(input.harness.reason ? { reason: input.harness.reason } : {}),
        // A failed invariant is the harness's finding; the count is what a
        // reader scanning the engines table expects to see there.
        findingCount: (input.invariants ?? []).filter((i) => i.status === 'failed').length,
        durationMs: input.harness.durationMs,
      },
    ],
    coverage: {
      corroboratedFindings: input.corroboratedFindings,
      uncoveredFunctions: input.uncoveredFunctions,
      staticAnalysisSkipped: input.staticAnalysisSkipped,
      // Derived from the harness status rather than from the --skip-dynamic
      // flag, so a harness that failed or declined to run reads as "not
      // analysed" and never as "analysed, nothing found".
      dynamicAnalysisSkipped: input.harness.status !== 'ok',
      harnessStatus: input.harness.status,
    },
  };

  if (input.permissions) manifest.permissions = input.permissions;
  if (input.invariants?.length) manifest.invariants = input.invariants;

  if (input.gate) {
    manifest.gate = evaluateGate(
      input.gate,
      input.score,
      input.findings,
      input.uncoveredFunctions,
      input.invariants ?? [],
    );
  }

  return manifest;
}

function serialiseFinding(finding: Finding): Record<string, unknown> {
  return {
    id: finding.id,
    ruleClass: finding.ruleClass,
    title: finding.title,
    description: finding.description,
    severity: finding.severity,
    confidence: finding.confidence,
    location: finding.location,
    ...(finding.function ? { function: finding.function } : {}),
    ...(finding.discriminator ? { discriminator: finding.discriminator } : {}),
    evidence: finding.evidence,
    engines: finding.engines.map((e) => ({
      engine: e.engine,
      nativeRule: e.nativeRule,
      severity: e.severity,
      confidence: e.confidence,
    })),
    ...(finding.informsDimensions?.length ? { informsDimensions: finding.informsDimensions } : {}),
    ...(finding.informsTriggers?.length ? { informsTriggers: finding.informsTriggers } : {}),
    ...(finding.references?.length ? { references: finding.references } : {}),
  };
}

function serialiseScore(score: ScoreResult): Record<string, unknown> {
  return {
    total: score.total,
    totalUpperBound: score.totalUpperBound,
    tier: score.tier.id,
    tierUpperBound: score.tierUpperBound.id,
    inconclusive: score.inconclusive,
    rubric: {
      framework: 'Uniswap Hooks Security Framework',
      revision: score.rubricRevision,
      url: 'https://github.com/uniswapfoundation/security-framework',
    },
    dimensions: score.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      value: d.value,
      max: d.max,
      source: d.source,
      bracketLabel: d.bracketLabel,
      bracketsAreInterpretation: d.bracketsAreInterpretation,
      evidence: d.evidence,
    })),
    triggers: score.triggers.map((t) => ({
      id: t.id,
      name: t.name,
      firedBy: t.firedBy,
      derivationIsInterpretation: t.derivationIsInterpretation,
    })),
    recommendations: score.recommendations,
    warnings: score.warnings,
  };
}

/**
 * Decide whether the CI gate passes.
 *
 * A gate failure exits 2, which is deliberately not an error code: the scan
 * succeeded and the hook did not clear the bar. Conflating the two would make
 * "hookrisk is broken" and "your hook has a problem" indistinguishable to a CI
 * job, and only one of those should page someone.
 */
function evaluateGate(
  policy: GatePolicy,
  score: ScoreResult,
  findings: Finding[],
  uncovered: UncoveredFunction[],
  invariants: InvariantResult[],
): Record<string, unknown> {
  const failures: string[] = [];
  const tierRank = { low: 0, medium: 1, high: 2 } as const;

  // A violated invariant fails the gate unconditionally, whatever the tier says
  // and whatever thresholds are configured. It is the strongest evidence
  // hookrisk can produce: not a pattern that resembles a bug, but an executed
  // sequence in which the hook demonstrably misbehaved. A gate that weighed a
  // reproducible counterexample against a numeric threshold would be able to
  // pass a hook that provably traps liquidity, which is not a trade-off worth
  // offering.
  for (const invariant of invariants) {
    if (invariant.status !== 'failed') continue;
    failures.push(
      `invariant ${invariant.id} (${invariant.name}) failed` +
        (invariant.detail ? `: ${invariant.detail}` : ''),
    );
  }

  if (policy.maxTier && tierRank[score.tier.id] > tierRank[policy.maxTier]) {
    failures.push(
      `risk tier is ${score.tier.name} (${score.total}/33), above the configured maximum of ${policy.maxTier}`,
    );
  }

  // An inconclusive tier is not a pass. If missing data could put the hook above
  // the gate, saying "passed" would be asserting something unknown.
  if (policy.maxTier && score.inconclusive && tierRank[score.tierUpperBound.id] > tierRank[policy.maxTier]) {
    failures.push(
      `tier is undetermined between ${score.tier.name} and ${score.tierUpperBound.name}; ` +
        `the upper bound exceeds the configured maximum of ${policy.maxTier}`,
    );
  }

  if (policy.maxSeverity) {
    const threshold = severityRank(policy.maxSeverity as Severity);
    const breaching = findings.filter(
      (f) => severityRank(f.severity) >= threshold && !isClassification(f.ruleClass),
    );
    if (breaching.length > 0) {
      failures.push(
        `${breaching.length} finding(s) at or above ${policy.maxSeverity}: ` +
          breaching
            .slice(0, 3)
            .map((f) => f.title)
            .join('; '),
      );
    }
  }

  if (policy.failOnPartialCoverage && uncovered.length > 0) {
    failures.push(`${uncovered.length} function(s) were not analysed (HR-E205)`);
  }

  return {
    passed: failures.length === 0,
    ...(policy.maxTier ? { maxTier: policy.maxTier } : {}),
    ...(policy.maxSeverity ? { maxSeverity: policy.maxSeverity } : {}),
    failures,
  };
}

// --------------------------------------------------------------------------- //
// Validate
// --------------------------------------------------------------------------- //

let validator: ValidateFunction | null = null;

function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(join(here, '..', '..', 'schema', 'hook-risk.schema.json'));
}

export function validateManifest(manifest: Manifest, schemaFile = schemaPath()): void {
  if (!validator) {
    // `validateFormats: false` because the schema's `format` annotations
    // (date-time, uri) are documentation for readers, not constraints we rely
    // on. Enforcing them would mean a second dependency parsing our own output
    // to check something no consumer branches on — not a trade worth making in
    // a security tool, where every dependency is attack surface.
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    validator = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
  }

  if (validator(manifest)) return;

  const detail = (validator.errors ?? [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');

  throw new HookriskError('HR-E501', {
    detail: `Generated manifest does not satisfy the schema: ${detail}`,
    context: { schema: schemaFile },
  });
}

// --------------------------------------------------------------------------- //
// Render
// --------------------------------------------------------------------------- //

const STRENGTH_LABEL: Record<string, string> = {
  required: '**Required**',
  'strongly-recommended': 'Strongly recommended',
  recommended: 'Recommended',
  optional: 'Optional',
};

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: 'ℹ️',
};

/** Render HOOK_RISK.md, the human-facing summary. */
export function renderMarkdown(manifest: Manifest): string {
  const score = manifest.score as ReturnType<typeof serialiseScore>;
  const findings = (manifest.findings ?? []) as Array<Record<string, unknown>>;
  const engines = (manifest.engines ?? []) as Array<Record<string, unknown>>;
  const coverage = (manifest.coverage ?? {}) as Record<string, unknown>;
  const target = (manifest.target ?? {}) as Record<string, unknown>;
  const invariants = (manifest.invariants ?? []) as InvariantResult[];
  const gate = manifest.gate as Record<string, unknown> | undefined;

  const out: string[] = [];
  const tier = String(score.tier).toUpperCase();

  out.push('# Hook Risk Report', '');
  out.push(
    `**${tier} risk** — ${score.total}/33 against the ` +
      `[Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).`,
    '',
  );

  if (score.inconclusive) {
    out.push(
      `> **Tier is undetermined.** ${score.total}/33 from what could be measured, up to ` +
        `${score.totalUpperBound}/33 if every unmeasured dimension were at its maximum — ` +
        `between ${score.tier} and ${score.tierUpperBound}. Unmeasured dimensions are excluded ` +
        'from the total, never counted as zero.',
      '',
    );
  }

  if (gate) {
    out.push(
      gate.passed
        ? '✅ **Gate passed.**'
        : `❌ **Gate failed.**\n${(gate.failures as string[]).map((f) => `- ${f}`).join('\n')}`,
      '',
    );
  }

  // --- target ---
  out.push('## What was assessed', '');
  out.push('| | |', '| --- | --- |');
  if (target.contractName) out.push(`| Contract | \`${target.contractName}\` |`);
  if (target.sourceFile) out.push(`| Source | \`${target.sourceFile}\` |`);
  if (target.address) out.push(`| Address | \`${target.address}\` |`);
  if (target.chainId) out.push(`| Chain | ${target.chainId} |`);
  if (target.codehash) {
    out.push(`| Codehash | \`${target.codehash}\` |`);
  }
  out.push(`| Mode | ${target.mode} |`, '');

  if (target.codehash) {
    out.push(
      '> This report is bound to the codehash above. If the code at that address changes, ' +
        'this report describes something that no longer exists.',
      '',
    );
  }

  // --- score ---
  out.push('## Score', '');
  out.push('| Dimension | Score | Source | Bracket |', '| --- | --- | --- | --- |');
  for (const d of score.dimensions as Array<Record<string, unknown>>) {
    const value = d.value === null ? '—' : `${d.value}/${d.max}`;
    const interp = d.bracketsAreInterpretation ? ' ᵃ' : '';
    out.push(
      `| ${d.name} | ${value} | ${d.source} | ${d.bracketLabel ?? '_unmeasured_'}${interp} |`,
    );
  }
  out.push('');
  out.push(
    'ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine ' +
      'dimensions; the rest are our reading of its prose. See ' +
      '[FEEDBACK.md](FEEDBACK.md) #2.',
    '',
  );

  const triggers = score.triggers as Array<Record<string, unknown>>;
  if (triggers.length > 0) {
    out.push('### Feature triggers', '');
    out.push(
      'These apply regardless of the total score — the framework\'s own safeguard against a ' +
        'team scoring itself low while shipping a dangerous primitive.',
      '',
    );
    for (const t of triggers) {
      const note = t.derivationIsInterpretation ? ' _(derivation is hookrisk\'s reading)_' : '';
      out.push(`- **${t.name}** — fired by ${(t.firedBy as string[]).join(', ')}${note}`);
    }
    out.push('');
  }

  // --- recommendations ---
  const recommendations = score.recommendations as Array<Record<string, unknown>>;
  if (recommendations.length > 0) {
    out.push('## Security plan', '');
    out.push('| Action | Strength | Because |', '| --- | --- | --- |');
    for (const r of recommendations) {
      const sources = (r.sources as Array<Record<string, unknown>>) ?? [];
      const why = sources.map((s) => `\`${s.from}\``).join(', ');
      out.push(`| ${r.label} | ${STRENGTH_LABEL[String(r.strength)] ?? r.strength} | ${why} |`);
    }
    out.push('');
  }

  // --- findings ---
  out.push('## Findings', '');
  if (findings.length === 0) {
    out.push('None.', '');
  } else {
    for (const f of findings) {
      const severity = f.severity as Severity;
      const corroborated = (f.engines as unknown[]).length > 1;
      out.push(
        `### ${SEVERITY_ICON[severity]} ${f.title}`,
        '',
        `\`${f.ruleClass}\` · **${severity}** · confidence **${f.confidence}**` +
          (corroborated ? ' · **corroborated by multiple engines**' : ''),
        '',
      );
      const location = f.location as Record<string, unknown> | null;
      if (location) out.push(`\`${location.file}:${location.line}\``, '');
      out.push(String(f.description), '');
      out.push(
        'Reported by: ' +
          (f.engines as Array<Record<string, unknown>>)
            .map((e) => `\`${e.engine}/${e.nativeRule}\``)
            .join(', '),
        '',
      );
    }
  }

  // --- invariants ---
  if (invariants.length > 0) {
    out.push('## Invariants', '');
    out.push('| | Invariant | Result | Detail |', '| --- | --- | --- | --- |');
    for (const inv of invariants) {
      const icon =
        inv.status === 'passed'
          ? '✅'
          : inv.status === 'failed'
            ? '❌'
            : inv.status === 'not-applicable'
              ? '➖'
              : '⚠️';
      out.push(`| ${icon} | ${inv.id} ${inv.name} | ${inv.status} | ${inv.detail ?? ''} |`);
    }
    out.push('');

    for (const inv of invariants) {
      if (inv.status !== 'failed' || !inv.counterexample) continue;
      out.push(`### Counterexample for ${inv.id}`, '');
      if (inv.counterexample.revertSelector) {
        out.push(`Hook reverted with \`${inv.counterexample.revertSelector}\`.`, '');
      }
      if (inv.counterexample.sequence?.length) {
        out.push('```');
        inv.counterexample.sequence.forEach((step) =>
          out.push(`${step.signature ?? step.target ?? ''} ${step.calldata ?? ''}`.trim()),
        );
        out.push('```', '');
      }
    }
  }

  // --- engines and coverage ---
  out.push('## Analysis coverage', '');
  out.push('| Engine | Status | Findings | Notes |', '| --- | --- | --- | --- |');
  for (const e of engines) {
    out.push(
      `| ${e.displayName ?? e.engine} | ${e.status} | ${e.findingCount ?? 0} | ${e.reason ?? ''} |`,
    );
  }
  out.push('');

  const uncovered = (coverage.uncoveredFunctions ?? []) as UncoveredFunction[];
  if (uncovered.length > 0) {
    out.push(
      `> ⚠️ **${uncovered.length} function(s) were not analysed.** Slither could not lift them ` +
        'to IR and continued silently. Findings below do not cover them — this is not the same ' +
        'as those functions being clean. See `HR-E205`.',
      '',
    );
    for (const u of uncovered) {
      out.push(`- \`${u.contract}.${u.function}\``);
    }
    out.push('');
  }

  if (Number(coverage.corroboratedFindings ?? 0) > 0) {
    out.push(
      `${coverage.corroboratedFindings} finding(s) were confirmed independently by engines built ` +
        'on different analysis foundations, and carry raised confidence as a result.',
      '',
    );
  }

  const warnings = score.warnings as string[];
  if (warnings.length > 0) {
    out.push('## Warnings', '');
    warnings.forEach((w) => out.push(`- ${w}`));
    out.push('');
  }

  out.push('---', '');
  out.push(
    '_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation ' +
      'does not review, endorse or certify this report or any score derived from its framework._',
  );

  return out.join('\n');
}

/** Highest severity present, for badge colour and gate messaging. */
export function worstSeverity(findings: Finding[]): Severity | null {
  let worst: Severity | null = null;
  for (const f of findings) {
    if (!worst || severityRank(f.severity) > severityRank(worst)) worst = f.severity;
  }
  return worst;
}

export { SEVERITIES };
