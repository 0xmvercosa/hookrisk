# Hook Risk Report — Counter

Executable assessment against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework): static detectors, a differential twin-pool harness, and the framework’s scoring rubric. Unmeasured dimensions are excluded from the total, never counted as zero.

## Summary

| | |
| --- | --- |
| Contract | `Counter` in `src/Counter.sol` |
| Compiler | solc 0.8.30 |
| Risk tier | **LOW** 5/33, undetermined up to HIGH 25/33 |
| Gate | ✅ Passed |
| Findings | none |
| Dimensions | 1 measured · 2 declared · 6 unmeasured |
| Static analysis | ok |
| Differential harness | ok |
| Invariants | ✅ I1 passed · ✅ I2 passed · ✅ I3 passed |
| Tool | hookrisk 0.1.0, rubric e7e8da52fd5717b6eb4517ea779b766f63148c41 |

> **The tier is a range.** 5/33 is the sum of what could be measured or was declared; 6 dimensions have no detector or declaration. At their maximum the hook would score 25/33 (high). Declare them in `hookrisk.toml` to close the range.

## Findings

No defects. The classifications and the hook profile below describe the hook without accusing it.

## Hook profile

The static engine’s structural measurement of the contract. Complexity is derived from these metrics; the rule that fired is quoted in the score table’s evidence.

| Metric | Value |
| --- | --- |
| Callbacks implemented (working; deliberate revert-guards are listed as disabled) | 4 |
| Callbacks declared | 4 |
| State writes in callbacks | 4 |
| External calls in the swap path | 0 |
| Internal functions reachable from callbacks | 4 |
| Returns a delta | false |
| Owner-only surface | false |
| Permissions declared | `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `afterSwap` |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | 2/5 | measured | Callbacks write hook state, or 3+ callbacks ᵃ |
| Custom math | — | unmeasured | _unmeasured_ ᵃ |
| External dependencies | — | unmeasured | _unmeasured_ ᵃ |
| External liquidity exposure | — | unmeasured | _unmeasured_ ᵃ |
| TVL potential | 0/5 | declared | Under $100K (experimental or personal project) |
| Team maturity | 3/3 | declared | Unproven: no prior production deployments, or deployments lacking audits and operational rigor; new, anonymous, or no public track record |
| Upgradeability | — | unmeasured | _unmeasured_ ᵃ |
| Autonomous parameter updates | — | unmeasured | _unmeasured_ ᵃ |
| Price impacting behavior | — | unmeasured | _unmeasured_ ᵃ |

ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine dimensions; the rest are our reading of its prose. See [FEEDBACK.md](https://github.com/0xmvercosa/hookrisk/blob/main/FEEDBACK.md) #2.

<details><summary>Evidence per dimension</summary>

- **Complexity**
  - hook-profile metrics: callbacksImplemented=4, callbacksDeclared=4, stateWritesInCallbacks=4, externalCallsInSwapPath=0, internalFunctionsReachableFromCallbacks=4, usesReturnsDelta=false, hasOwnerOnlyFunctions=false
  - Scored 2 by rule `stateWritesInCallbacks >= 1 || callbacksImplemented >= 3`: Hook state written in callbacks is the 'branching logic' the prose names first; three or more callbacks is its 'number of callbacks'. (hookrisk’s interpretation; the framework publishes no brackets)
  - The hook implements callbacks with non-trivial structure. This establishes a floor only; the measured value comes from the hook-profile metrics when the engine profiled the target.
- **Custom math**
  - Not measured: no detector for rounding-direction yet.
- **External dependencies**
  - Not measured: no detector for external-call-in-swap-path yet.
- **TVL potential**
  - Declared in hookrisk.toml. hookrisk does not measure tvlPotential.
- **Team maturity**
  - Declared in hookrisk.toml. hookrisk does not measure teamMaturity.
- **Upgradeability**
  - Not measured: no detector for upgradeable-hook (needs blocksec, which did not run); selfdestruct requires blocksec, which did not run.
- **Price impacting behavior**
  - Not measured: no detector for unbounded-dynamic-fee yet.

</details>

## Security plan

The strongest requirement across the tier baseline and every fired trigger, with the source of each.

| Action | Strength | Because |
| --- | --- | --- |
| Security audit | **Required** | `tier:low` |
| Automated static analysis | **Required** | `tier:low` |
| Bug bounty programme | Optional | `tier:low` |
| Audit by a math and invariants specialist | Optional | `tier:low` |
| Continuous monitoring with anomaly detection | Optional | `tier:low` |

## Dynamic analysis

Differential twin-pool harness: **ok**.

| Run | |
| --- | --- |
| Hook address flags | `0xac0` (derived from the runtime code) |
| Pricing | v4 pricing: output compared against the reference pool |
| Pool fee | static |
| Initial liquidity | seeded on both pools |

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ✅ | I1 Conservation and solvency | passed |  |
| ✅ | I2 No undeclared extraction | passed |  |
| ✅ | I3 Exit liveness | passed |  |

| Observed | |
| --- | --- |
| Fuzz sequences | 1285 |
| Swaps landed / compared / skipped | 13885 / 13885 / 0 |
| Swaps that reverted only with the hook | 0 |
| Positions opened / closed | 6935 / 6935 |
| Donations | 6825 |
| Price checks / monotonicity violations | 13885 / 0 |
| Exit failures | 0 |

The harness executed 13885 swap(s) (13885 compared against the reference pool, 0 skipped), opened 6935 and closed 6935 position(s), made 6825 donation(s) and ran 13885 price check(s) over 1285 sequence(s). An invariant with no relevant observations is reported inconclusive, not passed.

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 1 |  |
| Differential harness (Foundry) | ok | 0 |  |

Permissions resolved by static analysis and derived from the deployed runtime code agree.

## Warnings

- 6 dimension(s) unmeasured: the tier is between Low Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'custom-math' could not be evaluated: dimension 'customMath' is unmeasured
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'price-impact' could not be evaluated: dimension 'priceImpactingBehavior' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
