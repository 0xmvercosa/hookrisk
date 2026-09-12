# 14 real hooks, before and after the hackathon fixes

Same clones, same `hookrisk.toml` (init defaults), scanned with `main@db08091` (before) and `feat/hackathon-p0` (after). Each directory holds `hook-risk.json`, `HOOK_RISK.md` and the verbose `scan.stderr`. Regenerate the after side with `rescan.sh <hookrisk-root> <out-dir>` against the clones.

| Hook | Findings before | Findings after | Harness before | Harness after | Invariants after | Tier band after |
|---|---|---|---|---|---|---|
| cork-hook | 4 high, 1 info | 4 high, 2 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | medium 10–22 |
| nft-owners-only | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | low 3–28 |
| orbital-hook | 1 high, 1 info | 3 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | medium 9–26 |
| oz-antisandwich-mock | 1 info | 1 info | skipped | ok | I1 passed, I2 passed, I3 passed | medium 9–26 |
| oz-limitorder-mock | none | none | skipped | ok | I1 passed, I2 passed, I3 passed | low 3–28 |
| ref-fee-hook | none | none | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | low 3–28 |
| take-profits-hook | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | low 3–28 |
| trading-days | none | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | low 3–28 |
| v2-on-v4 | 2 high, 1 info | 1 high, 2 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | medium 10–22 |
| v4-constant-sum | 1 high, 1 info | 2 info | ok (0 invariants!) | ok | I1 passed, I2 passed, I3 passed | medium 9–26 |
| v4-hooks-public-stablepair | 1 high | 1 high | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | low 4–24 |
| v4-hooks-public-weth | 1 high, 1 info | 1 info | skipped | skipped | I1 skipped, I2 skipped, I3 skipped | medium 9–26 |
| v4-stoploss | none | 1 info | skipped | failed | I1 inconclusive, I2 inconclusive, I3 inconclusive | low 3–28 |
| v4-template-counter | none | none | ok | ok | I1 passed, I2 passed, I3 passed | low 3–28 |
| orbital-hook + constructorArgs | — | 3 info | — | ok (hooked-failed) | I1 passed, I2 passed, I3 passed | medium 9–26 |

Every scan exits 2 (gate failed) in both runs: the default gate is `maxTier = "medium"` and six of nine rubric dimensions have no detector yet, so the tier upper bound is High for every hook. That is the design refusing to certify what it did not measure, not a verdict on the hooks.
