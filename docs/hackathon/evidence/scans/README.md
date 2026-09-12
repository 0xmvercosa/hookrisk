# 15 real hooks, before and after

Same clones, `hookrisk.toml` regenerated with the final `init` template (Orbital and LiquidityPenaltyHookMock add `[harness] constructorArgs`, copies are in their directories), scanned with `main@db08091` (before) and the final `feat/hackathon-p0` (after). Each directory holds `hook-risk.json`, `HOOK_RISK.md` and the verbose `scan.stderr`; `after/summary.jsonl` is the machine-readable summary. Regenerate with `../rescan.sh <hookrisk-root> <clones-root> <out-dir>`. Finding counts exclude the informational `hook-profile` every recognised hook carries.

| Hook | Findings before | Findings after | Harness before | Harness after | Invariants after | Complexity | Gate after | Tier band after |
|---|---|---|---|---|---|---|---|---|
| cork-hook | 4 high, 1 info | 3 high, 2 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | 5/5 | failed: 3 finding(s) at or above high | medium 14–26 |
| nft-owners-only | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | failed: engine hookrisk did not analyse the target | low 3–28 |
| orbital-hook | 1 high, 1 info | 3 info | skipped | ok (hooked-failed) | I1 inconclusive, I2 inconclusive, I3 not-applicable | 4/5 | passed | medium 13–25 |
| oz-antisandwich-mock | 1 info | 1 info | skipped | ok (both) | I1 passed, I2 passed, I3 passed | 4/5 | passed | medium 13–25 |
| oz-limitorder-mock | none | none | skipped | ok (both) | I1 passed, I2 passed, I3 passed | 3/5 | passed | low 6–26 |
| oz-liquiditypenalty-mock | — (new) | 1 info | — | ok (both) | I1 passed, I2 passed, I3 passed | 3/5 | passed | medium 12–24 |
| ref-fee-hook | none | none | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | failed: engine hookrisk failed | low 3–28 |
| take-profits-hook | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | failed: engine hookrisk did not analyse the target | low 3–28 |
| trading-days | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | failed: engine hookrisk did not analyse the target | low 3–28 |
| v2-on-v4 | 2 high, 1 info | 1 high, 2 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | 4/5 | failed: the differential harness failed; 1 finding(s) at or above hi | medium 13–25 |
| v4-constant-sum | 1 high, 1 info | 2 info | ok (0 invariants!) | ok (hooked-failed) | I1 inconclusive, I2 inconclusive, I3 not-applicable | 4/5 | passed | medium 13–25 |
| v4-hooks-public-stablepair | 1 high | 1 high, 1 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | 2/5 | failed: the differential harness failed; 1 finding(s) at or above hi | low 5–25 |
| v4-hooks-public-weth | 1 high, 1 info | 2 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | 4/5 | passed | medium 13–25 |
| v4-stoploss | none | 1 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | — | failed: engine hookrisk did not analyse the target; the differential | low 3–28 |
| v4-template-counter | none | none | ok | ok (both) | I1 passed, I2 passed, I3 passed | 2/5 | passed | low 5–25 |

Gate semantics changed between the runs. Before, the default `maxTier = "medium"` failed every hook on an undetermined tier. After, an undetermined tier fails only with `failOnInconclusive = true`, but an engine that failed or a target the static engine never recognised fails by default (`failOnNotAnalysed`): a scan that assessed nothing is not a pass. So the gate fails on the three hooks with HIGH findings (Cork, StablePairHook, v2-on-v4) and on the five that could not be analysed (four 2023-ABI hooks and the repo that does not compile), and passes on the seven that were measured.
