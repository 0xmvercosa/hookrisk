# Hook Risk Report

**LOW risk** — 3/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 3/33 from what could be measured, up to 28/33 if every unmeasured dimension were at its maximum — between low and high. Unmeasured dimensions are excluded from the total, never counted as zero.

✅ **Gate passed.**

> ℹ️ tier is undetermined between Low Risk and High Risk; the measured lower bound is within the configured maximum of medium and failOnInconclusive is off, so the range does not fail the gate (7 dimension(s) unmeasured: complexity, customMath, externalDependencies, externalLiquidityExposure, upgradeability, autonomousParameterUpdates, priceImpactingBehavior). Declare the unmeasured dimensions in hookrisk.toml to close it, or set failOnInconclusive = true.

## What was assessed

| | |
| --- | --- |
| Contract | `TakeProfitsHook` |
| Source | `src/TakeProfitsHook.sol` |
| Mode | source |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | — | unmeasured | _unmeasured_ ᵃ |
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

### ℹ️ TakeProfitsHook (src/TakeProfitsHook.sol#17-391) looks like a Uniswap v4 hook but its hook ABI predates the shipped v4 interface (declares the 2023 getHooksC...

`unsupported-hook-abi` · **info** · confidence **high**

`src/TakeProfitsHook.sol:17`

TakeProfitsHook (src/TakeProfitsHook.sol#17-391) looks like a Uniswap v4 hook but its hook ABI predates the shipped v4 interface (declares the 2023 getHooksCalls(); callbacks with non-current signatures: afterDonate, afterSwap, beforeDonate, beforeSwap; inherits BaseHook without any current-ABI callback). hookrisk's detectors did not analyse this contract, so every code-derived dimension is unmeasured — a zero-finding scan here is not a clean result. Port it to the current IHooks interface and rescan.

Reported by: `hookrisk/hookrisk-unsupported-abi`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | skipped | TakeProfitsHook's constructor takes 2 argument(s) (address _poolManager, string _uri) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I2 No undeclared extraction | skipped | TakeProfitsHook's constructor takes 2 argument(s) (address _poolManager, string _uri) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I3 Exit liveness | skipped | TakeProfitsHook's constructor takes 2 argument(s) (address _poolManager, string _uri) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 1 |  |
| Differential harness (Foundry) | skipped | 0 | TakeProfitsHook's constructor takes 2 argument(s) (address _poolManager, string _uri) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

## Warnings

- 7 dimension(s) unmeasured: the tier is between Low Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'custom-math' could not be evaluated: dimension 'customMath' is unmeasured
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'price-impact' could not be evaluated: dimension 'priceImpactingBehavior' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
