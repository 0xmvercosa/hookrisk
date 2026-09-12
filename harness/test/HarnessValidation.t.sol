// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {TwinPools} from "./TwinPools.sol";
import {TwinHandler} from "./TwinHandler.sol";
import {RevertReason} from "./RevertReason.sol";
import {SkimmingFeeHook} from "../src/hooks/FeeHooks.sol";
import {TrappingHook} from "../src/hooks/TrappingHook.sol";
import {DynamicFeeHook, LineCurveHook, ConfiguredHook} from "../src/hooks/ShapeHooks.sol";

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
        _stand(HookSpec({artifact: artifact, flags: flags, runtimeCode: "", constructorArgs: "", customCurve: false}));
    }

    function _stand(HookSpec memory spec) internal {
        _setUpTwinPools(spec);
        _seedTwins();
        handler = new TwinHandler(manager, swapRouter, modifyLiquidityRouter, donateRouter, vanillaKey, hookedKey);
        _fund(address(handler), 1e27);
    }

    /// @dev `_setUpTwinPools` behind an external call, so a test can
    /// `vm.expectRevert` on it. The loud-failure tests below need exactly
    /// this: a harness that cannot stand a hook up must say so, not skip.
    function standExternally(HookSpec memory spec) external {
        require(msg.sender == address(this), "test-only");
        _setUpTwinPools(spec);
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
        _stand("TrappingHook.sol:TrappingHook", uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
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

        // A mid-sequence exit attempt must be recorded too, and survive the
        // state rollback that keeps the twins aligned. Before the fix the
        // write happened before `revertToState` and was undone with it, so
        // only the sweep ever noticed.
        handler.removeLiquidity(1); // index 1: the re-entered position; 0 is the one already closed
        assertTrue(handler.exitReverted(), "mid-sequence exit failure must be recorded");
        assertEq(handler.exitFailures(), 1, "one failed exit so far");
        assertEq(handler.openPositionCount(), 1, "the position must still be open: the rollback kept the twins aligned");

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

// --------------------------------------------------------------------------- //
// Real-world hook shapes — the harness must stand them up, and say what it did
// --------------------------------------------------------------------------- //

/// @notice Every OpenZeppelin BaseDynamicFee descendant reverts on a static
/// fee. The harness must retry with the dynamic-fee flag, record that it did,
/// and I2 must still be meaningful on the result.
contract DynamicFeeHookStandsUp is ValidationBase {
    using StateLibrary for IPoolManager;

    function setUp() public {
        _stand("ShapeHooks.sol:DynamicFeeHook", uint160(Hooks.AFTER_INITIALIZE_FLAG));
    }

    function test_hookedPoolFellBackToADynamicFee() public view {
        assertTrue(run.dynamicFee, "run record must say the dynamic-fee retry was taken");
        assertEq(hookedKey.fee, LPFeeLibrary.DYNAMIC_FEE_FLAG, "hooked pool should carry the dynamic fee flag");
        assertEq(vanillaKey.fee, POOL_FEE, "vanilla pool must keep the static fee; v4 forbids dynamic without a hook");
        assertTrue(run.hookedSeeded, "seed must succeed on a dynamic-fee pool");

        (,,, uint24 lpFee) = manager.getSlot0(hookedId);
        assertEq(
            lpFee, DynamicFeeHook(payable(address(hook))).FEE(), "the hook's afterInitialize should have set the fee"
        );
    }

    /// @notice The hook's fee is lower than the vanilla pool's, so the hooked
    /// pool pays out *more*. I2 measures shortfall only; there must be none.
    function test_I2_seesNoShortfallFromACheaperFee() public {
        for (uint256 i = 0; i < 8; i++) {
            handler.swapExactIn(1e14 + i * 1e13, i % 2 == 0);
        }
        assertGt(handler.swapsCompared(), 0, "no swaps were comparable; the fixture is broken");
        assertFalse(handler.hookedSwapReverted(), "swaps must run on the dynamic-fee pool");
        assertEq(handler.worstShortfallBips(), 0, "a cheaper pool cannot fall short of the vanilla one");
    }

    function test_runFileRecordsTheDynamicFee() public {
        string memory path = "out/hookrisk-run-validation-dynamic-fee.json";
        _writeRunFile("validation-dynamic-fee");
        assertEq(
            vm.readFile(path),
            '{"flags":4096,"customCurve":false,"dynamicFee":true,"permissionsDerived":false,"seeded":"both","hookedSeedRevert":""}'
        );
        vm.removeFile(path);
    }

    /// @notice An empty run id means "do not write"; the CLI's absence of a
    /// file must then mean the CLI did not ask, not that the harness forgot.
    function test_runFileIsSkippedWithoutARunId() public {
        _writeRunFile("");
        assertFalse(vm.exists("out/hookrisk-run-.json"), "no file may be written for an empty run id");
    }
}

/// @notice A custom-curve hook that keeps its own reserves rejects the seed
/// position. The run must survive that, swaps must still execute through the
/// hook, and the monotonicity check must still run against them.
contract LineCurveHookStandsUp is ValidationBase {
    function setUp() public {
        _stand(
            "ShapeHooks.sol:LineCurveHook",
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );
        // Reserves for the hook to price against. This is the hook's own
        // liquidity path, which the harness cannot drive generically; the
        // fixture test supplies it so the swap path itself can be exercised.
        _fund(address(hook), 1e24);
    }

    function test_seedFailureIsRecordedNotFatal() public view {
        assertFalse(run.hookedSeeded, "the hook refuses PoolManager liquidity; the record must say so");
        assertEq(
            bytes4(run.hookedSeedRevert),
            LineCurveHook.LiquidityGoesThroughTheHook.selector,
            "the recorded revert must be the hook's own, not v4's wrapper"
        );
        assertEq(handler.positionCount(), 0, "no position may be fabricated for the hooked pool");
    }

    function test_swapsStillRunAndMonotonicityIsChecked() public {
        for (uint256 i = 0; i < 8; i++) {
            handler.swapExactIn(1e14 + i * 1e13, i % 2 == 0);
        }
        assertGt(handler.swapsExecuted(), 0, "no swaps executed; the fixture is broken");
        assertFalse(handler.hookedSwapReverted(), "the hook must price the swap without any v4 liquidity");
        assertGt(handler.priceChecks(), 0, "I2b must have observed the hooked pool's price");
        assertEq(handler.monotonicityViolations(), 0, "a 1:1 line moves the price nowhere; no violation");
        // The line pays out one for one while the vanilla pool charges 30 bips
        // and slips, so the hooked side is strictly better: no shortfall.
        assertGt(handler.cumulativeHookedOut(), handler.cumulativeVanillaOut(), "the hook should have priced the trade");
    }

    function test_runFileRecordsTheSeedFailure() public {
        string memory path = "out/hookrisk-run-validation-line-curve.json";
        _writeRunFile("validation-line-curve");
        assertEq(
            vm.readFile(path),
            string.concat(
                '{"flags":2184,"customCurve":false,"dynamicFee":false,"permissionsDerived":false,',
                '"seeded":"hooked-failed","hookedSeedRevert":"',
                vm.toString(abi.encodeWithSelector(LineCurveHook.LiquidityGoesThroughTheHook.selector)),
                '"}'
            )
        );
        vm.removeFile(path);
    }
}

/// @notice A hook with `(IPoolManager, address owner, uint256 x)` is deployable
/// only through sentinel replacement, and each sentinel must land on the right
/// value.
contract ConfiguredHookStandsUp is ValidationBase {
    uint160 internal constant FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG);

    function _spec(bytes memory constructorArgs) internal pure returns (HookSpec memory) {
        return HookSpec({
            artifact: "ShapeHooks.sol:ConfiguredHook",
            flags: FLAGS,
            runtimeCode: "",
            constructorArgs: constructorArgs,
            customCurve: false
        });
    }

    function test_sentinelsResolveToManagerAndOwner() public {
        _stand(_spec(abi.encode(SENTINEL_MANAGER, SENTINEL_OWNER, uint256(42))));
        ConfiguredHook deployed = ConfiguredHook(payable(address(hook)));
        assertEq(address(deployed.poolManager()), address(manager), "manager sentinel must become the PoolManager");
        assertEq(deployed.owner(), address(this), "owner sentinel must become the test contract");
        assertEq(deployed.x(), 42, "a plain word must pass through untouched");

        handler.swapExactIn(1e14, true);
        assertFalse(handler.hookedSwapReverted(), "the deployed hook must be usable");
    }

    /// @notice Replacement is by word, whatever the ABI type: a sentinel in a
    /// `uint256` slot is replaced too, which is what lets the harness work
    /// without knowing the constructor's signature.
    function test_currencyAndHookSentinelsResolveInAnySlot() public {
        _stand(_spec(abi.encode(SENTINEL_MANAGER, SENTINEL_CURRENCY1, uint256(uint160(SENTINEL_HOOK)))));
        ConfiguredHook deployed = ConfiguredHook(payable(address(hook)));
        assertEq(deployed.owner(), Currency.unwrap(currency1), "currency1 sentinel must become currency1");
        assertEq(deployed.x(), uint256(uint160(address(hook))), "hook sentinel must become the flag-bearing address");
        assertEq(address(hook), address(HOOK_NAMESPACE | FLAGS), "the flag-bearing address is the deployment target");
    }

    /// @notice Without arguments the legacy `abi.encode(manager)` is appended,
    /// the three-argument constructor runs out of calldata, and the harness
    /// must fail with a message that says the constructor reverted — not skip,
    /// not report an empty run.
    function test_legacyArgumentsFailLoudlyOnAWiderConstructor() public {
        vm.expectRevert(bytes("TwinPools: hook constructor reverted: 0x"));
        this.standExternally(_spec(""));
    }

    function test_misalignedArgumentsFailLoudly() public {
        vm.expectRevert(bytes("TwinPools: HOOKRISK_CONSTRUCTOR_ARGS is not a whole number of ABI words"));
        this.standExternally(_spec(hex"c0ffee"));
    }

    /// @notice The revert message carries the hook's own error, unwrapped, so
    /// a user can tell a wrong flag word from a wrong argument.
    function test_constructorRevertNamesTheCause() public {
        HookSpec memory spec = _spec(abi.encode(SENTINEL_MANAGER, SENTINEL_OWNER, uint256(1)));
        spec.flags = uint160(Hooks.AFTER_SWAP_FLAG); // not what the hook declares; BaseHook rejects it
        address wrongTarget = address(HOOK_NAMESPACE | spec.flags);
        vm.expectRevert(
            bytes(
                string.concat(
                    "TwinPools: hook constructor reverted: ",
                    vm.toString(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrongTarget))
                )
            )
        );
        this.standExternally(spec);
    }
}

