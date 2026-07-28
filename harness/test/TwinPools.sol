// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @title Twin-pool test fixture: one pool with the hook, one without
/// @notice The differential method in one sentence: build two pools that are
/// identical in every field except `hooks`, drive both with the same actions,
/// and treat any divergence the hook does not declare as a finding.
///
/// This is what distinguishes the dynamic layer from static analysis. A static
/// analyzer can tell you a hook takes a fee. Only execution can tell you the fee
/// it takes is larger than the fee it documents, because that difference lives
/// in arithmetic, not in structure.
///
/// Everything here is built from v4-core's own test utilities — `Deployers`,
/// `PoolSwapTest`, `PoolModifyLiquidityTest`. There are no mocks of Uniswap
/// components. A mocked PoolManager would let the harness agree with a
/// misunderstanding of v4 rather than with v4.
abstract contract TwinPools is Test, Deployers {
    /// @dev Namespace for mined hook addresses. Any high bits work; these keep
    /// the address visually distinct from token and router addresses in traces.
    uint160 internal constant HOOK_NAMESPACE = uint160(0x4444) << 144;

    /// @dev Both pools use the same fee tier and spacing so that the only
    /// difference between them is the hook itself.
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    IHooks internal hook;
    PoolKey internal vanillaKey;
    PoolKey internal hookedKey;
    PoolId internal vanillaId;
    PoolId internal hookedId;

    /// @notice Deploy a hook at an address whose low 14 bits carry `flags`.
    ///
    /// v4 reads permissions from the address, so a hook must live at an address
    /// with the right bit pattern. In production that means grinding a CREATE2
    /// salt, which is slow and irrelevant to what we are testing. `deployCodeTo`
    /// writes the runtime code straight to a chosen address, which is the
    /// standard approach in v4's own test suite.
    ///
    /// @param artifact Foundry artifact path, e.g. `FeeHooks.sol:HonestFeeHook`.
    /// @param flags OR of the `Hooks.*_FLAG` constants the hook declares.
    function _deployHook(string memory artifact, uint160 flags) internal returns (IHooks) {
        address target = address(HOOK_NAMESPACE | flags);

        // Same procedure as forge-std's `deployCodeTo`: etch the creation code
        // at the target, call it to run the constructor, then etch the runtime
        // code it returned. Inlined rather than delegated because the creation
        // code may come from outside this project — see `_creationCode`.
        bytes memory creationCode = _creationCode(artifact);
        vm.etch(target, abi.encodePacked(creationCode, abi.encode(manager)));
        (bool ok, bytes memory runtime) = target.call("");
        require(ok, "TwinPools: hook constructor reverted");
        vm.etch(target, runtime);

        // Catch a flags/permissions mismatch here rather than as a confusing
        // revert several hundred fuzz calls later. This is the same check the
        // PoolManager applies at pool initialisation.
        require(
            Hooks.isValidHookAddress(IHooks(target), POOL_FEE),
            "TwinPools: flags do not form a valid hook address"
        );
        return IHooks(target);
    }

    /// @notice Stand up the PoolManager, currencies, routers and both pools.
    /// @param artifact Foundry artifact path of the hook under test.
    /// @param flags Permission flags the hook declares.
    function _setUpTwinPools(string memory artifact, uint160 flags) internal {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        hook = _deployHook(artifact, flags);

        // Same currencies, same fee, same spacing, same starting price.
        (vanillaKey, vanillaId) =
            initPool(currency0, currency1, IHooks(address(0)), POOL_FEE, TICK_SPACING, SQRT_PRICE_1_1);
        (hookedKey, hookedId) = initPool(currency0, currency1, hook, POOL_FEE, TICK_SPACING, SQRT_PRICE_1_1);
    }

    /// @notice Creation bytecode of the hook under test.
    ///
    /// Two sources, in order of precedence:
    ///
    /// 1. `HOOKRISK_CREATION_CODE`, set by the CLI when scanning someone else's
    ///    hook. Passing the bytes directly is what makes that possible at all:
    ///    `vm.getCode` resolves names against *this* project's compilation
    ///    index, so an artifact merely copied into `out/` is invisible to it and
    ///    fails with `no matching artifact found` — a message that suggests a
    ///    missing file when the file is right there.
    ///
    /// 2. `vm.getCode(artifact)`, for the fixtures that live in this repository
    ///    and are compiled alongside the harness.
    ///
    /// Deliberately no fallback between them: if the CLI sets the variable and
    /// the bytes are wrong, the constructor reverts loudly rather than quietly
    /// testing whichever local contract happens to share the name.
    function _creationCode(string memory artifact) internal view returns (bytes memory) {
        bytes memory supplied = vm.envOr("HOOKRISK_CREATION_CODE", bytes(""));
        if (supplied.length > 0) return supplied;
        return vm.getCode(artifact);
    }

    /// @notice Mint both currencies to `who`.
    /// @dev Minting only. The handler approves the routers from its own
    /// constructor, so no pranking is needed anywhere in the harness — see the
    /// note in TwinHandler about why a dangling `startPrank` is worth designing
    /// out rather than working around.
    function _fund(address who, uint256 amount) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, amount);
        MockERC20(Currency.unwrap(currency1)).mint(who, amount);
    }
}
