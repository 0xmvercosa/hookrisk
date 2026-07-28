/**
 * Reconciliation of findings across engines.
 *
 * Running several analyzers over the same contract produces overlapping output.
 * Two engines flagging the same missing access check is *one* problem reported
 * twice, and treating it as two is wrong in both directions: the report
 * overstates how much is broken, and the strongest available signal — that
 * independent tools, built on different foundations, reached the same conclusion
 * — gets thrown away.
 *
 * So findings are keyed by what they are *about* (canonical class, location,
 * function) rather than by who reported them. Matching findings collapse into
 * one, carrying every engine's attribution.
 *
 * The confidence rule
 * -------------------
 * Corroboration by two engines that do not share an analysis foundation raises
 * confidence to `high`. Our Slither detectors work on solc's AST and SlithIR;
 * BlockSec's HookScan works on the Yul CFG. Agreement between them is close to
 * independent confirmation, which is the best false-positive filter available
 * without a human reading the code.
 *
 * Agreement between two engines that *do* share a foundation is not treated as
 * independent. Today every pairing is cross-foundation, but the rule is written
 * out so that adding a second Slither-based engine later does not quietly
 * inflate confidence across the whole report.
 */

import { createHash } from 'node:crypto';

import {
  type Confidence,
  type EngineAttribution,
  type EngineResult,
  type Finding,
  type RuleClass,
  type SourceLocation,
  confidenceRank,
  severityRank,
} from '../types.js';

/**
 * Analysis foundation each engine is built on.
 *
 * Two engines sharing a foundation share its blind spots, so their agreement is
 * much weaker evidence than agreement across foundations.
 */
const ENGINE_FOUNDATION: Record<string, string> = {
  hookrisk: 'solc-ast',
  blocksec: 'yul-cfg',
};

/**
 * Stable identifier for a finding.
 *
 * Deliberately excludes severity, confidence and the reporting engine, so the
 * same defect gets the same id no matter who found it or how badly they rated
 * it. Line numbers are included: two missing guards in one file are two
 * findings. That does mean an unrelated edit above a finding changes its id, and
 * that is the accepted trade — the alternative, hashing surrounding source,
 * makes ids unstable under formatting instead.
 */
export function makeFindingId(
  ruleClass: RuleClass,
  location: SourceLocation | null,
  selector?: string,
): string {
  const parts = [
    ruleClass,
    location ? `${location.file}:${location.line}` : 'no-location',
    selector ?? 'no-selector',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Group key for reconciliation.
 *
 * Slightly looser than the finding id: when a selector is known it wins, because
 * engines routinely disagree by a line or two about where a function "is" — one
 * points at the `function` keyword, another at the offending statement. Keying
 * on `class + file + selector` in that case stops a one-line disagreement from
 * splitting a corroborated finding into two uncorroborated ones.
 */
function groupKey(f: Finding): string {
  const file = f.location?.file ?? 'no-file';
  if (f.function?.selector) {
    return `${f.ruleClass}|${file}|${f.function.selector}`;
  }
  if (f.function?.name) {
    return `${f.ruleClass}|${file}|fn:${f.function.name}`;
  }
  return `${f.ruleClass}|${file}|${f.location?.line ?? 'no-line'}`;
}

export interface MergeStats {
  /** Findings before reconciliation. */
  total: number;
  /** Findings after. */
  unique: number;
  /** How many were confirmed by more than one foundation. */
  corroborated: number;
  /** Per-engine counts, for the report's engine table. */
  byEngine: Record<string, number>;
}

export interface MergeOutcome {
  findings: Finding[];
  stats: MergeStats;
}

/**
 * Reconcile findings from every engine into one ordered list.
 *
 * Output is sorted by severity, then confidence, then file and line, so the
 * first thing in the report is the thing most worth reading.
 */
export function mergeEngineResults(results: EngineResult[]): MergeOutcome {
  const byEngine: Record<string, number> = {};
  const groups = new Map<string, Finding[]>();

  for (const result of results) {
    byEngine[result.engine] = result.findings.length;
    for (const finding of result.findings) {
      const key = groupKey(finding);
      const bucket = groups.get(key);
      if (bucket) bucket.push(finding);
      else groups.set(key, [finding]);
    }
  }

  let corroborated = 0;
  let total = 0;
  const merged: Finding[] = [];

  for (const bucket of groups.values()) {
    total += bucket.length;
    const combined = mergeGroup(bucket);
    if (foundations(combined.engines).size > 1) corroborated += 1;
    merged.push(combined);
  }

  merged.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
      (a.location?.file ?? '').localeCompare(b.location?.file ?? '') ||
      (a.location?.line ?? 0) - (b.location?.line ?? 0),
  );

  return {
    findings: merged,
    stats: { total, unique: merged.length, corroborated, byEngine },
  };
}

/** Collapse one group of equivalent findings. */
function mergeGroup(bucket: Finding[]): Finding {
  if (bucket.length === 1) return bucket[0]!;

  // Take the richest description rather than the first: engines vary a lot in
  // how much they say, and the longest is almost always the most useful.
  const primary = bucket.reduce((best, f) =>
    f.description.length > best.description.length ? f : best,
  );

  const engines: EngineAttribution[] = [];
  const seen = new Set<string>();
  for (const f of bucket) {
    for (const attribution of f.engines) {
      const dedupeKey = `${attribution.engine}|${attribution.nativeRule}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      engines.push(attribution);
    }
  }

  // Severity: the most severe assessment wins. A tool that under-rates does not
  // get to talk a peer down; the user can see every individual rating in
  // `engines[]` and disagree if they want.
  const severity = bucket.reduce(
    (worst, f) => (severityRank(f.severity) > severityRank(worst) ? f.severity : worst),
    bucket[0]!.severity,
  );

  const confidence = mergedConfidence(bucket, engines);

  return {
    ...primary,
    severity,
    confidence,
    engines,
    evidence: dedupeStrings(bucket.flatMap((f) => f.evidence)),
    references: dedupeStrings(bucket.flatMap((f) => f.references ?? [])),
    informsDimensions: dedupeStrings(bucket.flatMap((f) => f.informsDimensions ?? [])),
    informsTriggers: dedupeStrings(bucket.flatMap((f) => f.informsTriggers ?? [])),
  };
}

/**
 * Confidence after merging.
 *
 * Cross-foundation agreement promotes to `high`. Otherwise take the highest any
 * single engine claimed — engines are already conservative about their own
 * confidence, and averaging would punish the one that was sure.
 */
function mergedConfidence(bucket: Finding[], engines: EngineAttribution[]): Confidence {
  if (foundations(engines).size > 1) return 'high';
  return bucket.reduce<Confidence>(
    (best, f) => (confidenceRank(f.confidence) > confidenceRank(best) ? f.confidence : best),
    bucket[0]!.confidence,
  );
}

function foundations(engines: EngineAttribution[]): Set<string> {
  return new Set(engines.map((e) => ENGINE_FOUNDATION[e.engine] ?? `unknown:${e.engine}`));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
