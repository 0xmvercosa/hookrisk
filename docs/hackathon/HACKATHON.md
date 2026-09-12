# hookrisk at the hackathon

**What it is.** The Uniswap Foundation's Hooks Security Framework, made
executable: static detectors (Slither), a differential twin-pool harness
(Foundry, against real v4-core), and a scoring layer that refuses to score a
dimension zero unless a detector capable of finding something actually ran.
Output is a manifest, a report, SARIF, and a meaningful exit code.

**What this document is.** The record of one day's work on top of the
original repository: what we found by running it against 14 real hooks, what
we fixed in two passes, the evidence to show, and what is still open. The
per-change notes from each workstream are in `notes-A.md` to `notes-I.md`; the
raw before/after scan artifacts are under `evidence/`; the demo itself is
`DEMO_RUNBOOK.md` and `demo.sh`.

## The pitch in three findings

1. **It finds the Cork exploit.** On the archived `CorkHook` (the $11M
   May 2025 incident, fix never merged) HS-01 reports the unguarded
   `beforeSwap` at line 365 that the attacker called directly, plus two more
   unguarded callbacks and a genuinely stubbed `beforeRemoveLiquidity`.
   `evidence/cork-hook.md`.
2. **It executes hooks, not only reads them.** The harness stands up two
   pools identical except for the hook, drives them with the same fuzzed
   sequence, and asserts conservation, no undeclared extraction (or price
   monotonicity for custom curves) and exit liveness. A hook that documents a
   1% fee and charges 3.5% is structurally flawless and only execution sees
   it. `harness/test/HarnessValidation.t.sol` proves the harness catches the
   planted skim and the planted liquidity trap.
3. **Two independent engines agree.** BlockSec's HookScan (Yul CFG) and our
   detectors (solc AST) now both run and merge the same missing guard into one
   corroborated finding at raised confidence.
   `evidence/blocksec-corroboration.md`.

## What we found by scanning 14 real hooks

We took hooks from `fewwwww/awesome-uniswap-hooks` and the wider ecosystem,
from the official template to Uniswap's own production hooks, OpenZeppelin's
library, an ETHGlobal Buenos Aires 2025 entry, the Cork exploit hook, and five
2023-era hooks on the pre-release ABI. One agent per hook cloned, built and
scanned. Results and the tool defects they exposed are in
`evidence/agent-scan-results-before.json` and the assessment report; the
short version:

| Before the fixes | |
|---|---|
| Harness actually ran | 1 of 14 |
| Harness reported "ok" after its own setUp reverted | 1 (constant-sum) |
| False HIGH from HS-02 on a deliberate revert-guard | 4 (WETHHook, v2-on-v4, constant-sum, Orbital) |
| Legacy-ABI hooks reported clean with complexity "measured 0" | 5 |
| Distinct findings collapsed into one by reconciliation | Orbital (2 → 1) |
| BlockSec engine able to run | no (amd64-only image, broken entrypoint, no solc 0.8.26) |

| After both passes | |
|---|---|
| Harness ran and all three invariants passed | 3 (template, two OpenZeppelin hooks) |
| Harness ran, hook refused PoolManager liquidity, reported honestly | 2 (constant-sum, Orbital via `constructorArgs`): I1/I2 inconclusive with zero swaps compared, I3 not-applicable by cross-layer reconciliation |
| Harness failed loudly with the hook's own revert | 3 (StablePairHook `InvalidInitializer`, stop-loss legacy ABI, v2-on-v4 factory constructor) |
| Harness skipped with an accurate, actionable reason | 6 (constructor arguments needed, or the project does not compile) |
| False HIGHs | 0; each is now an INFO classification `callback-intentionally-disabled` |
| Legacy-ABI hooks | INFO `unsupported-hook-abi`; every code-derived dimension unmeasured |
| Complexity measured (from the hook profile) | 9 of 14; Cork scores 5/5 (returns-delta, swap-path external calls, owner-only surface) |
| Gate | passes on 11, fails on the 3 with HIGH findings (was: failed on all 14 for an undetermined tier) |
| BlockSec | runs, corroborates HS-01 |

