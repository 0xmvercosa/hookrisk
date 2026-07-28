"""Shared analysis primitives for the hookrisk detectors.

Everything here answers one of three questions about a Slither `Contract`:

1. Is this a Uniswap v4 hook at all, and which callbacks does it implement?
2. Which state variable holds the `IPoolManager`, and is a given function
   gated on it?
3. What does the code do inside the swap path?

The recurring design decision is to key off *structure* rather than *names*.
A detector that looks for a modifier literally called `onlyPoolManager` works
until the library moves — and it already has: `BaseHook` used to ship in
v4-periphery and now lives in OpenZeppelin's `uniswap-hooks`, with a
different inheritance chain. Worse, a name-based check is trivially defeated by
a hook that declares `modifier onlyPoolManager { _; }` and does nothing, which is
exactly the shape a malicious hook would take. So the guard check traces an
actual comparison between `msg.sender` and the variable that received the pool
manager, wherever that comparison happens to live.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator

from slither.core.cfg.node import Node, NodeType
from slither.core.declarations import Contract, Function, Modifier
from slither.core.declarations.solidity_variables import SolidityVariableComposed
from slither.core.variables.state_variable import StateVariable
from slither.slithir.operations import (
    Binary,
    BinaryType,
    HighLevelCall,
    InternalCall,
    LibraryCall,
    LowLevelCall,
    SolidityCall,
    TypeConversion,
)

from .hooks_spec import (
    CALLBACK_SELECTORS,
    CALLBACK_SIGNATURES,
    CALLBACK_TO_FLAG,
    FLAG_BITS,
    RETURNS_DELTA_FLAGS,
    VALUE_TYPE_ALIASES,
)

__all__ = [
    "HookCallback",
    "normalize_signature",
    "always_reverts",
    "is_effectually_implemented",
    "implemented_callbacks",
    "is_hook_contract",
    "pool_manager_variables",
    "guards_pool_manager",
    "declared_permissions",
    "external_calls_in",
    "swap_path_functions",
    "reachable_functions",
]

#: Callback names whose bodies constitute "the swap path" for HS-05.
SWAP_PATH_CALLBACKS = frozenset({"beforeSwap", "afterSwap"})

#: Type names that plausibly denote the PoolManager reference.
_POOL_MANAGER_TYPES = frozenset({"IPoolManager", "PoolManager"})

#: Fallback names, used only when the type is a bare `address`. Name matching is
#: a last resort here precisely because it is weak; a hit only ever *adds* a
#: candidate variable, and a wrong candidate can at worst cause a false negative
#: in the guard check, never a false positive.
_POOL_MANAGER_NAMES = frozenset({"poolmanager", "manager", "pm", "_poolmanager"})


@dataclass(frozen=True)
class HookCallback:
    """One IHooks callback implemented by a contract."""

    name: str
    function: Function
    selector: str
    flag: str

    @property
    def source_line(self) -> int:
        lines = self.function.source_mapping.lines
        return lines[0] if lines else 0

    @property
    def source_file(self) -> str:
        return self.function.source_mapping.filename.short


# --------------------------------------------------------------------------- #
# Identifying hooks
# --------------------------------------------------------------------------- #


#: Matches a bare Solidity identifier, so value-type names can be substituted
#: without touching `uint256`, tuple parens or array brackets.
_IDENTIFIER = __import__("re").compile(r"\b[A-Za-z_]\w*\b")


def normalize_signature(signature: str) -> str:
    """Rewrite a Slither signature into canonical ABI spelling.

    Slither's ``Function.solidity_signature`` does not consistently erase
    user-defined value types. In a single ``PoolKey`` tuple it renders
    ``currency0`` as ``address`` but ``currency1`` as ``Currency``:

        beforeSwap(address,(address,Currency,uint24,int24,address),...)

    against the canonical

        beforeSwap(address,(address,address,uint24,int24,address),...)

    so a literal string comparison silently fails to recognise any hook at all —
    a detector that reports nothing, which is the worst possible failure for a
    security tool because it looks exactly like success.

    Substituting every known alias makes the comparison robust to that. Aliases
    are generated from v4-core's ``type X is Y;`` declarations, so a new value
    type in a future release is picked up by ``make spec`` rather than needing a
    code change here.
    """
    if not signature:
        return signature
    name, _, rest = signature.partition("(")
    if not rest:
        return signature

    def substitute(match) -> str:
        token = match.group(0)
        seen: set[str] = set()
        while token in VALUE_TYPE_ALIASES and token not in seen:
            seen.add(token)
            token = VALUE_TYPE_ALIASES[token]
        return token

    return name + "(" + _IDENTIFIER.sub(substitute, rest)


def implemented_callbacks(contract: Contract) -> list[HookCallback]:
    """Return the IHooks callbacks this contract actually implements.

    Matching is on the full normalised signature, not the bare name, so a
    contract with its own unrelated `afterSwap(uint256)` is not mistaken for a
    hook. Signatures come from `hooks_spec`, which is generated from v4-core and
    cross-checked against solc by `harness/test/HooksSpec.t.sol`.

    Inherited implementations count: a hook extending OpenZeppelin's `BaseHook`
    implements the callbacks through it, and that is the common case.
    """
    found: list[HookCallback] = []
    for function in contract.functions_entry_points:
        signature = normalize_signature(function.solidity_signature)
        for name, canonical in CALLBACK_SIGNATURES.items():
            if signature != canonical:
                continue
            # An abstract or unimplemented declaration is not an implementation;
            # flagging it would mean reporting the interface itself.
            if not function.is_implemented:
                continue
            found.append(
                HookCallback(
                    name=name,
                    function=function,
                    selector=CALLBACK_SELECTORS[name],
                    flag=CALLBACK_TO_FLAG[name],
                )
            )
            break
    return found


def always_reverts(function: Function) -> bool:
    """Whether every path through `function` ends in a revert.

    Approximated as: the function contains a revert and has no return statement.
    That is exactly the shape of an unimplemented-callback stub and is cheap to
    check; a function with conditional reverts has a return somewhere and is
    correctly excluded.
    """
    if not function.is_implemented:
        return False

    has_revert = False
    for node in function.nodes:
        if node.type == NodeType.THROW:
            has_revert = True
        elif node.type == NodeType.RETURN:
            return False
        else:
            for ir in node.irs:
                if isinstance(ir, SolidityCall) and "revert" in str(ir.function.name):
                    has_revert = True
    return has_revert


def resolve_override(contract: Contract, function: Function) -> Function:
    """Return the most-derived implementation of `function` visible on `contract`.

    Slither's `internal_calls` resolve statically: an inherited `afterSwap` on
    `BaseHook` records a call to `BaseHook._afterSwap`, even when the analysed
    contract overrides `_afterSwap` with real logic. Following that edge without
    re-resolving finds the base's `revert HookNotImplemented()` stub and concludes
    the callback is unimplemented — precisely backwards for the hook that did the
    work.

    `contract.functions` lists *every* version of an overridden function, base
    and override alike, in no guaranteed order — so taking the first match picks
    the base's stub about as often as not. We select the most-derived candidate:
    one declared on the contract itself if present, otherwise the one whose
    declarer is furthest down the inheritance chain.
    """
    best: Function | None = None
    for candidate in contract.functions:
        if candidate.full_name != function.full_name or not candidate.is_implemented:
            continue
        if candidate.contract_declarer == contract:
            return candidate
        if best is None:
            best = candidate
        elif best.contract_declarer in candidate.contract_declarer.inheritance:
            # `best`'s declarer is an ancestor of `candidate`'s, so candidate wins.
            best = candidate
    return best or function


def is_effectually_implemented(function: Function, contract: Contract | None = None) -> bool:
    """Whether a callback actually does something, or is only a stub.

    Necessary because of how the canonical base class works. OpenZeppelin's
    `BaseHook` implements every external callback — guarded, and delegating to an
    internal `_beforeSwap`-style function whose default body is
    `revert HookNotImplemented()`. A hook opts in by overriding the internal
    function.

    So "the contract has a `beforeSwap`" is true for every BaseHook descendant
    and tells us nothing. What matters is whether the delegate does work. Getting
    this wrong in either direction breaks HS-02: treat stubs as implementations
    and every BaseHook hook looks like it implements all fourteen permissions;
    treat delegating callbacks as stubs and no hook implements anything.

    Args:
        function: The external callback.
        contract: The contract under analysis. Required to resolve overrides of
            the internal delegate; without it, an overridden delegate is missed
            and the callback is misreported as a stub.
    """
    if always_reverts(function):
        return False

    delegates: list[Function] = []
    for call in function.internal_calls:
        target = getattr(call, "function", call)
        if not isinstance(target, Function) or not target.is_implemented:
            continue
        # Modifiers show up here too. A modifier is not a delegate, and treating
        # one as such is actively harmful: `onlyPoolManager` reverts and never
        # returns, so it satisfies `always_reverts`, and a correctly guarded
        # callback would be written off as an unimplemented stub.
        if isinstance(target, Modifier):
            continue
        delegates.append(resolve_override(contract, target) if contract else target)

    if delegates and all(always_reverts(target) for target in delegates):
        return False

    return True


def is_hook_contract(contract: Contract) -> bool:
    """Whether this contract is worth running hook detectors against.

    Interfaces, libraries and abstract bases are excluded: they cannot be
    deployed as a hook, and reporting a missing access-control check on
    `IHooks` itself is the kind of noise that gets a tool switched off.
    """
    if contract.is_interface or contract.is_library or contract.is_abstract:
        return False
    return bool(implemented_callbacks(contract))


# --------------------------------------------------------------------------- #
# The PoolManager reference
# --------------------------------------------------------------------------- #


def pool_manager_variables(contract: Contract) -> set[StateVariable]:
    """State variables that plausibly hold the PoolManager.

    Prefers the declared type. Falls back to naming only for `address`-typed
    variables, where the type carries no information.
    """
    candidates: set[StateVariable] = set()
    for variable in contract.state_variables:
        type_name = str(variable.type)
        if type_name in _POOL_MANAGER_TYPES or type_name.endswith("PoolManager"):
            candidates.add(variable)
        elif type_name == "address" and variable.name.lower().lstrip("_") in _POOL_MANAGER_NAMES:
            candidates.add(variable)
    return candidates


def guards_pool_manager(
    function: Function, pool_manager_vars: set[StateVariable]
) -> Node | None:
    """Find the node that constrains `msg.sender` to the PoolManager.

    Returns the guarding node, or None when the function is unguarded.

    The search covers the function body, every modifier attached to it, and
    everything reachable through internal calls — a hook that pushes its check
    into a private `_onlyPoolManager()` helper is properly guarded, and a
    detector that misses that would be unusable.

    A guard is recognised as: an equality or inequality comparison in which one
    side derives from `msg.sender` and the other from a pool-manager variable.
    We do not additionally verify that the false branch reverts. Doing so would
    require whole-path reasoning that Slither's IR makes awkward, and the
    residual false-negative — a comparison whose result is computed and then
    ignored — is a shape that essentially never occurs by accident. The false
    *positive* direction, which matters far more for a detector people leave
    enabled, is unaffected.
    """
    if not pool_manager_vars:
        return None

    for node in _guard_candidate_nodes(function):
        if _compares_sender_to(node, pool_manager_vars):
            return node
    return None


def _guard_candidate_nodes(function: Function) -> Iterator[Node]:
    """Every node whose execution is implied by calling `function`."""
    seen_functions: set[int] = set()

    def walk(fn: Function) -> Iterator[Node]:
        if id(fn) in seen_functions:
            return
        seen_functions.add(id(fn))
        yield from fn.nodes
        for modifier in fn.modifiers:
            if isinstance(modifier, (Modifier, Function)):
                yield from walk(modifier)
        for internal in fn.internal_calls:
            target = getattr(internal, "function", internal)
            if isinstance(target, Function) and target.is_implemented:
                yield from walk(target)

    yield from walk(function)


def _compares_sender_to(node: Node, targets: set[StateVariable]) -> bool:
    """Whether `node` compares msg.sender against one of `targets`."""
    binaries = [ir for ir in node.irs if isinstance(ir, Binary)]
    if not binaries:
        return False
    if not any(ir.type in (BinaryType.EQUAL, BinaryType.NOT_EQUAL) for ir in binaries):
        return False

    # msg.sender may be compared directly or after a conversion; either way it is
    # read by this node.
    reads_sender = any(
        isinstance(v, SolidityVariableComposed) and v.name == "msg.sender"
        for v in node.variables_read
    )
    if not reads_sender:
        return False

    # The pool manager side is usually `address(poolManager)`, a TypeConversion
    # whose result feeds the comparison. Either way the state variable is read
    # here, which is the signal we key on.
    if targets & set(node.state_variables_read):
        return True

    # Immutables are sometimes surfaced through the conversion rather than as a
    # plain state read, so check conversion sources too.
    for ir in node.irs:
        if isinstance(ir, TypeConversion) and ir.variable in targets:
            return True
    return False


# --------------------------------------------------------------------------- #
# Declared permissions
# --------------------------------------------------------------------------- #


def declared_permissions(contract: Contract) -> dict[str, bool] | None:
    """Read the permission set a hook declares via `getHookPermissions()`.

    v4 does not consult this function at runtime — permissions come from the
    deployed address — but `Hooks.validateHookPermissions` compares the two in
    the constructor, so it is the author's stated intent. HS-02 exists because
    intent, implementation and address are three separate things that can
    disagree.

    Returns None when the contract declares no permissions, which is itself
    meaningful: the hook is relying entirely on address bits.

    The `Permissions` struct is returned by value, so we read the literal boolean
    assigned to each field in the function body. Anything not assigned a constant
    is reported as None-by-omission rather than guessed at.
    """
    target = next(
        (f for f in contract.functions if f.name == "getHookPermissions" and f.is_implemented),
        None,
    )
    if target is None:
        return None

    permissions: dict[str, bool] = {}
    for node in target.nodes:
        if node.type not in (NodeType.EXPRESSION, NodeType.RETURN):
            continue
        if node.expression is None:
            continue
        # Slither renders the struct literal without whitespace
        # (`beforeSwap:true,afterSwap:false`), while a field-by-field style
        # produces `permissions.beforeSwap = true`. One regex covers both, and
        # tolerates any spacing a future Slither release might introduce —
        # matching on exact literal text here previously made the whole detector
        # silently report "no permissions declared" for every hook.
        for field, literal in _PERMISSION_ASSIGNMENT.findall(str(node.expression)):
            if field in _PERMISSION_FIELD_SET:
                permissions[field] = literal == "true"
    return permissions or None


#: Field names of `Hooks.Permissions`, in bit order. Derived from the flag names
#: in the generated spec so the two cannot drift apart.
_PERMISSION_FIELDS: tuple[str, ...] = tuple(
    _flag.removesuffix("_FLAG").lower().replace("_returns_delta", "_return_delta")
    for _flag in FLAG_BITS
)


def _camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(part.capitalize() for part in rest)


#: `beforeSwap`, `afterSwapReturnDelta`, ... matching the Solidity struct.
PERMISSION_FIELDS: tuple[str, ...] = tuple(_camel(f) for f in _PERMISSION_FIELDS)

_PERMISSION_FIELD_SET: frozenset[str] = frozenset(PERMISSION_FIELDS)

#: `beforeSwap:true`, `beforeSwap: true`, `permissions.beforeSwap = true`.
_PERMISSION_ASSIGNMENT = __import__("re").compile(r"(\w+)\s*[:=]\s*(true|false)\b")

#: Flag name for each struct field, so a divergence can name the address bit.
FIELD_TO_FLAG: dict[str, str] = {
    _camel(_flag.removesuffix("_FLAG").lower().replace("_returns_delta", "_return_delta")): _flag
    for _flag in FLAG_BITS
}

#: Struct fields corresponding to custom-accounting permissions.
RETURNS_DELTA_FIELDS: frozenset[str] = frozenset(
    _camel(_flag.removesuffix("_FLAG").lower().replace("_returns_delta", "_return_delta"))
    for _flag in RETURNS_DELTA_FLAGS
)


# --------------------------------------------------------------------------- #
# Call-graph queries
# --------------------------------------------------------------------------- #


def reachable_functions(function: Function) -> set[Function]:
    """Every implemented function reachable from `function` by internal calls."""
    seen: set[Function] = set()

    def walk(fn: Function) -> None:
        for internal in fn.internal_calls:
            target = getattr(internal, "function", internal)
            if isinstance(target, Function) and target.is_implemented and target not in seen:
                seen.add(target)
                walk(target)

    walk(function)
    return seen


def swap_path_functions(contract: Contract) -> set[Function]:
    """Functions executed during a swap: the swap callbacks and their callees."""
    roots = [
        cb.function for cb in implemented_callbacks(contract) if cb.name in SWAP_PATH_CALLBACKS
    ]
    reachable: set[Function] = set(roots)
    for root in roots:
        reachable |= reachable_functions(root)
    return reachable


@dataclass(frozen=True)
class ExternalCall:
    """An outbound call, with enough context to judge whether it is risky."""

    node: Node
    destination: str
    is_low_level: bool
    is_static: bool

    @property
    def line(self) -> int:
        lines = self.node.source_mapping.lines
        return lines[0] if lines else 0

    @property
    def file(self) -> str:
        return self.node.source_mapping.filename.short


def external_calls_in(functions: Iterable[Function]) -> list[ExternalCall]:
    """Collect outbound calls made by the given functions.

    Library calls are excluded: they are `DELEGATECALL` to known, immutable code
    in practice, and counting `FullMath.mulDiv` as an external dependency would
    make the metric meaningless. `SolidityCall` (keccak256, require, ...) is
    likewise not an external interaction.
    """
    calls: list[ExternalCall] = []
    for function in functions:
        for node in function.nodes:
            for ir in node.irs:
                if isinstance(ir, LibraryCall) or isinstance(ir, SolidityCall):
                    continue
                if isinstance(ir, HighLevelCall):
                    calls.append(
                        ExternalCall(
                            node=node,
                            destination=str(ir.destination),
                            is_low_level=False,
                            # Slither exposes view-ness of the callee when known.
                            is_static=bool(getattr(ir.function, "view", False))
                            or bool(getattr(ir.function, "pure", False)),
                        )
                    )
                elif isinstance(ir, LowLevelCall):
                    calls.append(
                        ExternalCall(
                            node=node,
                            destination=str(ir.destination),
                            is_low_level=True,
                            is_static=str(ir.function_name) == "staticcall",
                        )
                    )
                elif isinstance(ir, InternalCall):
                    continue
    return calls
