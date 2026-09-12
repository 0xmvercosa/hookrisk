# Hook Risk Report

**MEDIUM risk** — 9/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 9/33 from what could be measured, up to 26/33 if every unmeasured dimension were at its maximum — between medium and high. Unmeasured dimensions are excluded from the total, never counted as zero.

❌ **Gate failed.**
- tier is undetermined between Medium Risk and High Risk; the upper bound exceeds the configured maximum of medium

## What was assessed

| | |
| --- | --- |
| Contract | `WETHHook` |
| Source | `src/WETHHook.sol` |
| Mode | source |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | — | unmeasured | _unmeasured_ ᵃ |
| Custom math | 3/5 | measured | A custom curve or invariant function ᵃ |
| External dependencies | — | unmeasured | _unmeasured_ ᵃ |
| External liquidity exposure | — | unmeasured | _unmeasured_ ᵃ |
| TVL potential | 0/5 | declared | Under $100K (experimental or personal project) |
| Team maturity | 3/3 | declared | Unproven: no prior production deployments, or deployments lacking audits and operational rigor; new, anonymous, or no public track record |
| Upgradeability | — | unmeasured | _unmeasured_ ᵃ |
| Autonomous parameter updates | — | unmeasured | _unmeasured_ ᵃ |
| Price impacting behavior | 3/3 | measured | Returns a swap delta (custom curve or NoOp), or adjusts fees without a ceiling ᵃ |

ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine dimensions; the rest are our reading of its prose. See [FEEDBACK.md](FEEDBACK.md) #2.

### Feature triggers

These apply regardless of the total score — the framework's own safeguard against a team scoring itself low while shipping a dangerous primitive.

- **Custom Curve or Non Standard Math** — fired by customMath >= 3 (is 3), returns-delta-permission _(derivation is hookrisk's reading)_
- **Price Impacting Behavior** — fired by priceImpactingBehavior >= 1 (is 3), returns-delta-permission _(derivation is hookrisk's reading)_

## Security plan

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

## Findings

### ℹ️ WETHHook (src/WETHHook.sol#12-54) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3)

`custom-accounting` · **info** · confidence **high**

`src/WETHHook.sol:12`

WETHHook (src/WETHHook.sol#12-54) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3). The hook can alter settled amounts, which raises its risk tier under the framework's custom-math and price-impact triggers and means differential output comparison (invariant I2) does not apply — the harness substitutes price monotonicity.

Reported by: `hookrisk/hookrisk-custom-accounting`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | skipped | WETHHook's constructor takes 2 argument(s) (address _manager, address _weth) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I2 No undeclared extraction | skipped | WETHHook's constructor takes 2 argument(s) (address _manager, address _weth) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I3 Exit liveness | skipped | WETHHook's constructor takes 2 argument(s) (address _manager, address _weth) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 1 |  |
| Differential harness (Foundry) | skipped | 0 | WETHHook's constructor takes 2 argument(s) (address _manager, address _weth) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

> ⚠️ **26 function(s) were not analysed.** Slither could not lift them to IR and continued silently. Findings below do not cover them — this is not the same as those functions being clean. See `HR-E205`.

- `BaseAggregatorHook._getFullDebt`
- `BaseAggregatorHook._getFullCredit`
- `BaseHookDataAggregator._getFullDebt`
- `BaseHookDataAggregator._getFullCredit`
- `FluidDexLiteAggregator._getFullDebt`
- `FluidDexLiteAggregator._getFullCredit`
- `FluidDexT1Aggregator._getFullDebt`
- `FluidDexT1Aggregator._getFullCredit`
- `LitePSMAggregator._getFullDebt`
- `LitePSMAggregator._getFullCredit`
- `PancakeSwapV3Aggregator._getFullDebt`
- `PancakeSwapV3Aggregator._getFullCredit`
- `SlipstreamAggregator._getFullDebt`
- `SlipstreamAggregator._getFullCredit`
- `StableSwapAggregator._getFullDebt`
- `StableSwapAggregator._getFullCredit`
- `StableSwapNGAggregator._getFullDebt`
- `StableSwapNGAggregator._getFullCredit`
- `TempoExchangeAggregator._getFullDebt`
- `TempoExchangeAggregator._getFullCredit`
- `UniswapV2Aggregator._getFullDebt`
- `UniswapV2Aggregator._getFullCredit`
- `UniswapV3Aggregator._getFullDebt`
- `UniswapV3Aggregator._getFullCredit`
- `UniswapXAggregator._getFullDebt`
- `UniswapXAggregator._getFullCredit`

## Warnings

- 5 dimension(s) unmeasured: the tier is between Medium Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