/// @notice `getHookPermissions` is inherited, so nothing in the scanned file
/// declares flags. With `flags == 0` and the runtime code the harness must ask
/// the code and arrive at the base contract's word.
contract InheritedPermissionsHookStandsUp is ValidationBase {
    uint160 internal constant EXPECTED = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function _spec(bytes memory runtimeCode) internal pure returns (HookSpec memory) {
        return HookSpec({
            artifact: "ShapeHooks.sol:InheritedPermissionsHook",
            flags: 0,
            runtimeCode: runtimeCode,
            constructorArgs: "",
            customCurve: false
        });
    }

    function test_flagsAreDerivedFromTheRuntimeCode() public {
        _stand(_spec(vm.getDeployedCode("ShapeHooks.sol:InheritedPermissionsHook")));
        assertTrue(run.permissionsDerived, "the run record must say the flags were derived");
        assertEq(run.flags, EXPECTED, "derived flags must equal the inherited permission word");
        assertEq(address(hook), address(HOOK_NAMESPACE | EXPECTED), "the hook must sit at the derived address");
        assertFalse(run.customCurve, "afterSwapReturnDelta is not a custom curve");
        assertEq(PERMISSIONS_SCRATCH.code.length, 0, "the scratch address must be cleared after derivation");

        handler.swapExactIn(1e14, true);
        assertFalse(handler.hookedSwapReverted(), "the derived deployment must be usable");
        assertEq(handler.worstShortfallBips(), 0, "a zero-fee hook has no shortfall");
    }

    /// @notice The CLI's static guess of customCurve loses to the code's own
    /// answer. Sent as `customCurve: true` for a hook that is not one, the
    /// harness must correct it — otherwise I2 would be silently skipped.
    function test_derivedPermissionsOverrideTheCustomCurveHint() public {
        HookSpec memory spec = _spec(vm.getDeployedCode("ShapeHooks.sol:InheritedPermissionsHook"));
        spec.customCurve = true;
        _stand(spec);
        assertFalse(run.customCurve, "the hook's own permissions must override the CLI hint");

        HookSpec memory curve = HookSpec({
            artifact: "ShapeHooks.sol:LineCurveHook",
            flags: 0,
            runtimeCode: vm.getDeployedCode("ShapeHooks.sol:LineCurveHook"),
            constructorArgs: "",
            customCurve: false
        });
        _setUpTwinPools(curve);
        assertTrue(run.customCurve, "beforeSwapReturnDelta must be recognised as a custom curve");
        assertEq(
            run.flags,
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );
    }

    function test_runFileRecordsDerivedFlags() public {
        _stand(_spec(vm.getDeployedCode("ShapeHooks.sol:InheritedPermissionsHook")));
        string memory path = "out/hookrisk-run-validation-derived.json";
        _writeRunFile("validation-derived");
        assertEq(
            vm.readFile(path),
            '{"flags":68,"customCurve":false,"dynamicFee":false,"permissionsDerived":true,"seeded":"both","hookedSeedRevert":""}'
        );
        vm.removeFile(path);
    }

    function test_noRuntimeCodeFailsLoudly() public {
        vm.expectRevert(
            bytes(
                "TwinPools: HOOKRISK_FLAGS is 0 and HOOKRISK_RUNTIME_CODE is empty; nothing to derive permissions from"
            )
        );
        this.standExternally(_spec(""));
    }

    /// @notice Runtime code without `getHookPermissions()` — a 2023-ABI hook,
    /// or simply the wrong artifact — must be named as such rather than
    /// deployed at address 0x4444…0000 and left to confuse the PoolManager.
    function test_foreignAbiFailsLoudly() public {
        bytes memory notAHook = vm.getDeployedCode("MockERC20.sol:MockERC20");
        try this.standExternally(_spec(notAHook)) {
            fail("deriving permissions from a non-hook must revert");
        } catch Error(string memory reason) {
            assertTrue(
                vm.contains(reason, "getHookPermissions() reverted on the supplied runtime code"),
                string.concat("unexpected reason: ", reason)
            );
        }
        assertEq(PERMISSIONS_SCRATCH.code.length, 0, "the scratch address must be cleared even on failure");
    }
}

