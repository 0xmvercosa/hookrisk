# Hook Risk Report

**MEDIUM risk** — 13/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 13/33 from what could be measured, up to 25/33 if every unmeasured dimension were at its maximum — between medium and high. Unmeasured dimensions are excluded from the total, never counted as zero.

✅ **Gate passed.**

## What was assessed

| | |
| --- | --- |
| Contract | `Counter` |
| Source | `src/Counter.sol` |
| Mode | source |

### Hook profile

| Metric | Value |
| --- | --- |
| Callbacks implemented (working; deliberate revert-guards are listed as disabled) | 1 |
| Callbacks declared | 2 |
| State writes in callbacks | 0 |
| External calls in the swap path | 2 |
| Internal functions reachable from callbacks | 3 |
| Returns a delta | true |
| Owner-only surface | false |
| Permissions declared | `beforeAddLiquidity`, `beforeSwap`, `beforeSwapReturnDelta` |

Complexity is derived from these metrics; the rule that fired is in the score table’s evidence.

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | 4/5 | measured | Returns a delta and makes an external call in the swap path ᵃ |
| Custom math | 3/5 | measured | A custom curve or invariant function ᵃ |
| External dependencies | — | unmeasured | _unmeasured_ ᵃ |
| External liquidity exposure | — | unmeasured | _unmeasured_ ᵃ |
| TVL potential | 0/5 | declared | Under $100K (experimental or personal project) |
| Team maturity | 3/3 | declared | Unproven: no prior production deployments, or deployments lacking audits and operational rigor; new, anonymous, or no public track record |
| Upgradeability | — | unmeasured | _unmeasured_ ᵃ |
| Autonomous parameter updates | — | unmeasured | _unmeasured_ ᵃ |
| Price impacting behavior | 3/3 | measured | Returns a swap delta (custom curve or NoOp), or adjusts fees without a ceiling ᵃ |

ᵃ Bracket supplied by hookrisk. The framework publishes brackets for only two of its nine dimensions; the rest are our reading of its prose. See [FEEDBACK.md](https://github.com/0xmvercosa/hookrisk/blob/main/FEEDBACK.md) #2.

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

### ℹ️ Counter (src/Counter.sol#18-127) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3)

`custom-accounting` · **info** · confidence **high**

`src/Counter.sol:18`

Counter (src/Counter.sol#18-127) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3). The hook can alter settled amounts, which raises its risk tier under the framework's custom-math and price-impact triggers and means differential output comparison (invariant I2) does not apply — the harness substitutes price monotonicity.

Reported by: `hookrisk/hookrisk-custom-accounting`

### ℹ️ Counter._beforeAddLiquidity(address,PoolKey,IPoolManager.ModifyLiquidityParams,bytes) (src/Counter.sol#87-94) overrides `beforeAddLiquidity` with `revert "No …

`callback-intentionally-disabled` (`beforeAddLiquidity`) · **info** · confidence **high** · **corroborated by multiple engines**

`src/Counter.sol:87`

Counter._beforeAddLiquidity(address,PoolKey,IPoolManager.ModifyLiquidityParams,bytes) (src/Counter.sol#87-94) overrides `beforeAddLiquidity` with `revert "No v4 Liquidity allowed"`, so PoolManager-routed liquidity addition is disabled by design; the differential harness records such reverts when it runs. This is not the missing implementation HS-02 reports.

Reported by: `hookrisk/hookrisk-disabled-callback`, `harness/seed-reverted`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | inconclusive | inconclusive, nothing relevant was observed: 0 swaps landed and 0 positions opened across 1285 sequences; the hook rejected PoolManager liquidity (Error("No v4 Liquidity allowed")) so the pool never traded; a swap that worked without the hook reverted with it in 1285 sequence(s). Observed: 1285 sequence(s), 0 swap(s) landed, 0 compared, 0 price check(s), 0 position(s) opened, 0 closed, 0 donation(s), 1285 hooked-only swap revert(s), 0 exit failure(s). |
| ⚠️ | I2 Price monotonicity (custom curve) | inconclusive | inconclusive, nothing relevant was observed: 0 price checks across 1285 sequences; the hook rejected PoolManager liquidity (Error("No v4 Liquidity allowed")) so the pool never traded; a swap that worked without the hook reverted with it in 1285 sequence(s). Observed: 1285 sequence(s), 0 swap(s) landed, 0 compared, 0 price check(s), 0 position(s) opened, 0 closed, 0 donation(s), 1285 hooked-only swap revert(s), 0 exit failure(s). Output comparison against an unhooked pool does not apply to a custom-curve hook; price monotonicity was asserted instead. |
| ➖ | I3 Exit liveness | not-applicable | PoolManager liquidity is disabled by design: hookrisk classifies beforeAddLiquidity as intentionally disabled and the harness's seed position was rejected with Error("No v4 Liquidity allowed"). No position can exist on the hooked pool, so exit liveness has nothing to assert; liquidity held through the hook's own path is not exercised. The harness opened 0 position(s). |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 3 |  |
| Differential harness (Foundry) | ok | 0 |  |

The harness executed 0 swap(s) (0 compared against the reference pool, 0 skipped), opened 0 and closed 0 position(s), made 0 donation(s) and ran 0 price check(s) over 1285 sequence(s). An invariant with no relevant observations is reported inconclusive, not passed.

## Warnings

- 4 dimension(s) unmeasured: the tier is between Medium Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
