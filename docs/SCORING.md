# Scoring

hookrisk implements the [Uniswap Hooks Security
Framework](https://github.com/uniswapfoundation/security-framework), pinned at
commit `e7e8da52`. The rubric lives as data in
[`schema/framework-rubric.json`](../schema/framework-rubric.json) so our reading
of the framework can be diffed against the framework without reading TypeScript.

> The Uniswap Foundation does not review, endorse or certify this port or any
> score derived from it.

## The shape

Nine dimensions, total 0–33, mapping to three tiers:

| Tier | Range |
|---|---|
| Low | 0–6 |
| Medium | 7–17 |
| High | 18–33 |

Plus seven feature triggers that apply **regardless of the total**. That second
layer is the framework's own defence against a team scoring itself low while
shipping a dangerous primitive, and it is the part of the design we did not have
to reinterpret.

## Three rules that shape everything

### 1. Unmeasured is not zero

If static analysis was skipped, or no detector exists for a property, that
dimension has no value. Scoring it 0 would lower the total, possibly the tier,
and thin out the resulting security plan — based on a number the tool invented,
in the direction that makes the hook look safer. Across nine dimensions those
biases all point the same way.

So unmeasured dimensions are **excluded from the total** and reported as a range:

```
MEDIUM risk  10/33  (undetermined: up to 22/33)
  ! 4 dimension(s) unmeasured: the tier is between Medium Risk and High Risk.
```

The gate treats an undetermined tier as a failure when the upper bound exceeds
the threshold. A gate that passed an unknown would be asserting something it does
not know.

### 2. A dimension is scored 0 only if someone looked

The rule that makes rule 1 meaningful. Each dimension declares which rule classes
can raise it, and each class declares which engines can produce it. A dimension is
`measured: 0` only when every responsible engine actually ran.

This is why enabling BlockSec *widens what hookrisk can score* rather than merely
duplicating it — and why the tool tells you so:

```
upgradeability  —  unmeasured
   Not measured: no detector for upgradeable-hook (needs blocksec, which did not run)
```

[`derive.ts`](../cli/src/scoring/derive.ts)

#### "Ran" is not "looked"

An engine's `status: ok` says its process finished. It does not say the engine
recognised the target. Five hooks written against the 2023 `getHooksCalls()`
ABI were once scored `complexity: 0 — Pass-through only; no hook state` because
Slither ran cleanly over contracts the detectors never identified as hooks.

So an engine counts as having looked only when it ran **and** did not disclaim
the target. Two things disclaim it:

- an `unsupported-hook-abi` classification on the target file — the detectors
  saying "this is hook-shaped and I cannot read it";
- `targetCoverage.covered: false` on the engine result, which the Slither
  adapter sets from the same classification and which any future engine can
  set for its own reasons.

Either way, every dimension that engine would have measured comes back
unmeasured, with the reason in its evidence:

```
customMath  —  unmeasured
   Not measured: custom-accounting requires hookrisk; hookrisk ran but did not
   recognise the target's hook ABI (unsupported-hook-abi: ...)
```

#### Some dimensions cannot be measured by silence at all

Complexity is the case today. HS-01 and HS-02 prove a hook has callbacks with
non-trivial structure, so when either fires the dimension gets a **floor of 1**.
When neither fires, nothing hookrisk runs can tell a genuinely pass-through hook
from a complex one whose callbacks happen to be guarded and correctly declared —
which is what every well-written hook looks like. Complexity is therefore
`unmeasured` when the detectors are silent, never `measured: 0`, and the
evidence says why: hookrisk has no complexity metric yet. Declare it in
`hookrisk.toml` to score it.

### 3. Measured and declared are different claims

`teamMaturity` is a self-assessment by definition. `upgradeability` is observable
from bytecode. Both are inputs; only one can be checked, and the manifest keeps
them apart.

An explicit declaration overrides a measurement, and the manifest records both.
Overriding upward is unremarkable. Overriding *downward* is precisely the move
the framework warns about, and making it visible is the only defence a document
can offer.

hookrisk has **no defaults** for declared dimensions. It errors (`HR-E101`)
rather than guess.

## The nine dimensions

| Dimension | Range | How hookrisk gets it |
|---|---|---|
| Complexity | 0–5 | Floor of 1 when HS-01/HS-02 fire; otherwise **unmeasured** — no dedicated metric yet, and silence is not 0 |
| Custom math | 0–5 | Measured — from custom-accounting and rounding findings |
| External dependencies | 0–3 | Needs HS-05 (not implemented) → unmeasured |
| External liquidity exposure | 0–3 | Never measured → declared or unmeasured |
| TVL potential | 0–5 | **Declared** — asks about potential, not current |
| Team maturity | 0–3 | **Declared** — self-assessed by definition |
| Upgradeability | 0–3 | Measured when BlockSec runs, else unmeasured |
| Autonomous parameter updates | 0–3 | Never measured → declared or unmeasured |
| Price impacting behavior | 0–3 | Measured — returns-delta permissions, dynamic fees |

## Where we interpreted, and why you should check

**Seven of nine dimensions have no scoring brackets in the framework.** Only TVL
potential and team maturity define what each value means. The rest give a range
and a paragraph of prose.

That is the single biggest obstacle to implementing the framework, and to two
teams ever producing comparable scores. Nothing distinguishes Complexity 3 from
Complexity 4 — and the boundary at 7, or at 18, decides whether you owe one audit
or two plus a math specialist.

So hookrisk supplies brackets, derived from the prose, and **marks every one of
them**:

- in the rubric, as `bracketsAreInterpretation: true`
- in the manifest, per dimension
- in `HOOK_RISK.md`, with a footnote marker

They are our reading, not the Foundation's, and we would rather delete them and
adopt authoritative ones. Reported as [FEEDBACK.md #2](../FEEDBACK.md).

The same applies to the dimension-to-trigger mapping. The framework states it
only for TVL (`trigger fires when the dimension is 5`); for the other six we
chose thresholds and marked them `derivationIsInterpretation: true`. Reported as
[FEEDBACK.md #5](../FEEDBACK.md).

## Recommendation precedence

The framework uses five strengths — *optional*, *recommended*, *strongly
recommended*, *required*, *mandatory* — and never orders them. Multiple triggers
routinely fire at once and produce different strengths for the same action:

- §3 Low Risk: bug bounty **optional**
- §4.3 External dependencies: bug bounty **recommended**
- §4.5 Price impact: bug bounty **required**
- §4.7 TVL 5: bug bounty **mandatory**

hookrisk defines the ordinal and merges by maximum:

```
optional < recommended < strongly recommended < required (= mandatory)
```

Every request is kept as a source, so the report explains *why* an action is
required rather than only that it is:

| Action | Strength | Because |
|---|---|---|
| Bug bounty programme | **Required** | `tier:low`, `trigger:tvl-5` |

Reported as [FEEDBACK.md #3](../FEEDBACK.md).

## Conformance: the framework's own worked examples

Section 5 gives four worked examples. They are the only place the Foundation
states an end-to-end expected outcome, so they are the closest thing to a
conformance suite this port can be held to. All four are encoded as tests in
[`score.test.ts`](../cli/src/scoring/score.test.ts).

**Three pass.**

| Example | Expected | Result |
|---|---|---|
| Score 4 + custom math | math-specialist audit required | ✅ |
| Score 5 + TVL 5 | monitoring and bug bounty required | ✅ |
| Score 3 + autonomy | invariant testing required | ✅ |
| Score 7 + custom math + price impact | *"looks like a high-risk hook regardless"* | ❌ |

**The fourth does not hold under the framework's own rules.** Applying §3 and §4
mechanically, that hook picks up three of the four measures the High tier makes
mandatory and misses `monitoring`, because the only rules that could demand it
are §4.1 (which says *recommended*) and §4.5 (whose *required* is conditional on
TVL 5, and TVL is 0 in the example).

The test pins the shortfall rather than hiding it, so if the Foundation tightens
§4.1 our port fails and tells us to update. Reported as
[FEEDBACK.md #11](../FEEDBACK.md).

## The gate

Configured in `hookrisk.toml`:

```toml
[gate]
maxTier = "medium"
maxSeverity = "high"
failOnPartialCoverage = false
```

Exit code `2` means the scan completed and the gate did not pass. That is
deliberately not an error code: conflating "hookrisk is broken" with "your hook
has a problem" would make a CI job unable to tell them apart, and only one of
those should page someone.

**A violated invariant fails the gate unconditionally**, whatever the tier and
whatever thresholds are set. It is the strongest evidence the tool produces — not
a pattern resembling a bug, but an executed sequence in which the hook
demonstrably misbehaved. A gate weighing a reproducible counterexample against a
numeric threshold could pass a hook that provably traps liquidity, and that is
not a trade-off worth offering.

[`manifest.ts`](../cli/src/manifest.ts) · `evaluateGate`
