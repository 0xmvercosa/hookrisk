/**
 * Normalised types shared by every analysis engine and by the manifest writer.
 *
 * The central idea: hookrisk does not own a single opinion about what a hook's
 * problems are. It runs several engines, each with its own strengths, and
 * reconciles them. That only works if findings from different tools can be
 * compared, which means they have to be reduced to a shared shape and, more
 * importantly, to a shared *taxonomy* — see {@link RuleClass}.
 */

/** Severity, ordered. Higher ordinal means worse. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Confidence that a finding is real rather than a false positive. */
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);
export const confidenceRank = (c: Confidence): number => CONFIDENCES.indexOf(c);

/**
 * Canonical vulnerability classes.
 *
 * Every engine's native rule name maps onto one of these. Two engines reporting
 * the same class at the same location is corroboration, not two problems — the
 * distinction matters because a report that counts the same missing access
 * check twice makes a hook look worse than it is, and a scoring model built on
 * finding *counts* would then be wrong.
 *
 * Classes exist here even when hookrisk has no detector of its own for them
 * (`unprotected-unlock-callback`, `selfdestruct`): those come from BlockSec's
 * HookScan and are genuine coverage we would otherwise lack.
 */
export type RuleClass =
  /** A hook callback callable by someone other than the PoolManager. */
  | 'unprotected-hook-callback'
  /** `unlockCallback` callable by someone other than the contract itself. */
  | 'unprotected-unlock-callback'
  /** Declared permissions disagree with implemented callbacks. */
  | 'flag-implementation-divergence'
  /** Privileged surface: who can change what, and are they a contract or an EOA. */
  | 'admin-surface'
  /** Proxy, DELEGATECALL to a mutable target, or an EIP-1967 slot. */
  | 'upgradeable-hook'
  /** The contract can self-destruct. */
  | 'selfdestruct'
  /** External call inside the swap path to something that is not the pool or its tokens. */
  | 'external-call-in-swap-path'
  /** A dynamic fee with no ceiling, no rate limit, or the wrong controller. */
  | 'unbounded-dynamic-fee'
  /** Custom accounting is in use. A classification, not a defect. */
  | 'custom-accounting'
  /** Rounding that resolves in the caller's favour on an exit path. */
  | 'rounding-direction';

/** Which engine produced a finding, and what it called the rule natively. */
export interface EngineAttribution {
  /** Engine identifier, e.g. `hookrisk` or `blocksec`. */
  engine: string;
  /** The engine's own rule name, preserved so users can trace it back. */
  nativeRule: string;
  severity: Severity;
  confidence: Confidence;
  /** Engine-specific extras worth keeping (call stacks, IR nodes). */
  detail?: Record<string, unknown>;
}

export interface SourceLocation {
  /** Repository-relative where possible; absolute paths are normalised on ingest. */
  file: string;
  /** 1-indexed. */
  line: number;
  endLine?: number;
}

export interface FunctionRef {
  name?: string;
  /** `0x` + 8 hex chars. */
  selector?: string;
}

/**
 * One reconciled finding.
 *
 * `engines` has at least one entry. More than one means independent tools agreed,
 * which is the strongest false-positive filter available without a human.
 */
export interface Finding {
  /** Stable across runs: derived from rule class, location and function. */
  id: string;
  ruleClass: RuleClass;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  location: SourceLocation | null;
  function?: FunctionRef;
  /** Human-readable support: the guard that is missing, the flag that diverges. */
  evidence: string[];
  engines: EngineAttribution[];
  /**
   * Framework dimensions this finding informs, e.g. `upgradeability`.
   * Findings feed scoring; they do not *set* it. See docs/SCORING.md.
   */
  informsDimensions?: string[];
  /** Framework feature triggers this finding activates. */
  informsTriggers?: string[];
  /** Where to read more — post-mortems, upstream docs. */
  references?: string[];
}

/** Outcome of one engine run. */
export interface EngineResult {
  engine: string;
  /** Version string, recorded in the manifest for reproducibility. */
  version: string;
  status: 'ok' | 'skipped' | 'failed';
  /** Why, when status is not `ok`. Always an HR-E code when failed. */
  reason?: string;
  findings: Finding[];
  /** Wall-clock milliseconds. */
  durationMs: number;
}

/** What every engine receives. */
export interface EngineContext {
  /** Absolute path to the Foundry project root containing the target. */
  projectRoot: string;
  /** Source-relative path of the file holding the hook, e.g. `src/MyHook.sol`. */
  sourceFile: string;
  /** Contract name within that file. */
  contractName: string;
  /** solc version the project builds with, e.g. `0.8.26`. */
  solcVersion: string;
  /** Per-engine wall-clock budget. */
  timeoutMs: number;
  /** Emit progress; the CLI routes this to stderr so stdout stays machine-readable. */
  log: (message: string) => void;
}

/** Contract every analysis engine implements. */
export interface Engine {
  /** Stable identifier used in attributions and config. */
  readonly id: string;
  /** Shown in the report and in `hookrisk engines`. */
  readonly displayName: string;
  /**
   * Upstream project, for attribution. Required for third-party engines: we run
   * other people's tools and say so, in the report as well as the README.
   */
  readonly upstream?: { url: string; license: string };
  /**
   * Whether this engine can run right now. Returning a reason rather than
   * throwing lets the CLI degrade cleanly and tell the user what they are
   * missing instead of failing the whole scan.
   */
  probe(): Promise<{ available: boolean; version: string; reason?: string }>;
  run(ctx: EngineContext): Promise<EngineResult>;
}
