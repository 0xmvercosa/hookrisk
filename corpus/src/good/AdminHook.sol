// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ---------------------------------------------------------------------------
// Negative corpus — nothing severe; the hook-profile must report
// `hasOwnerOnlyFunctions: true` on both contracts.
//
// Two shapes of an admin surface, one per contract, because they look
// different in SlithIR:
//
//   OwnableAdminHook   OpenZeppelin `Ownable`: `onlyOwner` → `_checkOwner()` →
//                      `owner() != _msgSender()`. Both operands of the
//                      comparison are results of internal calls, so the
//                      comparing node reads neither `msg.sender` nor `_owner`
//                      directly. `guards_owner` resolves the operands to what
//                      their callees read.
//   HandRolledAdminHook `require(msg.sender == admin)` inline: the direct
//                      shape `guards_pool_manager` already recognises.
//
// Detector expectation:
//   HS-01, HS-02                silent (guarded through BaseHook, permissions
//                               match the one callback each implements)
//   hookrisk-hook-profile       one per contract, hasOwnerOnlyFunctions true
// ---------------------------------------------------------------------------

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title A hook whose fee is set by an OpenZeppelin `Ownable` owner
contract OwnableAdminHook is BaseHook, Ownable {
    uint24 public feeBips;

    constructor(IPoolManager _poolManager) BaseHook(_poolManager) Ownable(msg.sender) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @dev The admin surface: only the owner can move the fee.
    function setFee(uint24 newFee) external onlyOwner {
        feeBips = newFee;
    }

    function _afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        view
        override
        returns (bytes4, int128)
    {
        feeBips; // read only; the fixture needs a working delegate, not logic
        return (IHooks.afterSwap.selector, int128(0));
    }
}

/// @title A hook with a hand-rolled admin check
contract HandRolledAdminHook is BaseHook {
    address public admin;
    uint24 public feeBips;

    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {
        admin = msg.sender;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function setFee(uint24 newFee) external {
        require(msg.sender == admin, "not admin");
        feeBips = newFee;
    }

    function _afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        view
        override
        returns (bytes4, int128)
    {
        feeBips;
        return (IHooks.afterSwap.selector, int128(0));
    }
}
