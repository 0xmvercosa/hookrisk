# Detectors

hookrisk's static layer is a Slither plugin. Each detector declares which
framework dimensions and triggers its findings inform, so a new detector
participates in scoring without being wired in twice.

Detectors only run against contracts that actually implement `IHooks` callbacks.
Without that scoping, a scan reports missing PoolManager checks on every ERC20 in
`lib/`, and a tool that cries wolf on dependencies is one nobody runs twice.

| Rule | Finds | Impact | Status |
|---|---|---|---|
| [HS-01](#hs-01) | Callback anyone can call | High | ✅ |
| [HS-02](#hs-02) | Permissions vs implementation | High | ✅ |
| [HS-07](#hs-07) | Custom accounting in use | Info | ✅ |
| [HS-03](#not-yet-implemented) | Admin surface | — | ✖ |
| [HS-04](#not-yet-implemented) | Upgradeability | — | ✖ (covered by BlockSec) |
| [HS-05](#not-yet-implemented) | External call in swap path | — | ✖ |
| [HS-06](#not-yet-implemented) | Unbounded dynamic fee | — | ✖ |
| [HS-08](#not-yet-implemented) | Rounding direction | — | ✖ |

---

<a id="hs-01"></a>
## HS-01 — Unprotected hook callback

`hookrisk-unprotected-callback` · rule class `unprotected-hook-callback`

### The defect

v4 invokes hook callbacks from the PoolManager and only from the PoolManager.
`IHooks` says so: *"Should only be callable by the v4 PoolManager."*

A callback that does not enforce this is directly reachable by anyone, with a
caller-supplied `PoolKey` and caller-supplied `hookData`. The hook then updates
state, or moves value, for a pool it was never installed on, with parameters the
PoolManager would never have produced. No tokens need to move for the damage to
be done: a corrupted volume counter poisons every TWAP, dynamic fee and reward
accrual that trusts it.

### How it detects

**Structurally, never by name.** The check traces an actual comparison between
`msg.sender` and the state variable holding the pool manager — through the
function body, every modifier attached to it, and every internal call it makes.

Name matching would be wrong twice over. `BaseHook` has already moved once, from
v4-periphery to OpenZeppelin's `uniswap-hooks`, so a detector keyed on a modifier
name breaks on library churn. Worse, it is defeated by

```solidity
modifier onlyPoolManager { _; }   // enforces nothing
```

which is exactly the shape a deliberately malicious hook would take.

[`hook_analysis.py`](../detectors/slither_hookrisk/utils/hook_analysis.py) ·
`guards_pool_manager`

### Known trade-off

We do not additionally verify that the false branch reverts. Doing so needs
whole-path reasoning that Slither's IR makes awkward, and the residual false
negative — a comparison whose result is computed and discarded — essentially
never occurs by accident. The false *positive* direction, which decides whether
people leave a detector enabled, is unaffected.

### Prior art

BlockSec's HookScan detects this class from bytecode as `UniswapPublicHook`.
hookrisk implements it at source level anyway: the two engines disagree often
enough to be worth reconciling, source level gives a precise line for the SARIF
annotation on a pull request, and putting the most important access-control check
behind a Docker dependency would be a poor default. When both run and agree, the
findings merge into one at high confidence.

---

<a id="hs-02"></a>
## HS-02 — Permission and implementation divergence

`hookrisk-flag-divergence` · rule class `flag-implementation-divergence`

**As far as we can tell, no other v4 tool checks this.**

### The defect

A hook's permissions are not stored anywhere. They are the low 14 bits of its
deployed address, chosen by grinding a CREATE2 salt. Three things must agree and
nothing enforces that they do:

1. the bits in the deployed address — what the PoolManager obeys;
2. `getHookPermissions()` — what the constructor validates the address against;
3. the callbacks the contract actually implements.

`Hooks.validateHookPermissions` checks (1) against (2). **Nothing checks either
against (3).**

### Two failure modes

**Permission declared, callback not implemented.** The PoolManager will invoke
it. With OpenZeppelin's `BaseHook` the delegate reverts with
`HookNotImplemented()`, so *every swap through the pool reverts*. The pool is
bricked for that operation and cannot be fixed without redeploying to a new
address. Invisible until someone touches the pool.

**Callback implemented, permission not declared.** The PoolManager never calls
it. Fee logic that never runs, an access check that never fires, a TWAP that
never updates. The framework names this in §1.11, *Permission Encoding & Salt
Grinding Pitfalls*. It is the more dangerous direction, because everything
appears to work while the mechanism you built is simply absent.

A third case is also reported: a returns-delta permission declared without its
parent action flag. `Hooks.isValidHookAddress` rejects that outright, so no
address satisfying those permissions can initialize a pool — worth catching
before a salt grind rather than after.

### One subtlety worth knowing

"The contract has a `beforeSwap`" is true of every `BaseHook` descendant and
tells you nothing: the base implements all ten callbacks, each delegating to an
internal `_beforeSwap` whose default body reverts. What matters is whether the
delegate does work.

Getting that wrong breaks the detector in both directions — treat stubs as
implementations and every BaseHook hook appears to implement all fourteen
permissions; treat delegating callbacks as stubs and no hook implements anything.
Resolving it also requires re-resolving virtual dispatch, because Slither's
`internal_calls` point at the *base's* delegate even when the contract overrides
it.

[`hook_analysis.py`](../detectors/slither_hookrisk/utils/hook_analysis.py) ·
`is_effectually_implemented`, `resolve_override`

---

<a id="hs-07"></a>
## HS-07 — Custom accounting in use

`hookrisk-custom-accounting` · rule class `custom-accounting` · **classification, not a defect**

A returns-delta permission lets the hook alter settled amounts, and in the limit
consume the entire swap so the PoolManager skips the concentrated-liquidity math
— the framework's §1.10 NoOp swap, which is another way of saying the hook is now
the market maker.

Reported at INFO because there is nothing to fix. It exists so two mechanical
consequences are traceable:

- **Scoring.** Fires the custom-math and price-impact triggers, which mandate a
  math-specialist audit regardless of the total score.
- **Invariants.** Changes what the harness may assert. I2 becomes inapplicable
  and price monotonicity takes its place. See [INVARIANTS.md](INVARIANTS.md).

The manifest marks these `isClassification: true`, and the gate ignores them —
failing a build for a legitimate design choice would be indefensible.

---

<a id="not-yet-implemented"></a>
## Not yet implemented

Listed with what their absence costs, because a missing detector silently makes a
dimension unmeasurable and that consequence should be legible.

| Rule | Would find | Dimension left unmeasured |
|---|---|---|
| **HS-03** | Privileged surface: fee setters, pause, sweep; whether an EOA or a contract controls it | `complexity`, refines `upgradeability` |
| **HS-04** | DELEGATECALL to mutable code, EIP-1967 slots, `upgradeTo` | `upgradeability` — **unless BlockSec runs** |
| **HS-05** | Calls inside before/afterSwap to anything but the PoolManager and the pair's tokens | `externalDependencies` |
| **HS-06** | Dynamic fee with no ceiling, no rate limit, or the wrong controller | refines `priceImpactingBehavior` |
| **HS-08** | Rounding that resolves in the caller's favour on an exit path | refines `customMath` |

HS-04 is the clearest illustration of why the multi-engine design is not
decoration: enabling BlockSec turns `upgradeability` from unmeasurable into
measurable, and the tool says so in the output rather than leaving a reader to
infer it.

---

## Coverage is reported, not assumed

Slither logs `Impossible to generate IR for <function>` and **continues**, then
reports a normal result count. Any detector relying on SlithIR never sees those
functions.

This is not hypothetical. Running over OpenZeppelin's `uniswap-hooks`, three
functions fail to lift — including `AntiSandwichHook._afterSwap`, which is where
the interesting logic lives. We hit it in our own false-positive gate: the
detectors returned zero findings, and it took reading stderr to establish that
part of that silence was "nothing wrong" and part was "nothing looked."

hookrisk collects them and reports reduced coverage (`HR-E205`) in the manifest
and in `HOOK_RISK.md`:

> ⚠️ **3 function(s) were not analysed.** Slither could not lift them to IR and
> continued silently. Findings below do not cover them — this is not the same as
> those functions being clean.

`--fail-on-partial-coverage` makes it a hard failure. Right for a release gate on
your own hook; too strict for scanning third-party code.

---

## The corpus is the contract

Every detector has fixtures on both sides, and CI enforces both.

**[`corpus/src/bad/`](../corpus/src/bad)** — must fire. Each fixture documents
the vulnerability *class* it reproduces and links the public write-up. They are
minimal reproductions of a class, not faithful reimplementations of any
particular incident, and say so.

**[`corpus/src/good/`](../corpus/src/good)** — must stay silent. Compiles
OpenZeppelin's production `AntiSandwichHook` and `LiquidityPenaltyHook`, so every
detector is run against externally reviewed code on every build.

The negative gate matters more. Missing a real bug is bad; flagging correct code
is what gets a security tool switched off, and after that it finds nothing at all.

`UnvalidatedCallback` also carries an in-file control: a correctly guarded
`beforeAddLiquidity` alongside two unguarded callbacks. A detector that flagged
the whole contract instead of the specific functions would pass a naive test and
be useless in practice.
