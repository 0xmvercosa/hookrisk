# Hook Risk Report

**LOW risk** — 4/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 4/33 from what could be measured, up to 24/33 if every unmeasured dimension were at its maximum — between low and high. Unmeasured dimensions are excluded from the total, never counted as zero.

❌ **Gate failed.**
- tier is undetermined between Low Risk and High Risk; the upper bound exceeds the configured maximum of medium
- 1 finding(s) at or above high: StablePairHook (src/stable/StablePairHook.sol#25-259) declares permission `afterInitialize` (bit 12, AFTER_INITIALIZE_FLAG) but provides no working `afterIni...

## What was assessed

| | |
| --- | --- |
| Contract | `StablePairHook` |
| Source | `src/stable/StablePairHook.sol` |
| Mode | source |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | 1/5 | measured | 1-2 callbacks, no branching on hook state ᵃ |
| Custom math | — | unmeasured | _unmeasured_ ᵃ |
| External dependencies | — | unmeasured | _unmeasured_ ᵃ |
| External liquidity exposure | — | unmeasured | _unmeasured_ ᵃ |
| TVL potential | 0/5 | declared | Under $100K (experimental or personal project) |
| Team maturity | 3/3 | declared | Unproven: no prior production deployments, or deployments lacking audits and operational rigor; new, anonymous, or no public track record |
| Upgradeability | — | unmeasured | _unmeasured_ ᵃ |
| Autonomous parameter updates | — | unmeasured | _unmeasured_ ᵃ |
| Price impacting behavior | — | unmeasured | _unmeasured_ ᵃ |

ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine dimensions; the rest are our reading of its prose. See [FEEDBACK.md](FEEDBACK.md) #2.

## Security plan

| Action | Strength | Because |
| --- | --- | --- |
| Security audit | **Required** | `tier:low` |
| Automated static analysis | **Required** | `tier:low` |
| Bug bounty programme | Optional | `tier:low` |
| Audit by a math and invariants specialist | Optional | `tier:low` |
| Continuous monitoring with anomaly detection | Optional | `tier:low` |

## Findings

### 🟠 StablePairHook (src/stable/StablePairHook.sol#25-259) declares permission `afterInitialize` (bit 12, AFTER_INITIALIZE_FLAG) but provides no working `afterIni...

`flag-implementation-divergence` · **high** · confidence **medium**

`src/stable/StablePairHook.sol:25`

StablePairHook (src/stable/StablePairHook.sol#25-259) declares permission `afterInitialize` (bit 12, AFTER_INITIALIZE_FLAG) but provides no working `afterInitialize` implementation. The PoolManager will call it on every matching pool operation and the call will revert, making the pool unusable for that operation.

Reported by: `hookrisk/hookrisk-flag-divergence`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | inconclusive | harness setUp failed: TwinPools: hooked pool would not initialise. With fee 3000: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496; with a dynamic fee: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304). |
| ⚠️ | I2 No undeclared extraction | inconclusive | harness setUp failed: TwinPools: hooked pool would not initialise. With fee 3000: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496; with a dynamic fee: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304). |
| ⚠️ | I3 Exit liveness | inconclusive | harness setUp failed: TwinPools: hooked pool would not initialise. With fee 3000: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496; with a dynamic fee: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304). |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 1 |  |
| Differential harness (Foundry) | failed | 0 | harness setUp failed: TwinPools: hooked pool would not initialise. With fee 3000: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496; with a dynamic fee: 0x1210aa130000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304). |

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

- 6 dimension(s) unmeasured: the tier is between Low Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'custom-math' could not be evaluated: dimension 'customMath' is unmeasured
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'price-impact' could not be evaluated: dimension 'priceImpactingBehavior' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