Full table with per-hook links: `evidence/scans/README.md`.

## What changed today

Two passes of parallel workstreams with disjoint file ownership. Final state:
274 CLI tests, 41 harness tests, three corpus gates and 29 detector tests
green.

### Pass 1: make it honest, widen reach

**A. The CLI–harness bridge** (`cli/src/harness.ts`, `manifest.ts`, `config.ts`).
A reverting `setUp()` is a harness *failure* (HR-E304) with the hook's own
revert unwrapped from v4's ERC-7751 wrapper and the callback named; the
harness is an engine row in the manifest; `coverage.dynamicAnalysisSkipped`
tells the truth; project `out` and `solc` come from `forge config`; hooks with
extra constructor arguments get `[harness] constructorArgs` with
`$poolManager`/`$currency0`/`$currency1`/`$owner`/`$hook` placeholders;
hooks whose `getHookPermissions()` is inherited are no longer skipped as
"declares no permissions".

**B. The Solidity harness** (`harness/test/*`, `harness/src/hooks/ShapeHooks.sol`).
Derives permissions by etching the runtime code and calling
`getHookPermissions()`; substitutes constructor sentinels; retries pool
initialisation with a dynamic fee when a static fee is rejected; survives a
hook that refuses PoolManager liquidity and records it; writes a run record
the CLI reads. Four new fixtures, each with a deterministic test of the happy
path and the loud failure.

**C. The detectors** (`detectors/`, `corpus/`).
HS-02 distinguishes a `HookNotImplemented()` stub (still HIGH) from a
deliberate custom revert (INFO classification). A new `hookrisk-unsupported-abi`
detector reports 2023-era hooks instead of staying silent. Findings carry a
discriminator. The negative corpus now really contains OpenZeppelin's
production hooks (concrete mocks, subclassed in project source), plus an
intentional-revert fixture and a legacy-ABI fixture, gated by JSON rather than
grep.

**D. The static engine and scoring** (`cli/src/engines/*`, `cli/src/scoring/*`).
Slither's `--json -` was swallowing its own stderr, which is why compile
failures produced an empty reason and every IR-lifting gap (HR-E205) was
invisible; the report now goes to a file and both streams are read. Distinct
findings no longer collapse; hookrisk's callback names and BlockSec's
selectors key to the same bucket so they corroborate. Complexity can no
longer be "measured 0" from silence, and an engine that disclaimed the target
does not count as having looked.

**E. BlockSec HookScan** (`cli/src/engines/blocksec.ts`).
Always `--platform linux/amd64`, entrypoint bypassed, the exact static solc
downloaded from binaries.soliditylang.org into `~/.cache/hookrisk/solc` and
mounted read-only; the analysis container stays `--network none`. Symlinked
`lib/` is detected and refused with a reason.

Plus: a fresh `make setup` works on the first run (Makefile evaluated the venv
paths before creating the venv), `doctor` recognises the detectors, an INFO
classification can never fail the severity gate, and the error catalogue no
longer labels a plain solc error as a test-path problem.

### Pass 2: design for the next repo

**F. A versioned engine contract** (`schema/engine-metadata.schema.json`).
Every detector result's metadata block is validated by both sides; a drifted
detector is dropped and counted, never silently admitted. A new
`hook-profile` classification per analysed contract carries the resolved
permissions (inheritance followed), the implemented callbacks and structural
metrics; it is the engine's "I looked at this contract" signal. The regex
permission parser is gone; the dead `diagnostics.py` is gone.

**G. Vacuous passes and cross-layer reconciliation** (`harness/`, `cli/src/reconcile.ts`).
The harness appends per-sequence observation counts; an invariant that passed
with zero relevant observations is reported inconclusive with the counts. A
static "disabled by design" classification and a harness seed that reverted
are merged into one finding attributed to both layers, and I3 becomes
not-applicable when both agree PoolManager liquidity is off by design.
Concurrent scans in one harness directory verified safe.

