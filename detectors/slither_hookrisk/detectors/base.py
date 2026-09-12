"""Common base for every hookrisk Slither detector.

Slither's `AbstractDetector` gives us registration, output formatting and SARIF
export for free. This subclass adds the three things every hookrisk detector
needs on top:

* **Scoping.** Detectors only ever run against contracts that actually implement
  IHooks callbacks. Without this, scanning a repository reports missing
  PoolManager checks on every ERC20 in `lib/`, and a tool that cries wolf on
  dependencies is a tool nobody runs twice.
* **Framework linkage.** Each detector declares which of the nine scoring
  dimensions and which of the seven feature triggers its findings inform. The
  scoring engine consumes those declarations, so a new detector automatically
  participates in scoring instead of needing to be wired in twice.
* **A stable rule class.** The canonical taxonomy shared with the TypeScript
  side, so a finding here can be reconciled with the same finding from another
  engine. See `cli/src/types.ts`.
"""

from __future__ import annotations

from typing import ClassVar, Sequence

from slither.core.declarations import Contract
from slither.detectors.abstract_detector import AbstractDetector, DetectorClassification
from slither.utils.output import Output

from ..utils.hook_analysis import is_hook_contract


class HookriskDetector(AbstractDetector):
    """Base class for the HS-xx detectors.

    Subclasses implement `_detect_hook`, which is called once per hook contract
    in the compilation unit and returns zero or more Slither `Output` objects.
    """

    # --- hookrisk metadata, consumed by the scoring engine -------------------

    #: Canonical class shared with other engines. See `RuleClass` in cli/src/types.ts.
    RULE_CLASS: ClassVar[str] = ""

    #: Framework scoring dimensions this detector informs. Names match
    #: docs/SCORING.md and the `dimensions` block of hook-risk.schema.json.
    INFORMS_DIMENSIONS: ClassVar[Sequence[str]] = ()

    #: Framework feature triggers this detector can activate.
    INFORMS_TRIGGERS: ClassVar[Sequence[str]] = ()

    #: Set on detectors that classify rather than accuse. A classification is
    #: not a defect and must not be rendered as one — HS-07 reports that a hook
    #: uses custom accounting, which is a design choice with consequences for
    #: scoring and for which invariants apply, not something to fix.
    IS_CLASSIFICATION: ClassVar[bool] = False

    # --- Slither plumbing ----------------------------------------------------

    def _detect(self) -> list[Output]:
        results: list[Output] = []
        for contract in self.compilation_unit.contracts_derived:
            if not is_hook_contract(contract):
                continue
            results.extend(self._detect_hook(contract))
        return results

    def _detect_hook(self, contract: Contract) -> list[Output]:  # pragma: no cover
        raise NotImplementedError

    # --- helpers -------------------------------------------------------------

    def _report(self, parts: list, discriminator: str | None = None) -> Output:
        """Build a Slither Output, tagging it with hookrisk metadata.

        The metadata rides along in the JSON and SARIF output so downstream
        consumers — the manifest writer above all — do not have to re-derive
        which dimension a finding feeds from its rule id.

        `discriminator` tells apart findings of one rule class anchored on the
        same element. HS-02 anchors "declared but not implemented" on the
        contract, so a hook that declares two unimplemented permissions produces
        two findings at the same location with the same class, and the CLI's
        de-duplication — which exists so two *engines* reporting one defect are
        not counted twice — collapsed them into one. Orbital lost its
        `beforeAddLiquidity` finding that way. The discriminator (the permission
        field, the callback name) makes the identity explicit instead of
        leaving it to the message text.
        """
        output = self.generate_result(parts)
        metadata: dict[str, object] = {
            "ruleClass": self.RULE_CLASS,
            "informsDimensions": list(self.INFORMS_DIMENSIONS),
            "informsTriggers": list(self.INFORMS_TRIGGERS),
            "isClassification": self.IS_CLASSIFICATION,
        }
        if discriminator is not None:
            metadata["discriminator"] = discriminator
        output.data["hookrisk"] = metadata
        return output


# Re-exported so detector modules import a single name.
__all__ = ["HookriskDetector", "DetectorClassification"]
