// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {TwinPools} from "./TwinPools.sol";
import {TwinHandler} from "./TwinHandler.sol";
import {SkimmingFeeHook} from "../src/hooks/FeeHooks.sol";
import {TrappingHook} from "../src/hooks/TrappingHook.sol";

/// @title Tests that the tester works
/// @notice A harness reporting "no problems found" means nothing until you have
/// watched it report a problem it was supposed to find. These tests deploy hooks
/// with known, deliberate defects and assert that the invariant conditions are
/// *violated* — that I2 sees the undeclared skim and I3 sees the trapped exit.
///
/// They are deterministic rather than fuzzed on purpose. An invariant test that
/// is expected to fail cannot be expressed in a build that must pass, so the
/// same conditions are driven by a fixed sequence and asserted directly. The
/// consequence is that these run in a couple of seconds on every commit, and a
/// regression that blinds a detector fails CI immediately instead of surviving
/// until someone happens to run the fuzzer long enough.
///
/// If a test here starts passing in the wrong direction — no shortfall detected,
/// no exit failure — the harness has gone blind. That is a more dangerous
/// regression than a false positive, and it is the one this file exists to catch.
abstract contract ValidationBase is TwinPools {
    TwinHandler internal handler;

    function _stand(string memory artifact, uint160 flags) internal {
        _setUpTwinPools(artifact, flags);
        _seed(vanillaKey);
        _seed(hookedKey);
        handler = new TwinHandler(manager, swapRouter, modifyLiquidityRouter, donateRouter, vanillaKey, hookedKey);
        _fund(address(handler), 1e27);
    }

    function _seed(PoolKey memory key) internal {
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e21, salt: bytes32(0)}),
            ""
        );
    }
}

// --------------------------------------------------------------------------- //
// I2 — undeclared extraction
// --------------------------------------------------------------------------- //

contract SkimmingFeeHookIsCaught is ValidationBase {
    /// @dev What the hook's documentation and hookrisk.toml claim.
    uint256 internal constant DECLARED_FEE_BIPS = 100;

    /// @dev The bound invariant I2 actually asserts, declared fee plus the drift
    /// allowance. Mirrors HonestFeeHookInvariants so the two cannot drift apart.
    uint256 internal constant I2_BOUND_BIPS = 100 + 200;

    function setUp() public {
        _stand("FeeHooks.sol:SkimmingFeeHook", uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
    }

    /// @notice I2 must observe a shortfall larger than the declared fee allows.
    ///
    /// This is the defect static analysis cannot reach. The hook has no missing
    /// access check, no proxy, no external call — its structure is impeccable.
    /// It simply charges 350 basis points where it documents 100, and the only
    /// way to see that is to execute the same trade with and without it.
    function test_I2_detectsUndeclaredSkim() public {
        for (uint256 i = 0; i < 12; i++) {
            handler.swapExactIn(1e14 + i * 1e13, i % 2 == 0);
        }

        assertGt(handler.swapsCompared(), 0, "no swaps were comparable; the fixture is broken");

        uint256 observed = handler.worstShortfallBips();
        assertGt(observed, I2_BOUND_BIPS, "I2 failed to detect the undeclared skim");

        // The measured shortfall should land near the difference between what
        // the hook takes and what it declares. Asserting the magnitude, not just
        // the direction, is what proves the harness is measuring extraction
        // rather than picking up noise that happens to point the right way.
        uint256 undeclared = SkimmingFeeHook(payable(address(hook))).ACTUAL_FEE_BIPS()
            - SkimmingFeeHook(payable(address(hook))).DECLARED_FEE_BIPS();
        assertApproxEqAbs(
            observed,
            SkimmingFeeHook(payable(address(hook))).ACTUAL_FEE_BIPS(),
            50,
            "measured shortfall does not match the fee the hook actually charges"
        );
        assertGt(undeclared, 0, "fixture must charge more than it declares");
    }

    /// @notice The honest hook's fee is inside the bound; this one's is not.
    /// Guards against a bound so loose it would accept anything.
    function test_I2_boundWouldAcceptTheHonestFee() public pure {
        assertLe(DECLARED_FEE_BIPS, I2_BOUND_BIPS, "an honest hook must satisfy its own bound");
    }
}

// --------------------------------------------------------------------------- //
// I3 — exit liveness
// --------------------------------------------------------------------------- //

contract TrappingHookIsCaught is ValidationBase {
    function setUp() public {
        _stand(
            "TrappingHook.sol:TrappingHook",
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG)
        );
    }

    /// @notice I3 must observe that liquidity cannot be withdrawn.
    ///
    /// The sequence matters. Liquidity goes in, swaps happen, and only then does
    /// withdrawal start failing. Every accounting invariant still holds — nothing
    /// was stolen, the pool is solvent to the wei — while the provider's funds
    /// are unreachable. Solvency and liveness are different properties, and this
    /// is the one that usually goes untested.
    function test_I3_detectsTrappedLiquidity() public {
        handler.addLiquidity(1e17, 12345);
        assertEq(handler.openPositionCount(), 1, "position was not opened");

        // Below the trap threshold, withdrawal still works.
        handler.removeLiquidity(0);
        assertEq(handler.openPositionCount(), 0, "early withdrawal should succeed");
        assertFalse(handler.exitReverted(), "no failure should be recorded yet");

        // Re-enter, then cross the threshold.
        handler.addLiquidity(1e17, 12345);
        for (uint256 i = 0; i < TrappingHook(payable(address(hook))).TRAP_AFTER_SWAPS() + 2; i++) {
            handler.swapExactIn(1e13, i % 2 == 0);
        }

        uint256 failures = handler.sweepExits();

        assertGt(failures, 0, "I3 failed to detect that liquidity is trapped");
        assertTrue(handler.exitReverted(), "exit failure was not recorded");
        assertEq(
            bytes4(handler.exitRevertData()),
            TrappingHook.TemporarilyUnavailable.selector,
            "recorded revert data should identify the cause"
        );
    }

    /// @notice Solvency holds throughout. The point of I3 is that this is not
    /// enough: a pool can be perfectly solvent and still not let anyone out.
    function test_I3_trapIsInvisibleToConservation() public {
        uint256 supply0 = MockERC20(Currency.unwrap(currency0)).totalSupply();

        handler.addLiquidity(1e17, 999);
        for (uint256 i = 0; i < 10; i++) {
            handler.swapExactIn(1e13, i % 2 == 0);
        }
        handler.sweepExits();

        assertEq(
            MockERC20(Currency.unwrap(currency0)).totalSupply(),
            supply0,
            "conservation should still hold while funds are trapped"
        );
        assertTrue(handler.exitReverted(), "the trap must nonetheless have been detected by I3");
    }
}