**H. Complexity from evidence, a deliberate gate** (`cli/src/scoring/`, `config.ts`).
Complexity is derived from the hook profile with brackets recorded in the
rubric as interpretation. `hookrisk init` no longer sets `maxTier`; an
undetermined tier fails the gate only with `failOnInconclusive = true`. The
manifest carries `engines[].errorCode`, `coverage.observations` and a hook
profile table in the report.

**I. Orchestration and packaging** (`cli/src/cli.ts`, `log.ts`, `home.ts`).
Engines and the harness run concurrently with per-engine budgets; `--log-json`
emits one JSON line per event with a run id; the summary prints to stdout;
`HOOKRISK_HOME` locates the harness and schema with a clear error when
missing; the dogfood workflow gained a third case asserting an unrunnable
hook comes back inconclusive rather than clean.

## Demo script

```bash
make setup && make test                        # everything green

# 1. The exploit hook (clone of Cork-Technology/Cork-Hook, forge build first)
node cli/dist/cli.js scan src/CorkHook.sol:CorkHook --verbose
#   3× unprotected-hook-callback HIGH incl. beforeSwap:365; gate failed

# 2. A custom-curve hook the old harness silently "passed" with zero invariants
#    (clone of saucepoint/v4-constant-sum)
node cli/dist/cli.js scan src/Counter.sol:Counter --verbose
#   ✓ harness ok  (seeded=hooked-failed: the hook refuses PoolManager liquidity)
#   invariants I1 inconclusive, I2 inconclusive (0 swaps compared), I3 not-applicable
#   callback-intentionally-disabled INFO instead of a false HIGH

# 3. The planted bugs the harness must catch
cd harness && forge test --match-path test/HarnessValidation.t.sol

# 4. Two engines agreeing (needs Docker; first run downloads solc once)
#    see evidence/blocksec-corroboration.md
```

## Honest limits, still open

- **Five of nine rubric dimensions have no detector**, so the tier is still a
  range on most hooks. Complexity is now measured from the hook profile
  (callbacks, state writes, swap-path external calls, returns-delta, admin
  surface), and the default gate no longer fails on an undetermined tier
  unless `failOnInconclusive = true`. Next detectors, with fixtures already
  identified in the scan corpus: HS-05 external-call-in-swap-path (helpers
  exist), HS-04 upgradeability (StablePairHook is UUPS), HS-03 admin surface
  (the profile already flags owner-only functions).
- **Harness reach.** Hooks whose constructor needs a deployed dependency
  (Cork clones a `LiquidityToken`; WETHHook needs WETH) or a factory's
  `parameters()` (v2-on-v4) still cannot be stood up. A hook that refuses
  PoolManager liquidity is stood up but not traded through its own liquidity
  path; its invariants are reported inconclusive with the observed counts, and
  I3 not-applicable once reconciled with the static "disabled by design"
  classification (`seeded: "hooked-failed"`).
- **I2 tolerates 200 bips of drift**, and treats any hooked-only swap revert as
  a failure, so access-controlled hooks will fail I2 by design once reached.
- **Deployed mode** (scan an address, bind the manifest to a codehash) exists
  in the schema only. Uniswap's `hooklist` registry (116 deployed hooks with
  declared flags) is the natural seed for it.
- **BlockSec in CI** needs a decision about a 1.2 GB amd64 image on the runner.

## Where things are

| | |
|---|---|
| Assessment report (pre-fix) | https://claude.ai/code/artifact/73f045de-67ff-49ca-bd7f-56ea478c552a |
| Per-workstream notes | `notes-A.md` … `notes-I.md` |
| Demo | `DEMO_RUNBOOK.md`, `demo.sh` |
| 14-hook before/after | `evidence/scans/README.md`, `evidence/scans/{before,after}/<hook>/` |
| Cork showcase | `evidence/cork-hook.md` |
| BlockSec corroboration | `evidence/blocksec-corroboration.md` |
| Rescan script | `evidence/rescan.sh <hookrisk-root> <out-dir>` (needs the hook clones) |
