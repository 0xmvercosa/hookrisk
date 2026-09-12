# 14 real hooks, before and after

Same clones, same `hookrisk.toml` (init defaults; Orbital's second row adds `[harness] constructorArgs`), scanned with `main@db08091` (before) and the final `feat/hackathon-p0` (after). Each directory holds `hook-risk.json`, `HOOK_RISK.md` and the verbose `scan.stderr`; `after/summary.jsonl` is the machine-readable summary. Regenerate the after side with `../rescan.sh <hookrisk-root> <out-dir>` against the clones. Finding counts exclude the informational `hook-profile` every recognised hook now carries.

| Hook | Findings before | Findings after | Harness before | Harness after | Invariants after | Complexity | Gate after | Tier band after |
|---|---|---|---|---|---|---|---|---|
| cork-hook | 4 high, 1 info | 4 high, 2 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | 5/5 | failed | medium 14–26 |
| nft-owners-only | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | passed | low 3–28 |
| orbital-hook | 1 high, 1 info | 3 info | skipped | ok (hooked-failed) | I1 inconclusive, I2 inconclusive, I3 not-applicable | 4/5 | passed | medium 13–25 |
| oz-antisandwich-mock | 1 info | 1 info | skipped | ok (both) | I1 passed, I2 passed, I3 passed | 4/5 | passed | medium 13–25 |
| oz-limitorder-mock | none | none | skipped | ok (both) | I1 passed, I2 passed, I3 passed | 3/5 | passed | low 6–26 |
| ref-fee-hook | none | none | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | passed | low 3–28 |
| take-profits-hook | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | passed | low 3–28 |
| trading-days | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | — | passed | low 3–28 |
| v2-on-v4 | 2 high, 1 info | 1 high, 2 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | 4/5 | failed | medium 13–25 |
| v4-constant-sum | 1 high, 1 info | 2 info | ok (0 invariants!) | ok (hooked-failed) | I1 inconclusive, I2 inconclusive, I3 not-applicable | 4/5 | passed | medium 13–25 |
| v4-hooks-public-stablepair | 1 high | 1 high | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | 2/5 | failed | low 5–25 |
| v4-hooks-public-weth | 1 high, 1 info | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | 4/5 | passed | medium 13–25 |
| v4-stoploss | none | 1 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | — | passed | low 3–28 |
| v4-template-counter | none | none | ok | ok (both) | I1 passed, I2 passed, I3 passed | 2/5 | passed | low 5–25 |
| orbital-hook + constructorArgs | — | 3 info | — | ok (hooked-failed) | I1 inconclusive, I2 inconclusive, I3 not-applicable | 4/5 | passed | medium 13–25 |

Gate semantics changed between the two runs: before, the default `maxTier = "medium"` failed every hook on an undetermined tier; after, an undetermined tier only fails the gate with `failOnInconclusive = true`, so the gate now discriminates on findings and invariants. Cork, StablePairHook and v2-on-v4 fail on HIGH findings; everything else passes or is honestly unmeasured.
