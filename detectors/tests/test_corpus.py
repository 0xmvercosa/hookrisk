"""Finding-level expectations for the corpus fixtures.

The Makefile's `test-corpus` gate asks coarse questions with jq: did `bad`
fire, is `good` free of anything severe, does `legacy` produce exactly the
unsupported-ABI classification. This file asks the finer ones each fixture's
header comment promises — which contract a finding anchors on, which
discriminator it carries, that the in-file controls stayed silent — because a
detector can pass the coarse gate while anchoring every finding on the wrong
element.

Standard library only (`unittest`, `subprocess`, `json`) so the gate runs in the
same virtualenv `make setup` builds, without a dev extra. Works under pytest too.

Each corpus directory is scanned once per process and cached; Slither's Foundry
build is itself cached, so the whole file runs in a few seconds.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS = REPO_ROOT / "corpus"

#: Everything the plugin ships, so a detector left out of `make test-corpus` by
#: mistake still runs here.
DETECTORS = ",".join(
    [
        "hookrisk-unprotected-callback",
        "hookrisk-flag-divergence",
        "hookrisk-custom-accounting",
        "hookrisk-disabled-callback",
        "hookrisk-unsupported-abi",
    ]
)

#: Rule classes the CLI's `RuleClass` union knows about. A detector inventing a
#: new one without the CLI learning it would be dropped at parse time, silently.
KNOWN_RULE_CLASSES = {
    "unprotected-hook-callback",
    "flag-implementation-divergence",
    "custom-accounting",
    "callback-intentionally-disabled",
    "unsupported-hook-abi",
}


def slither_bin() -> str:
    configured = os.environ.get("HOOKRISK_SLITHER_BIN")
    if configured:
        # A relative path is relative to the repo root, which is where `make`
        # runs; we chdir into corpus/ before invoking it.
        path = Path(configured)
        return str(path if path.is_absolute() else (REPO_ROOT / path).resolve())
    venv = REPO_ROOT / ".venv" / "bin" / "slither"
    return str(venv) if venv.exists() else "slither"


@lru_cache(maxsize=None)
def scan(target: str) -> list[dict]:
    """Run every hookrisk detector over `corpus/<target>` and return the findings.

    Fails loudly on anything other than a successful scan. An empty finding list
    from a scan that never compiled is indistinguishable from a clean corpus,
    which is exactly the failure a negative gate must not have.
    """
    completed = subprocess.run(
        [
            slither_bin(),
            target,
            "--detect",
            DETECTORS,
            "--exclude-dependencies",
            "--fail-none",
            "--json",
            "-",
        ],
        cwd=CORPUS,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise RuntimeError(
            f"slither failed on corpus/{target} (exit {completed.returncode}):\n"
            f"{completed.stderr[-4000:]}"
        )
    report = json.loads(completed.stdout)
    if not report.get("success"):
        raise RuntimeError(f"slither reported failure on corpus/{target}: {report.get('error')}")
    return report["results"]["detectors"]


def anchor(finding: dict) -> str:
    """`Contract` or `Contract.function` of the element a finding points at."""
    element = finding["elements"][0]
    if element["type"] == "function":
        return f"{element['type_specific_fields']['parent']['name']}.{element['name']}"
    return element["name"]


def by_check(findings: list[dict], check: str) -> list[dict]:
    return [f for f in findings if f["check"] == check]


def severe(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["impact"] in ("High", "Medium")]


class MetadataContract(unittest.TestCase):
    """The `hookrisk` block every finding carries, which the CLI parses."""

    def test_every_finding_carries_a_known_rule_class(self) -> None:
        for target in ("src/good", "src/bad", "src/legacy"):
            for finding in scan(target):
                meta = finding.get("hookrisk")
                self.assertIsNotNone(meta, f"{finding['check']} on {anchor(finding)} has no hookrisk block")
                self.assertIn(meta["ruleClass"], KNOWN_RULE_CLASSES)
                self.assertIsInstance(meta["isClassification"], bool)

    def test_classifications_are_informational(self) -> None:
        for target in ("src/good", "src/bad", "src/legacy"):
            for finding in scan(target):
                if finding["hookrisk"]["isClassification"]:
                    self.assertEqual(finding["impact"], "Informational", anchor(finding))

    def test_a_broken_scan_raises_instead_of_reporting_clean(self) -> None:
        with self.assertRaises(RuntimeError):
            scan("src/does-not-exist")


class GoodCorpus(unittest.TestCase):
    """corpus/src/good — nothing severe, and the classifications that must fire."""

    def test_nothing_at_high_or_medium(self) -> None:
        self.assertEqual([], [(f["check"], anchor(f)) for f in severe(scan("src/good"))])

    def test_hs01_and_hs02_silent_on_openzeppelin_production_hooks(self) -> None:
        production = {
            "ProductionAntiSandwichHook",
            "ProductionLimitOrderHook",
            "ProductionLiquidityPenaltyHook",
        }
        for check in ("hookrisk-unprotected-callback", "hookrisk-flag-divergence"):
            hits = [anchor(f) for f in by_check(scan("src/good"), check)]
            self.assertFalse(
                [h for h in hits if h.split(".")[0] in production], f"{check} fired on {hits}"
            )

    def test_openzeppelin_hooks_were_actually_analysed(self) -> None:
        # The whole point of subclassing the mocks in project source. If this
        # classification disappears the gate is once again "silent because it
        # never looked", not "silent because the code is clean".
        anchors = {anchor(f) for f in by_check(scan("src/good"), "hookrisk-custom-accounting")}
        self.assertIn("ProductionAntiSandwichHook", anchors)
        self.assertIn("ProductionLiquidityPenaltyHook", anchors)

    def test_intentional_revert_is_classified_not_accused(self) -> None:
        findings = scan("src/good")
        divergence = [anchor(f) for f in by_check(findings, "hookrisk-flag-divergence")]
        self.assertNotIn("IntentionalRevertHook", [a.split(".")[0] for a in divergence])

        disabled = by_check(findings, "hookrisk-disabled-callback")
        self.assertEqual(["IntentionalRevertHook._beforeAddLiquidity"], [anchor(f) for f in disabled])
        finding = disabled[0]
        self.assertEqual("beforeAddLiquidity", finding["hookrisk"]["discriminator"])
        self.assertEqual("callback-intentionally-disabled", finding["hookrisk"]["ruleClass"])
        self.assertTrue(finding["hookrisk"]["isClassification"])
        self.assertIn("LiquidityNotAllowed()", finding["description"])
        self.assertIn("liquidity addition is disabled by design", finding["description"])
        self.assertIn("harness will observe reverts", finding["description"])

    def test_no_unsupported_abi_in_good(self) -> None:
        self.assertEqual([], by_check(scan("src/good"), "hookrisk-unsupported-abi"))


class BadCorpus(unittest.TestCase):
    """corpus/src/bad — every planted defect is reported, at the right element."""

    def test_hs01_fires_per_unguarded_callback_with_discriminators(self) -> None:
        hits = {
            anchor(f): f["hookrisk"].get("discriminator")
            for f in by_check(scan("src/bad"), "hookrisk-unprotected-callback")
        }
        self.assertEqual(
            {
                "UnvalidatedCallback.beforeSwap": "beforeSwap",
                "UnvalidatedCallback.afterSwap": "afterSwap",
            },
            hits,
        )
        # The in-file control: guarded, must not be reported.
        self.assertNotIn("UnvalidatedCallback.beforeAddLiquidity", hits)

    def test_hs02_stub_still_fires_at_high(self) -> None:
        # BaseHook's HookNotImplemented() is a dependency stub, not a decision;
        # the intentional-revert carve-out must not swallow it.
        stubs = [
            f
            for f in by_check(scan("src/bad"), "hookrisk-flag-divergence")
            if anchor(f) == "DivergentHook" and f["hookrisk"].get("discriminator") == "beforeSwap"
        ]
        self.assertEqual(1, len(stubs))
        self.assertEqual("High", stubs[0]["impact"])
        self.assertIn("no working `beforeSwap` implementation", stubs[0]["description"])

    def test_hs02_discriminators_keep_same_anchor_findings_apart(self) -> None:
        keyed = {
            (anchor(f), f["hookrisk"].get("discriminator"))
            for f in by_check(scan("src/bad"), "hookrisk-flag-divergence")
        }
        self.assertIn(("DivergentHook", "beforeSwap"), keyed)
        self.assertIn(("DivergentHook._afterSwap", "afterSwap"), keyed)
        self.assertIn(("OrphanDeltaHook", "beforeSwapReturnDelta"), keyed)
        # The no-getHookPermissions finding is about the contract as a whole
        # and carries no discriminator.
        self.assertIn(("UnvalidatedCallback", None), keyed)

    def test_no_intentional_revert_classification_in_bad(self) -> None:
        self.assertEqual([], by_check(scan("src/bad"), "hookrisk-disabled-callback"))


class LegacyCorpus(unittest.TestCase):
    """corpus/src/legacy — the scan admits it could not read the hook."""

    def test_only_unsupported_abi_fires(self) -> None:
        findings = scan("src/legacy")
        self.assertTrue(findings)
        self.assertEqual({"hookrisk-unsupported-abi"}, {f["check"] for f in findings})
        for finding in findings:
            self.assertEqual("unsupported-hook-abi", finding["hookrisk"]["ruleClass"])
            self.assertTrue(finding["hookrisk"]["isClassification"])

    def test_pure_2023_hook_is_reported_as_not_analysed(self) -> None:
        [finding] = [f for f in scan("src/legacy") if anchor(f) == "LegacyHook"]
        self.assertIn("getHooksCalls()", finding["description"])
        self.assertIn("afterSwap, beforeSwap", finding["description"])
        self.assertIn("did not analyse this contract", finding["description"])
        self.assertIn("unmeasured", finding["description"])
        self.assertNotIn("discriminator", finding["hookrisk"])

    def test_getHooksCalls_hook_with_one_current_callback_is_not_a_hook(self) -> None:
        # The StopLoss shape. Before `legacy_abi_evidence`, HS-02 reported this
        # contract at HIGH for "not declaring getHookPermissions()".
        [finding] = [f for f in scan("src/legacy") if anchor(f) == "LegacyAfterInitializeHook"]
        self.assertEqual("hookrisk-unsupported-abi", finding["check"])
        self.assertIn("getHooksCalls()", finding["description"])
        self.assertIn("afterSwap", finding["description"])

    def test_mixed_abi_hook_gets_partial_classification_not_hs02(self) -> None:
        # The v2-on-v4 shape: analysed for what matches, honest about the rest.
        [finding] = [f for f in scan("src/legacy") if anchor(f) == "MixedAbiHook"]
        self.assertEqual("hookrisk-unsupported-abi", finding["check"])
        self.assertEqual("partial", finding["hookrisk"]["discriminator"])
        self.assertIn("beforeAddLiquidity", finding["description"])
        self.assertIn("did not judge", finding["description"])

    def test_hook_named_contract_without_hook_shape_is_left_alone(self) -> None:
        self.assertNotIn("HookRegistry", [anchor(f) for f in scan("src/legacy")])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(unittest.main())
