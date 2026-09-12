# Hook Risk Report — LiquidityPenaltyHookMock

Executable assessment against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework): static detectors, a differential twin-pool harness, and the framework’s scoring rubric. Unmeasured dimensions are excluded from the total, never counted as zero.

## Summary

| | |
| --- | --- |
| Contract | `LiquidityPenaltyHookMock` in `src/mocks/general/LiquidityPenaltyHookMock.sol` |
| Compiler | solc 0.8.26 |
| Risk tier | **MEDIUM** 12/33, undetermined up to HIGH 24/33 |
| Gate | ✅ Passed |
| Findings | none · 1 classification |
| Dimensions | 3 measured · 2 declared · 4 unmeasured |
| Static analysis | ok |
| Differential harness | ok |
| Invariants | ✅ I1 passed · ✅ I2 passed · ✅ I3 passed |
| Tool | hookrisk 0.1.0, rubric e7e8da52fd5717b6eb4517ea779b766f63148c41 |

> **The tier is a range.** 12/33 is the sum of what could be measured or was declared; 4 dimensions have no detector or declaration. At their maximum the hook would score 24/33 (high). Declare them in `hookrisk.toml` to close the range.

## Findings

No defects. The classifications and the hook profile below describe the hook without accusing it.

## Classifications

Properties of the hook that change how it is scored or tested. They are informational and never fail the gate.

