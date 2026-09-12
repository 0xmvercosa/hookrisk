# Hook Risk Report

**MEDIUM risk** — 14/33 against the [Uniswap Hooks Security Framework](https://github.com/uniswapfoundation/security-framework).

> **Tier is undetermined.** 14/33 from what could be measured, up to 26/33 if every unmeasured dimension were at its maximum — between medium and high. Unmeasured dimensions are excluded from the total, never counted as zero.

❌ **Gate failed.**
- 3 finding(s) at or above high: CorkHook.beforeInitialize(address,PoolKey,uint160) (src/CorkHook.sol#97-124) is an IHooks callback (0xdc98354e) that never compares msg.sender against …; CorkHook.beforeSwap(address,PoolKey,IPoolManager.SwapParams,bytes) (src/CorkHook.sol#365-378) is an IHooks callback (0x575e24b4) that never compares …; CorkHook (src/CorkHook.sol#31-734) declares permission `beforeRemoveLiquidity` (bit 9, BEFORE_REMOVE_LIQUIDITY_FLAG) but provides no working …

## What was assessed

| | |
| --- | --- |
| Contract | `CorkHook` |
| Source | `src/CorkHook.sol` |
| Mode | source |

### Hook profile

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

Complexity is derived from these metrics; the rule that fired is in the score table’s evidence.

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

### 🟠 CorkHook.beforeInitialize(address,PoolKey,uint160) (src/CorkHook.sol#97-124) is an IHooks callback (0xdc98354e) that never compares msg.sender against …

`unprotected-hook-callback` (`beforeInitialize`) · **high** · confidence **high**

`src/CorkHook.sol:97`

CorkHook.beforeInitialize(address,PoolKey,uint160) (src/CorkHook.sol#97-124) is an IHooks callback (0xdc98354e) that never compares msg.sender against poolManager. Anyone can call it with an arbitrary PoolKey and arbitrary hookData.

Reported by: `hookrisk/hookrisk-unprotected-callback`

### 🟠 CorkHook.beforeSwap(address,PoolKey,IPoolManager.SwapParams,bytes) (src/CorkHook.sol#365-378) is an IHooks callback (0x575e24b4) that never compares …

`unprotected-hook-callback` (`beforeSwap`) · **high** · confidence **high**

`src/CorkHook.sol:365`

CorkHook.beforeSwap(address,PoolKey,IPoolManager.SwapParams,bytes) (src/CorkHook.sol#365-378) is an IHooks callback (0x575e24b4) that never compares msg.sender against poolManager. Anyone can call it with an arbitrary PoolKey and arbitrary hookData.

Reported by: `hookrisk/hookrisk-unprotected-callback`

### 🟠 CorkHook (src/CorkHook.sol#31-734) declares permission `beforeRemoveLiquidity` (bit 9, BEFORE_REMOVE_LIQUIDITY_FLAG) but provides no working …

`flag-implementation-divergence` (`beforeRemoveLiquidity`) · **high** · confidence **medium**

`src/CorkHook.sol:31`

CorkHook (src/CorkHook.sol#31-734) declares permission `beforeRemoveLiquidity` (bit 9, BEFORE_REMOVE_LIQUIDITY_FLAG) but provides no working `beforeRemoveLiquidity` implementation. The PoolManager will call it on every matching pool operation and the call will revert, making the pool unusable for that operation.

Reported by: `hookrisk/hookrisk-flag-divergence`

### ℹ️ CorkHook (src/CorkHook.sol#31-734) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3)

`custom-accounting` · **info** · confidence **high**

`src/CorkHook.sol:31`

CorkHook (src/CorkHook.sol#31-734) declares custom-accounting permissions: `beforeSwapReturnDelta` (bit 3). The hook can alter settled amounts, which raises its risk tier under the framework's custom-math and price-impact triggers and means differential output comparison (invariant I2) does not apply — the harness substitutes price monotonicity.

Reported by: `hookrisk/hookrisk-custom-accounting`

### ℹ️ CorkHook.beforeAddLiquidity(address,PoolKey,IPoolManager.ModifyLiquidityParams,bytes) (src/CorkHook.sol#88-95) overrides `beforeAddLiquidity` with `revert …

`callback-intentionally-disabled` (`beforeAddLiquidity`) · **info** · confidence **high**

`src/CorkHook.sol:88`

CorkHook.beforeAddLiquidity(address,PoolKey,IPoolManager.ModifyLiquidityParams,bytes) (src/CorkHook.sol#88-95) overrides `beforeAddLiquidity` with `revert DisableNativeLiquidityModification()`, so PoolManager-routed liquidity addition is disabled by design; the differential harness records such reverts when it runs. This is not the missing implementation HS-02 reports.

Reported by: `hookrisk/hookrisk-disabled-callback`

## Invariants

| | Invariant | Result | Detail |
| --- | --- | --- | --- |
| ⚠️ | I1 Conservation and solvency | skipped | CorkHook's constructor takes 3 argument(s) (address _poolManager, address _lpBase, address owner) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I2 No undeclared extraction | skipped | CorkHook's constructor takes 3 argument(s) (address _poolManager, address _lpBase, address owner) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |
| ⚠️ | I3 Exit liveness | skipped | CorkHook's constructor takes 3 argument(s) (address _poolManager, address _lpBase, address owner) and the harness can only derive the IPoolManager on its own. Add [harness] constructorArgs to hookrisk.toml with one value per argument — $poolManager, $currency0, $currency1, $owner, $hook are substituted with the harness's own addresses, anything else is passed literally to `cast abi-encode`. See HR-E305. |

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
