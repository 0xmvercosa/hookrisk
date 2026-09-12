# Hook Risk Report — CorkHook

Executable assessment against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework): static detectors, a differential twin-pool harness, and the framework’s scoring rubric. Unmeasured dimensions are excluded from the total, never counted as zero.

## Summary

| | |
| --- | --- |
| Contract | `CorkHook` in `src/CorkHook.sol` |
| Compiler | solc 0.8.26 |
| Risk tier | **MEDIUM** 14/33, undetermined up to HIGH 26/33 |
| Gate | ❌ Failed (1 reason below) |
| Findings | 3 high · 2 classifications |
| Dimensions | 3 measured · 2 declared · 4 unmeasured |
| Static analysis | ok |
| Differential harness | skipped (HR-E305) |
| Invariants | ⏭️ I1 skipped · ⏭️ I2 skipped · ⏭️ I3 skipped |
| Tool | hookrisk 0.1.0, rubric e7e8da52fd5717b6eb4517ea779b766f63148c41 |

> **The tier is a range.** 14/33 is the sum of what could be measured or was declared; 4 dimensions have no detector or declaration. At their maximum the hook would score 26/33 (high). Declare them in `hookrisk.toml` to close the range.

### Why the gate failed

1. 3 finding(s) at or above high: CorkHook.beforeInitialize(address,PoolKey,uint160) (src/CorkHook.sol#97-124) is an IHooks callback (0xdc98354e) that never compares msg.sender against …; CorkHook.beforeSwap(address,PoolKey,IPoolManager.SwapParams,bytes) (src/CorkHook.sol#365-378) is an IHooks callback (0x575e24b4) that never compares …; CorkHook (src/CorkHook.sol#31-734) declares permission `beforeRemoveLiquidity` (bit 9, BEFORE_REMOVE_LIQUIDITY_FLAG) but provides no working …

## Findings

| # | Severity | Rule | Finding | Location | Confidence | Engines |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 🟠 High | HS-01 `unprotected-hook-callback` | `beforeInitialize` is callable by anyone, not only the PoolManager | `src/CorkHook.sol:97` | high | hookrisk |
| F2 | 🟠 High | HS-01 `unprotected-hook-callback` | `beforeSwap` is callable by anyone, not only the PoolManager | `src/CorkHook.sol:365` | high | hookrisk |
| F3 | 🟠 High | HS-02 `flag-implementation-divergence` | `beforeRemoveLiquidity` is declared but has no working implementation | `src/CorkHook.sol:31` | medium | hookrisk |

### F1 · 🟠 High · `beforeInitialize` is callable by anyone, not only the PoolManager

HS-01 `unprotected-hook-callback` · `src/CorkHook.sol:97` · confidence **high**

CorkHook.beforeInitialize(address,PoolKey,uint160) (src/CorkHook.sol#97-124) is an IHooks callback (0xdc98354e) that never compares msg.sender against poolManager. Anyone can call it with an arbitrary PoolKey and arbitrary hookData.

Reported by `hookrisk/hookrisk-unprotected-callback`.

### F2 · 🟠 High · `beforeSwap` is callable by anyone, not only the PoolManager

HS-01 `unprotected-hook-callback` · `src/CorkHook.sol:365` · confidence **high**

CorkHook.beforeSwap(address,PoolKey,IPoolManager.SwapParams,bytes) (src/CorkHook.sol#365-378) is an IHooks callback (0x575e24b4) that never compares msg.sender against poolManager. Anyone can call it with an arbitrary PoolKey and arbitrary hookData.

Reported by `hookrisk/hookrisk-unprotected-callback`.

### F3 · 🟠 High · `beforeRemoveLiquidity` is declared but has no working implementation

HS-02 `flag-implementation-divergence` · `src/CorkHook.sol:31` · confidence **medium**

CorkHook (src/CorkHook.sol#31-734) declares permission `beforeRemoveLiquidity` (bit 9, BEFORE_REMOVE_LIQUIDITY_FLAG) but provides no working `beforeRemoveLiquidity` implementation. The PoolManager will call it on every matching pool operation and the call will revert, making the pool unusable for that operation.

Reported by `hookrisk/hookrisk-flag-divergence`.

## Classifications

Properties of the hook that change how it is scored or tested. They are informational and never fail the gate.

| Rule | Classification | Applies to | Detail |
| --- | --- | --- | --- |
| HS-07 `custom-accounting` | Custom accounting: the hook can alter settled amounts | `src/CorkHook.sol:31` | CorkHook (src/CorkHook.sol#31-734) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3). |
| C-01 `callback-intentionally-disabled` | `beforeAddLiquidity` is disabled by design (deliberate revert) | `src/CorkHook.sol:88` (`beforeAddLiquidity`) | CorkHook.beforeAddLiquidity(address,PoolKey,IPoolManager.ModifyLiquidityParams,bytes) (src/CorkHook.sol#88-95) overrides `beforeAddLiquidity` with `revert DisableNativeLiquidityModification()`, so PoolManager-routed liquidity addition is disabled by design; the differential harness records such reverts when it runs. |

## Hook profile

The static engine’s structural measurement of the contract. Complexity is derived from these metrics; the rule that fired is quoted in the score table’s evidence.

| Metric | Value |
| --- | --- |
| Callbacks implemented (working; deliberate revert-guards are listed as disabled) | 2 |
| Callbacks declared | 4 |
| State writes in callbacks | 4 |
| External calls in the swap path | 5 |
| Internal functions reachable from callbacks | 19 |
| Returns a delta | true |
| Owner-only surface | true |
| Permissions declared | `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `beforeSwapReturnDelta` |

## Score

| Dimension | Score | Source | Bracket |
| --- | --- | --- | --- |
| Complexity | 5/5 | measured | Returns a delta, external call in the swap path, and an owner-only surface ᵃ |
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
  - hook-profile metrics: callbacksImplemented=2, callbacksDeclared=4, stateWritesInCallbacks=4, externalCallsInSwapPath=5, internalFunctionsReachableFromCallbacks=19, usesReturnsDelta=true, hasOwnerOnlyFunctions=true
  - Scored 5 by rule `usesReturnsDelta && externalCallsInSwapPath >= 1 && hasOwnerOnlyFunctions`: Custom settlement, a mid-swap dependency and a privileged surface together are every source of 'multi-step flows' and 'configuration patterns' the prose lists. (hookrisk’s interpretation; the framework publishes no brackets)
  - 1 flag-implementation-divergence finding(s)
  - 2 unprotected-hook-callback finding(s)
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

Differential twin-pool harness: **skipped** (HR-E305). CorkHook's constructor takes 3 argument(s) (address _poolManager, address _lpBase, address owner) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305.

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⏭️ | I1 Conservation and solvency | skipped | see the harness status above |
| ⏭️ | I2 No undeclared extraction | skipped | see the harness status above |
| ⏭️ | I3 Exit liveness | skipped | see the harness status above |

## Analysis coverage

| Engine | Status | Findings | Notes |
| --- | --- | --- | --- |
| hookrisk Slither detectors | ok | 6 |  |
| Differential harness (Foundry) | skipped (HR-E305) | 0 | CorkHook's constructor takes 3 argument(s) (address _poolManager, address _lpBase, address owner) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

## Warnings

- 4 dimension(s) unmeasured: the tier is between Medium Risk and High Risk. Unmeasured dimensions are excluded from the total, never counted as zero.
- trigger 'holds-liquidity' could not be evaluated: dimension 'externalLiquidityExposure' is unmeasured
- trigger 'external-dependencies' could not be evaluated: dimension 'externalDependencies' is unmeasured
- trigger 'autonomous' could not be evaluated: dimension 'autonomousParameterUpdates' is unmeasured
- trigger 'upgradeable' could not be evaluated: dimension 'upgradeability' is unmeasured

---

_Generated by [hookrisk](https://github.com/0xmvercosa/hookrisk). The Uniswap Foundation does not review, endorse or certify this report or any score derived from its framework._
