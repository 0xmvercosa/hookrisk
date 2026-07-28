// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ---------------------------------------------------------------------------
// Negative corpus — every detector must stay silent on this file.
//
// This is the false-positive gate, and it is enforced in CI. A security tool is
// only as useful as its signal-to-noise ratio: a detector that flags correct
// code gets muted, and a muted detector protects nobody. So the corpus contains
// working hooks as well as broken ones, and a finding here fails the build just
// as loudly as a missed finding in corpus/src/bad/.
//
// `AntiSandwichHook` and `LiquidityPenaltyHook` are pulled in from OpenZeppelin's
// uniswap-hooks library on purpose. They are non-trivial, externally reviewed
// production hooks — exactly the kind of code a detector tuned on toy examples
// tends to flag. Compiling them into this unit means every hookrisk detector is
// run against them on every CI build.
//
// CleanHook itself is deliberately mundane: correctly guarded through BaseHook,
// permissions declared to match exactly what it implements, no admin surface, no
// external calls, no fee manipulation. Nothing to report.
// ---------------------------------------------------------------------------

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

// Compiled solely so the detectors run against real production hooks.
// solhint-disable-next-line no-unused-import
import {AntiSandwichHook} from "@openzeppelin/uniswap-hooks/src/general/AntiSandwichHook.sol";
// solhint-disable-next-line no-unused-import
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/src/general/LiquidityPenaltyHook.sol";

/// @title A minimal, correct v4 hook
/// @notice Counts swaps per pool. Observes only: no fees, no deltas, no admin.
contract CleanHook is BaseHook {
    mapping(PoolId => uint256) public swapCount;

    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {}

    /// @dev Declares exactly `beforeSwap` and `afterSwap`, which is exactly what
    /// is overridden below. No returns-delta permission: this hook cannot alter
    /// settled amounts, so HS-07 must not classify it as custom accounting.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @dev Reached only through BaseHook's `beforeSwap`, which applies
    /// `onlyPoolManager`. HS-01 must recognise the inherited guard.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        unchecked {
            swapCount[key.toId()] += 1;
        }
        return (IHooks.afterSwap.selector, int128(0));
    }
}
