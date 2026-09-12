# Hook Risk Report

**MEDIUM risk** — 12/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 12/33 from what could be measured, up to 24/33 if every unmeasured dimension were at its maximum — between medium and high. Unmeasured dimensions are excluded from the total, never counted as zero.

✅ **Gate passed.**

## What was assessed

| | |
| --- | --- |
| Contract | `LiquidityPenaltyHookMock` |
| Source | `src/mocks/general/LiquidityPenaltyHookMock.sol` |
| Mode | source |

### Hook profile

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

Complexity is derived from these metrics; the rule that fired is in the score table’s evidence.

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

### ℹ️ LiquidityPenaltyHookMock (src/mocks/general/LiquidityPenaltyHookMock.sol#10-18) declares custom-accounting permissions: `afterAddLiquidityReturnDelta` (bit …

`custom-accounting` · **info** · confidence **high**

`src/mocks/general/LiquidityPenaltyHookMock.sol:10`

LiquidityPenaltyHookMock (src/mocks/general/LiquidityPenaltyHookMock.sol#10-18) declares custom-accounting permissions: `afterAddLiquidityReturnDelta` (bit 1), `afterRemoveLiquidityReturnDelta` (bit 0). The hook can alter settled amounts, which raises its risk tier under the framework's custom-math and price-impact triggers and is liquidity-side only: swaps still route through v4's pricing, so the harness keeps comparing swap output against the reference pool (invariant I2).

Reported by: `hookrisk/hookrisk-custom-accounting`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ✅ | I1 Conservation and solvency | passed |  |
| ✅ | I2 No undeclared extraction | passed |  |
| ✅ | I3 Exit liveness | passed |  |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 2 |  |
| Differential harness (Foundry) | ok | 0 |  |

The harness executed 13510 swap(s) (13510 compared against the reference pool, 0 skipped), opened 6710 and closed 6710 position(s), made 6955 donation(s) and ran 13510 price check(s) over 1285 sequence(s). An invariant with no relevant observations is reported inconclusive, not passed.

> ⚠️ **3 function(s) were not analysed.** Slither could not lift them to IR and continued silently. Findings below do not cover them — this is not the same as those functions being clean. See `HR-E205`.

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
