# Hook Risk Report — V2PairHook

Executable assessment against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework): static detectors, a differential twin-pool harness, and the framework’s scoring rubric. Unmeasured dimensions are excluded from the total, never counted as zero.

## Summary

| | |
| --- | --- |
| Contract | `V2PairHook` in `src/V2PairHook.sol` |
| Compiler | solc 0.8.24 |
| Risk tier | **MEDIUM** 13/33, undetermined up to HIGH 25/33 |
| Gate | ❌ Failed (2 reasons below) |
| Findings | 1 high · 2 classifications |
| Dimensions | 3 measured · 2 declared · 4 unmeasured |
| Static analysis | ok |
| Differential harness | failed (HR-E304) |
| Invariants | ⚠️ I1 inconclusive · ⚠️ I2 inconclusive · ⚠️ I3 inconclusive |
| Tool | hookrisk 0.1.0, rubric e7e8da52fd5717b6eb4517ea779b766f63148c41 |

> **The tier is a range.** 13/33 is the sum of what could be measured or was declared; 4 dimensions have no detector or declaration. At their maximum the hook would score 25/33 (high). Declare them in `hookrisk.toml` to close the range.

### Why the gate failed

1. the differential harness failed: harness setUp failed: TwinPools: hook constructor reverted: 0x. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304).
2. 1 finding(s) at or above high: V2PairHook.afterSwap(address,PoolKey,IPoolManager.SwapParams,BalanceDelta,bytes) (src/V2PairHook.sol#196-207) is an IHooks callback (0xb47b2fb1) that never …

## Findings

| # | Severity | Rule | Finding | Location | Confidence | Engines |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 🟠 High | HS-01 `unprotected-hook-callback` | `afterSwap` is callable by anyone, not only the PoolManager | `src/V2PairHook.sol:196` | high | hookrisk |

### F1 · 🟠 High · `afterSwap` is callable by anyone, not only the PoolManager

HS-01 `unprotected-hook-callback` · `src/V2PairHook.sol:196` · confidence **high**

V2PairHook.afterSwap(address,PoolKey,IPoolManager.SwapParams,BalanceDelta,bytes) (src/V2PairHook.sol#196-207) is an IHooks callback (0xb47b2fb1) that never compares msg.sender against poolManager. Anyone can call it with an arbitrary PoolKey and arbitrary hookData.

Reported by `hookrisk/hookrisk-unprotected-callback`.

## Classifications

Properties of the hook that change how it is scored or tested. They are informational and never fail the gate.

| Rule | Classification | Applies to | Detail |
| --- | --- | --- | --- |
| HS-07 `custom-accounting` | Custom accounting: the hook can alter settled amounts | `src/V2PairHook.sol:21` | V2PairHook (src/V2PairHook.sol#21-284) declares custom-accounting permissions: `afterSwapReturnDelta` (bit 2), `beforeSwapReturnDelta` (bit 3). |
| C-02 `unsupported-hook-abi` | Hook ABI predates the shipped v4 interface; not analysed | `src/V2PairHook.sol:21` (`partial`) | V2PairHook (src/V2PairHook.sol#21-284) implements afterAddLiquidity, afterInitialize, afterRemoveLiquidity, beforeAddLiquidity, beforeInitialize, beforeRemoveLiquidity with signatures that predate the shipped v4 interface. |

## Hook profile

The static engine’s structural measurement of the contract. Complexity is derived from these metrics; the rule that fired is quoted in the score table’s evidence.

| Metric | Value |
| --- | --- |
| Callbacks implemented (working; deliberate revert-guards are listed as disabled) | 2 |
| Callbacks declared | 4 |
| State writes in callbacks | 2 |
| External calls in the swap path | 4 |
| Internal functions reachable from callbacks | 4 |
| Returns a delta | true |
| Owner-only surface | false |
| Permissions declared | `beforeInitialize`, `beforeAddLiquidity`, `beforeSwap`, `afterSwap`, `beforeSwapReturnDelta`, `afterSwapReturnDelta` |

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

<details><summary>Evidence per dimension</summary>

- **Complexity**
  - hook-profile metrics: callbacksImplemented=2, callbacksDeclared=4, stateWritesInCallbacks=2, externalCallsInSwapPath=4, internalFunctionsReachableFromCallbacks=4, usesReturnsDelta=true, hasOwnerOnlyFunctions=false
  - Scored 4 by rule `usesReturnsDelta && externalCallsInSwapPath >= 1`: A hook that both alters settled amounts and leaves the swap path mid-flight has two interacting flows to reason about, not one. (hookrisk’s interpretation; the framework publishes no brackets)
  - 1 unprotected-hook-callback finding(s)
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

Differential twin-pool harness: **failed** (HR-E304). harness setUp failed: TwinPools: hook constructor reverted: 0x. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304).

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | inconclusive | see the harness status above |
| ⚠️ | I2 No undeclared extraction | inconclusive | see the harness status above |
| ⚠️ | I3 Exit liveness | inconclusive | see the harness status above |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 4 |  |
| Differential harness (Foundry) | failed (HR-E304) | 0 | harness setUp failed: TwinPools: hook constructor reverted: 0x. The twin pools could not be built, so no sequence ran and nothing about the hook was observed (HR-E304). |

## Warnings

- 4 dimension(s) unmeasured: the tier is between Medium Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