// --------------------------------------------------------------------------- //
// Observation log — what a sequence actually exercised, for the CLI to weigh
// --------------------------------------------------------------------------- //

/// @notice An invariant that held over a sequence in which nothing happened
/// has held vacuously. The handler's counters are the only evidence of what
/// happened, and `afterInvariant` appends them as one JSON line per sequence.
/// These tests pin the line's exact content on a busy sequence and on the
/// idle-pool shape that used to read as three passes.
contract ObservationLogIsWritten is ValidationBase {
    function setUp() public {
        _stand("FeeHooks.sol:HonestFeeHook", uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
    }

    /// @dev Three landed swaps, one position opened and closed, one donation.
    function _busySequence() internal {
        for (uint256 i = 0; i < 3; i++) {
            handler.swapExactIn(1e14 + i * 1e13, i % 2 == 0);
        }
        handler.addLiquidity(1e17, 12345);
        handler.removeLiquidity(0);
        handler.donate(1e12, 1e12);
        assertEq(handler.sweepExits(), 0, "nothing should be left to sweep");
    }

    function test_observationJsonCountsWhatLanded() public {
        _busySequence();
        assertEq(
            handler.observationJson(),
            '{"swapsExecuted":3,"swapsCompared":3,"swapsSkipped":0,"hookedSwapReverted":false,"positionsOpened":1,'
            '"positionsClosed":1,"donations":1,"priceChecks":3,"monotonicityViolations":0,"exitFailures":0}'
        );
        assertEq(handler.swapsAttempted(), 3, "every attempt landed on this hook");
    }

    /// @notice Each call appends one line and its newline in a single write,
    /// so two sequences yield two intact objects separated by padding.
    function test_linesAreAppendedPerSequence() public {
        string memory path = "out/hookrisk-obs-validation-log.jsonl";
        if (vm.exists(path)) vm.removeFile(path);

        _busySequence();
        string memory json = handler.observationJson();
        _writeObservationLine("validation-log", json);
        _writeObservationLine("validation-log", json);

        assertEq(vm.readFile(path), string.concat(json, "\n\n", json, "\n\n"));
        vm.removeFile(path);
    }

    function test_nothingIsWrittenWithoutARunId() public {
        _writeObservationLine("", handler.observationJson());
        assertFalse(vm.exists("out/hookrisk-obs-.jsonl"), "no file may be written for an empty run id");
    }
}

/// @notice The shape that motivated the log: a custom-curve hook that refuses
/// PoolManager liquidity and, with no reserves of its own, reverts every swap.
/// Every invariant "holds" over such a sequence because nothing was exercised,
/// and the line must say exactly that — zeros everywhere that matters.
contract IdlePoolIsObservedAsIdle is ValidationBase {
    function setUp() public {
        _stand(
            "ShapeHooks.sol:LineCurveHook",
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );
        // Deliberately no `_fund(address(hook), …)`: the fixture in
        // LineCurveHookStandsUp supplies reserves so the swap path can be
        // exercised; this one models the CLI's generic run, which cannot.
    }

    function test_idleSequenceLeavesEveryCounterAtZero() public {
        assertFalse(run.hookedSeeded, "the hook refuses PoolManager liquidity");
        for (uint256 i = 0; i < 4; i++) {
            handler.swapExactIn(1e14, i % 2 == 0);
        }
        handler.addLiquidity(1e17, 12345);
        handler.sweepExits();

        assertEq(handler.swapsAttempted(), 4, "the fuzzer did try");
        assertTrue(handler.hookedSwapReverted(), "the hook has no reserves, so every hooked swap reverts");
        assertEq(
            handler.observationJson(),
            '{"swapsExecuted":0,"swapsCompared":0,"swapsSkipped":0,"hookedSwapReverted":true,"positionsOpened":0,'
            '"positionsClosed":0,"donations":0,"priceChecks":0,"monotonicityViolations":0,"exitFailures":0}'
        );
    }
}

// --------------------------------------------------------------------------- //
// Revert unwrapping — the diagnostic the seed and exit paths both rely on
// --------------------------------------------------------------------------- //

contract RevertReasonUnwraps is Test {
    error Inner(uint256 code);

    function test_peelsNestedWrappers() public pure {
        bytes memory inner = abi.encodeWithSelector(Inner.selector, 7);
        bytes memory once =
            abi.encodeWithSelector(RevertReason.WRAPPED_ERROR, address(0xBEEF), bytes4(0x21d0ee70), inner, bytes(""));
        bytes memory twice =
            abi.encodeWithSelector(RevertReason.WRAPPED_ERROR, address(0xCAFE), bytes4(0x575e24b4), once, bytes(""));
        assertEq(RevertReason.rootCause(twice), inner, "two wrappers must peel down to the hook's error");
        assertEq(RevertReason.rootCause(inner), inner, "an unwrapped error is returned as-is");
    }

    /// @notice A wrapper around nothing, or truncated bytes, is returned rather
    /// than turned into a revert of the diagnostic itself.
    function test_malformedChainsAreReturnedAsIs() public pure {
        bytes memory emptyReason =
            abi.encodeWithSelector(RevertReason.WRAPPED_ERROR, address(0), bytes4(0), bytes(""), bytes(""));
        assertEq(RevertReason.rootCause(emptyReason), emptyReason);

        bytes memory truncated = new bytes(40);
        truncated[0] = 0x90;
        truncated[1] = 0xbf;
        truncated[2] = 0xb8;
        truncated[3] = 0x65;
        assertEq(RevertReason.rootCause(truncated), truncated);

        bytes memory badOffset =
            abi.encodeWithSelector(RevertReason.WRAPPED_ERROR, address(0), bytes4(0), bytes("x"), bytes(""));
        // Point the reason offset past the end of the payload.
        assembly ("memory-safe") {
            mstore(add(badOffset, add(0x20, 68)), 0xffff)
        }
        assertEq(RevertReason.rootCause(badOffset), badOffset);
    }
}
