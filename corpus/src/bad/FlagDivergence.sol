// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ---------------------------------------------------------------------------
// HS-02 true-positive fixture — declared permissions vs implemented callbacks
//
// Built on OpenZeppelin's BaseHook because that is the canonical base class and
// because its delegate-to-internal pattern is what makes this bug class easy to
// ship: every external callback exists on every BaseHook descendant, so "does
// the contract have a beforeSwap" is always yes and tells you nothing.
//
// Three divergences, deliberately:
//
//   1. `beforeSwap: true` declared, `_beforeSwap` never overridden.
//      BaseHook's default reverts with HookNotImplemented(), so every swap on a
//      pool using this hook reverts. Liveness failure.
//
//   2. `_afterSwap` overridden with real fee accounting, `afterSwap: false`.
//      Unless the deployed address happens to carry AFTER_SWAP_FLAG (bit 6),
//      the PoolManager never calls it. The fee logic is dead code — the salt
//      grinding pitfall the framework describes in §1.11.
//
//   3. `beforeSwapReturnDelta: true` while `beforeSwap` would need to be too.
//      Covered by the second contract below, since it must not be masked by (1).
//
// Detector expectation:
//   HS-02 reports (1) and (2) on DivergentHook.
//   HS-02 reports the orphan returns-delta permission on OrphanDeltaHook.
//   HS-07 classifies OrphanDeltaHook as using custom accounting.
// ---------------------------------------------------------------------------

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

contract DivergentHook is BaseHook {
    mapping(PoolId => uint256) public feesCollected;

    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            // (1) Declared, never implemented. Every swap reverts.
            beforeSwap: true,
            // (2) Not declared, but implemented below. Never runs.
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // (2) Real work, unreachable: `afterSwap` is declared false.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        feesCollected[key.toId()] += 1;
        return (IHooks.afterSwap.selector, int128(0));
    }
}

contract OrphanDeltaHook is BaseHook {
    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {}

    // (3) `beforeSwapReturnDelta` without `beforeSwap`.
    // Hooks.isValidHookAddress rejects this outright: no address carrying these
    // bits can initialize a pool, so the hook is undeployable in practice.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
