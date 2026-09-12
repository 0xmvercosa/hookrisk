# Resuming the hackathon work

Read this first in a new session. It says where the work is, what was
decided and why, how to regenerate anything that is not in the repo, and what
is still open. Everything below is checkable against the branch.

## Where the work is

| | |
|---|---|
| Branch | `feat/hackathon-p0` (upstream is `origin` = `0xmvercosa/hookrisk`; `main` is the untouched upstream state) |
| Environment | `make setup` then `make test`. Expected green: 274 CLI tests, 45 harness tests (1 skipped), 29 detector tests, 3 corpus gates. `./scripts/doctor.sh` must show the detectors registered. |
| Narrative | `HACKATHON.md` (what was found, what changed in two passes, limits) |
| Per-change notes | `notes-A.md` … `notes-I.md` (A–E pass 1, F–I pass 2). Each has a "How to demo", "Caveats" and "Integrator" section. |
| Demo | `DEMO_RUNBOOK.md` (nine verified steps) and `demo.sh <hookrisk-root> <clones-root>` (about 90 s) |
| Evidence | `evidence/scans/{before,after}/<hook>/` manifests and logs, `evidence/scans/README.md` comparison table, `evidence/cork-hook.md`, `evidence/blocksec-corroboration.md`, `evidence/agent-scan-results-before.json` (the first agent run's structured findings) |
| Pre-fix assessment | https://claude.ai/code/artifact/73f045de-67ff-49ca-bd7f-56ea478c552a (private artifact; the same content is summarised in HACKATHON.md) |

## The 14 hook clones are not in the repo

They lived in a session scratchpad. To regenerate evidence or run the demo,
re-clone them. `DEMO_RUNBOOK.md` records the repo URL, the exact commit, the
build command and the `hookrisk.toml` for every hook it uses; the full list
with commits is in `evidence/agent-scan-results-before.json` (`repo`, `notes`)
and `evidence/scans/after/<hook>/HOOK_RISK.md`. Two things bite on a fresh
clone:

- Several 2023 repos pin nested submodules with `git@github.com:` URLs, so
  `git clone --recurse-submodules` fails without an SSH key. Fix:
  `git config --global url."https://github.com/".insteadOf "git@github.com:"`
  before cloning, or `git submodule set-url` inside `lib/v4-periphery`.
- `ref-fee-hook` never compiled upstream; it is kept only because it exercises
  the "static engine failed with an error code" path.

Then: `evidence/rescan.sh <hookrisk-root> <clones-root> <out-dir>` reads the
target for each slug from `evidence/agent-scan-results-before.json` and expects
`<clones-root>/<slug>/repo` for each. Orbital needs
`[harness] constructorArgs = ["$poolManager", "$currency0", "$currency1", "$currency1"]`
and `maxFeeBips = 10` in its `hookrisk.toml` (copy is in
`evidence/scans/after/orbital-hook-ctor/hookrisk.toml`).

## Decisions made, and why

- **The harness derives permissions from runtime code, always.** The static
  engine also resolves `getHookPermissions()`, but engines and the harness run
  concurrently, and the runtime derivation is the set the PoolManager would
  obey. Both are recorded (`permissions.fromEngine`, `permissions.fromRuntime`)
  and a disagreement is reported. The regex source parser was deleted.
- **Classifications never fail the gate.** `custom-accounting`,
  `callback-intentionally-disabled`, `unsupported-hook-abi` and `hook-profile`
  are INFO and exempt from `maxSeverity` (`isClassification` in
  `cli/src/types.ts`).
- **An undetermined tier fails the gate only with `failOnInconclusive = true`.**
  Six of nine dimensions had no detector, so the old default failed every
  hook including the official template. `hookrisk init` no longer writes
  `maxTier`. Our own fixtures (`harness/hookrisk.toml`) keep the strict
  setting because the dogfood workflow asserts an unrunnable hook exits 2.
- **Complexity is measured from the hook profile**, never from the absence of
  findings. Brackets are in `schema/framework-rubric.json` marked
  `interpretation: true`.
- **A zero-observation invariant pass is inconclusive.** The harness appends
  per-sequence counts (`harness/out/hookrisk-obs-<run>.jsonl`); the CLI sums
  them into `coverage.observations` and downgrades vacuous passes.
- **Static and dynamic layers reconcile** (`cli/src/reconcile.ts`): a
  deliberate revert-guard seen by HS-02 and a seed revert seen by the harness
  become one finding attributed to both, and I3 becomes not-applicable.
- **BlockSec runs with three workarounds** (platform, entrypoint bypass,
  mounted solc from binaries.soliditylang.org cached under
  `~/.cache/hookrisk/solc`). A symlinked `lib/` (as in `corpus/`) cannot be
  mounted; test BlockSec on `harness/` or a real project.
- **Monorepo install only.** `cli/package.json` is `private`; the CLI locates
  `harness/` and `schema/` relative to `dist/` or via `HOOKRISK_HOME`.

## Gotchas that cost time

- `.gitignore` ignores `hook-risk.json` and `HOOK_RISK.md` everywhere; the
  evidence directory is negated, but check `git status` after regenerating.
- The manifest schema is strict (`additionalProperties: false`). A new field
  emitted by the CLI without a schema entry fails every scan with HR-E501 and
  writes `hook-risk.invalid.json`. `make test` does not run a full scan, so
  run one (`corpus/`: `node ../cli/dist/cli.js scan src/good/CleanHook.sol:CleanHook`)
  after touching the manifest.
- Slither refuses to overwrite an existing `--json <file>`; the CLI uses a
  fresh temp path, ad-hoc runs must too.
- Concurrent scans in one checkout are safe (verified with forge 1.7.1); run
  records and observation logs are keyed by run id.

## Open items, in priority order

1. Detectors for the five unmeasured dimensions: HS-05 external-call-in-swap-path
   (helpers in `hook_analysis.py`), HS-04 upgradeability (StablePairHook is
   UUPS; the profile does not see proxies yet), HS-03 admin surface (the
   profile already computes `hasOwnerOnlyFunctions`), externalLiquidityExposure
   and autonomousParameterUpdates.
2. Harness reach: full-range seed fallback (`minUsableTick..maxUsableTick`)
   for full-range-only hooks; factory-parameter constructors (v2-on-v4);
   constructors needing a deployed dependency (Cork's `LiquidityToken`,
   WETHHook's WETH) via a per-hook deploy script hook.
3. Deployed mode from Uniswap's `hooklist` registry (116 entries with declared
   flags): fetch verified source via Sourcify, reconcile address bits against
   `getHookPermissions()`, bind the manifest to the codehash.
4. BlockSec in CI (1.2 GB amd64 image; decide on caching), and `--log-json`
   exposed as an action input.
5. `dedupe` merges cross-engine by selector; a hook that overloads a callback
   name would key ambiguously (not observed in 15 hooks).

## Conventions the code follows

Comments explain why, not what. No new CLI runtime dependencies (only `ajv`).
Error paths fail loudly with a catalogue code (`errors/catalog.json`, then
`make docs`). Every behaviour change has a test, and the harness has a
"proves it detects" test for every planted defect. Generated files are
checked in CI (`make check-generated`). Parallel work was done in worktrees
with disjoint file ownership and merged by an integrator; the per-agent notes
are the record of each seam.