| Rule | Classification | Applies to | Detail |
| --- | --- | --- | --- |
| HS-07 `custom-accounting` | Custom accounting: the hook can alter settled amounts | `src/mocks/general/LiquidityPenaltyHookMock.sol:10` | LiquidityPenaltyHookMock (src/mocks/general/LiquidityPenaltyHookMock.sol#10-18) declares custom-accounting permissions: `afterAddLiquidityReturnDelta` (bit 1), `afterRemoveLiquidityReturnDelta` (bit 0). |

## Hook profile

The static engine’s structural measurement of the contract. Complexity is derived from these metrics; the rule that fired is quoted in the score table’s evidence.

| Metric | Value |
| --- | --- |
| Callbacks implemented (working; deliberate revert-guards are listed as disabled) | 2 |
| Callbacks declared | 2 |
| State writes in callbacks | 3 |
| External calls in the swap path | 0 |
| Internal functions reachable from callbacks | 13 |
| Returns a delta | true |
| Owner-only surface | false |
| Permissions declared | `afterAddLiquidity`, `afterRemoveLiquidity`, `afterAddLiquidityReturnDelta`, `afterRemoveLiquidityReturnDelta` |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | 3/5 | measured | Returns a delta, or makes an external call in the swap path ᵃ |
| Custom math | 3/5 | measured | A custom curve or invariant function ᵃ |
| External dependencies | — | unmeasured | _unmeasured_ ᵃ |
| External liquidity exposure | — | unmeasured | _unmeasured_ ᵃ |
| TVL potential | 0/5 | declared | Under $100K (experimental or personal project) |
| Team maturity | 3/3 | declared | Unproven: no prior production deployments, or deployments lacking audits and operational rigor; new, anonymous, or no public track record |
| Upgradeability | — | unmeasured | _unmeasured_ ᵃ |
| Autonomous parameter updates | — | unmeasured | _unmeasured_ ᵃ |
| Price impacting behavior | 3/3 | measured | Returns a swap delta (custom curve or NoOp), or adjusts fees without a ceiling ᵃ |

ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine dimensions; the rest are our reading of its prose. See [FEEDBACK.md](https://github.com/0xmvercosa/hookrisk/blob/main/FEEDBACK.md) #2.

<details><summary>Evidence per dimension</summary>

- **Complexity**
  - hook-profile metrics: callbacksImplemented=2, callbacksDeclared=2, stateWritesInCallbacks=3, externalCallsInSwapPath=0, internalFunctionsReachableFromCallbacks=13, usesReturnsDelta=true, hasOwnerOnlyFunctions=false
  - Scored 3 by rule `usesReturnsDelta || externalCallsInSwapPath >= 1`: Either a returns-delta permission or an external call in the swap path is a 'multi-step flow' in the prose's sense: the callback's effect is not local to itself. (hookrisk’s interpretation; the framework publishes no brackets)
  - The hook implements callbacks with non-trivial structure. This establishes a floor only; the measured value comes from the hook-profile metrics when the engine profiled the target.
- **Custom math**
  - 1 custom-accounting finding(s)
  - Custom accounting implies a custom curve or non-standard settlement arithmetic.
- **External dependencies**
  - Not measured: no detector for external-call-in-swap-path yet.
- **TVL potential**
  - Declared in hookrisk.toml. hookrisk does not measure tvlPotential.
- **Team maturity**
  - Declared in hookrisk.toml. hookrisk does not measure teamMaturity.
- **Upgradeability**
  - Not measured: no detector for upgradeable-hook (needs blocksec, which did not run); selfdestruct requires blocksec, which did not run.
- **Price impacting behavior**
  - 1 custom-accounting finding(s)
  - A returns-delta permission lets the hook alter settled amounts, which is the framework’s definition of price-impacting behaviour.

</details>

### Feature triggers

These apply regardless of the total: the framework’s own safeguard against a team scoring itself low while shipping a dangerous primitive.

| Trigger | Fired by | Derivation |
| --- | --- | --- |
| Custom Curve or Non Standard Math | `customMath >= 3 (is 3)`, `returns-delta-permission` | hookrisk’s reading |
| Price Impacting Behavior | `priceImpactingBehavior >= 1 (is 3)`, `returns-delta-permission` | hookrisk’s reading |

## Security plan

The strongest requirement across the tier baseline and every fired trigger, with the source of each.

| Action | Strength | Because |
| --- | --- | --- |
| Adversarial and economic simulation | **Required** | `trigger:price-impact` |
| Security audit | **Required** | `tier:medium` |
| Bug bounty programme | **Required** | `tier:medium`, `trigger:price-impact` |
| Audit by a math and invariants specialist | **Required** | `trigger:custom-math`, `trigger:price-impact` |
| Automated static analysis | **Required** | `tier:medium` |
| Unit tests covering input-range boundaries | **Required** | `trigger:custom-math` |
| Extended test coverage | Recommended | `tier:medium` |
| Formal verification | Recommended | `trigger:custom-math` |
| Invariant and stateful fuzz testing | Recommended | `trigger:custom-math` |
| Continuous monitoring with anomaly detection | Recommended | `tier:medium`, `trigger:custom-math` |
| Second independent audit | Optional | `tier:medium` |

## Dynamic analysis

Differential twin-pool harness: **ok**.

| Run | |
| --- | --- |
| Hook address flags | `0x503` (derived from the runtime code) |
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
| Swaps landed / compared / skipped | 13510 / 13510 / 0 |
| Swaps that reverted only with the hook | 0 |
| Positions opened / closed | 6710 / 6710 |
| Donations | 6955 |
| Price checks / monotonicity violations | 13510 / 0 |
| Exit failures | 0 |

The harness executed 13510 swap(s) (13510 compared against the reference pool, 0 skipped), opened 6710 and closed 6710 position(s), made 6955 donation(s) and ran 13510 price check(s) over 1285 sequence(s). An invariant with no relevant observations is reported inconclusive, not passed.

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 2 |  |
| Differential harness (Foundry) | ok | 0 |  |

Permissions resolved by static analysis and derived from the deployed runtime code agree.

> ⚠️ **3 function(s) in the compilation unit were not analysed.** Slither could not lift them to IR and continued silently. Findings above do not cover them; that is not the same as those functions being clean. See `HR-E205`.

- `ReHypothecationHook._resolveHookDelta`
- `ReHypothecationERC4626Mock._resolveHookDelta`
- `ReHypothecationNativeMock._resolveHookDelta`

## Warnings

- 4 dimension(s) unmeasured: the tier is between Medium Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
