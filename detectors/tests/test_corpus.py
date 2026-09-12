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
METADATA_SCHEMA = REPO_ROOT / "schema" / "engine-metadata.schema.json"

#: Everything the plugin ships, so a detector left out of `make test-corpus` by
#: mistake still runs here.
DETECTORS = ",".join(
    [
        "hookrisk-unprotected-callback",
        "hookrisk-flag-divergence",
        "hookrisk-custom-accounting",
        "hookrisk-disabled-callback",
        "hookrisk-unsupported-abi",
        "hookrisk-hook-profile",
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
    "hook-profile",
}

#: The seven metrics every hook-profile must carry, with their JSON types.
PROFILE_METRICS = {
    "callbacksImplemented": int,
    "callbacksDeclared": int,
    "stateWritesInCallbacks": int,
    "externalCallsInSwapPath": int,
    "internalFunctionsReachableFromCallbacks": int,
    "usesReturnsDelta": bool,
    "hasOwnerOnlyFunctions": bool,
}


# --------------------------------------------------------------------------- #
# A very small JSON Schema checker
# --------------------------------------------------------------------------- #
#
# The CLI validates the metadata block with Ajv. This side has no schema
# library and must not grow a dependency for one file, so the subset of
# draft 2020-12 the engine-metadata schema actually uses is implemented here:
# type, required, properties, additionalProperties, propertyNames, items,
# enum, const, minimum, minLength, uniqueItems. Anything else in the schema is
# an error, not silently ignored — a keyword this checker does not know is a
# keyword the Python gate would stop enforcing without anyone noticing.

_KNOWN_KEYWORDS = {
    "$schema", "$id", "title", "description", "type", "required", "properties",
    "additionalProperties", "propertyNames", "items", "enum", "const", "minimum",
    "minLength", "uniqueItems",
}

_JSON_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
}


def schema_errors(schema: dict, value, path: str = "$") -> list[str]:
    """Return every way `value` violates `schema`; empty means it conforms."""
    unknown = set(schema) - _KNOWN_KEYWORDS
    if unknown:
        return [f"{path}: schema uses unsupported keywords {sorted(unknown)}"]

    errors: list[str] = []
    expected = schema.get("type")
    if expected is not None:
        py = _JSON_TYPES[expected]
        # bool is an int in Python; JSON says otherwise.
        ok = isinstance(value, py) and not (py is int and isinstance(value, bool))
        if not ok:
            return [f"{path}: expected {expected}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}, got {value!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} not in enum")
    if "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}: {value} < minimum {schema['minimum']}")
    if "minLength" in schema and len(value) < schema["minLength"]:
        errors.append(f"{path}: shorter than {schema['minLength']}")

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required {key!r}")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        names = schema.get("propertyNames")
        for key, item in value.items():
            if names is not None:
                errors.extend(schema_errors(names, key, f"{path}.{key}(name)"))
            if key in properties:
                errors.extend(schema_errors(properties[key], item, f"{path}.{key}"))
            elif extra is False:
                errors.append(f"{path}: unexpected property {key!r}")
            elif isinstance(extra, dict):
                errors.extend(schema_errors(extra, item, f"{path}.{key}"))

    if isinstance(value, list):
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{path}: items are not unique")
        if "items" in schema:
            for index, item in enumerate(value):
                errors.extend(schema_errors(schema["items"], item, f"{path}[{index}]"))
    return errors


@lru_cache(maxsize=None)
def metadata_schema() -> dict:
    return json.loads(METADATA_SCHEMA.read_text())


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


def profiles(findings: list[dict]) -> dict[str, dict]:
    """Contract name -> hookrisk block of its hook-profile. Exactly one each."""
    out: dict[str, dict] = {}
    for finding in by_check(findings, "hookrisk-hook-profile"):
        name = anchor(finding)
        assert name not in out, f"two hook-profiles for {name}"
        out[name] = finding["hookrisk"]
    return out


class MetadataContract(unittest.TestCase):
    """The `hookrisk` block every finding carries, which the CLI parses."""

    def test_every_finding_carries_a_known_rule_class(self) -> None:
        for target in ("src/good", "src/bad", "src/legacy"):
            for finding in scan(target):
                meta = finding.get("hookrisk")
                self.assertIsNotNone(meta, f"{finding['check']} on {anchor(finding)} has no hookrisk block")
                self.assertIn(meta["ruleClass"], KNOWN_RULE_CLASSES)
                self.assertIsInstance(meta["isClassification"], bool)

    def test_every_block_validates_against_the_engine_metadata_schema(self) -> None:
        # The same schema the CLI enforces with Ajv. A block that fails here
        # would be dropped there with a log line, and the finding would vanish
        # from the report; this is where that drift is caught first.
        for target in ("src/good", "src/bad", "src/legacy"):
            for finding in scan(target):
                errors = schema_errors(metadata_schema(), finding["hookrisk"])
                self.assertEqual([], errors, f"{finding['check']} on {anchor(finding)}: {errors}")
                self.assertEqual("1", finding["hookrisk"]["version"])

    def test_the_schema_checker_rejects_what_the_cli_would_reject(self) -> None:
        good = {
            "version": "1",
            "ruleClass": "hook-profile",
            "informsDimensions": [],
            "informsTriggers": [],
            "isClassification": True,
            "metrics": {name: (0 if kind is int else False) for name, kind in PROFILE_METRICS.items()},
            "permissions": {"beforeSwap": True},
            "callbacks": ["beforeSwap"],
        }
        self.assertEqual([], schema_errors(metadata_schema(), good))
        cases = {
            "version drift": {**good, "version": "2"},
            "unknown class": {**good, "ruleClass": "made-up"},
            "missing required": {k: v for k, v in good.items() if k != "isClassification"},
            "extra key": {**good, "extra": 1},
            "bool as int": {**good, "metrics": {**good["metrics"], "usesReturnsDelta": 0}},
            "int as bool": {**good, "metrics": {**good["metrics"], "callbacksDeclared": True}},
            "negative metric": {**good, "metrics": {**good["metrics"], "callbacksDeclared": -1}},
            "missing metric": {**good, "metrics": {k: v for k, v in good["metrics"].items() if k != "callbacksDeclared"}},
            "unknown permission": {**good, "permissions": {"beforeSwapp": True}},
            "permission not bool": {**good, "permissions": {"beforeSwap": "yes"}},
            "unknown callback": {**good, "callbacks": ["beforeSwapReturnDelta"]},
            "duplicate callback": {**good, "callbacks": ["beforeSwap", "beforeSwap"]},
            "empty discriminator": {**good, "discriminator": ""},
        }
        for label, block in cases.items():
            self.assertNotEqual([], schema_errors(metadata_schema(), block), label)

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

    def test_admin_fixtures_stay_clean(self) -> None:
        # An admin surface is a profile metric, not a finding: the fixture
        # exists to exercise `hasOwnerOnlyFunctions` and must trip nothing.
        for check in ("hookrisk-unprotected-callback", "hookrisk-flag-divergence", "hookrisk-disabled-callback"):
            hits = [anchor(f) for f in by_check(scan("src/good"), check)]
            self.assertFalse([h for h in hits if "AdminHook" in h], f"{check} fired on {hits}")


class HookProfile(unittest.TestCase):
    """One `hookrisk-hook-profile` per recognised hook, with sane metrics."""

    GOOD = {
        "CleanHook",
        "IntentionalRevertHook",
        "ProductionAntiSandwichHook",
        "ProductionLimitOrderHook",
        "ProductionLiquidityPenaltyHook",
        "OwnableAdminHook",
        "HandRolledAdminHook",
    }
    BAD = {"UnvalidatedCallback", "DivergentHook", "OrphanDeltaHook"}

    def test_exactly_one_profile_per_hook_in_good_and_bad(self) -> None:
        self.assertEqual(self.GOOD, set(profiles(scan("src/good"))))
        self.assertEqual(self.BAD, set(profiles(scan("src/bad"))))

    def test_profiles_are_informational_classifications_anchored_on_the_contract(self) -> None:
        for target in ("src/good", "src/bad"):
            for finding in by_check(scan(target), "hookrisk-hook-profile"):
                self.assertEqual("Informational", finding["impact"], anchor(finding))
                self.assertEqual("contract", finding["elements"][0]["type"], anchor(finding))
                meta = finding["hookrisk"]
                self.assertTrue(meta["isClassification"])
                self.assertEqual("hook-profile", meta["ruleClass"])
                self.assertNotIn("discriminator", meta)
                for name, kind in PROFILE_METRICS.items():
                    self.assertIsInstance(meta["metrics"][name], kind, f"{anchor(finding)}.{name}")

    def test_clean_hook_metrics(self) -> None:
        meta = profiles(scan("src/good"))["CleanHook"]
        metrics = meta["metrics"]
        self.assertEqual(2, metrics["callbacksImplemented"])
        self.assertEqual(2, metrics["callbacksDeclared"])
        self.assertGreaterEqual(metrics["stateWritesInCallbacks"], 1)
        self.assertEqual(0, metrics["externalCallsInSwapPath"])
        self.assertFalse(metrics["usesReturnsDelta"])
        self.assertFalse(metrics["hasOwnerOnlyFunctions"])
        self.assertEqual(["afterSwap", "beforeSwap"], meta["callbacks"])
        # Every field of Hooks.Permissions, resolved, not just the true ones.
        self.assertEqual(14, len(meta["permissions"]))
        self.assertEqual({"beforeSwap", "afterSwap"}, {k for k, v in meta["permissions"].items() if v})

    def test_inherited_permissions_are_resolved(self) -> None:
        # The OpenZeppelin subclasses declare nothing themselves; the source
        # regex the CLI used to run found nothing on them. The profile follows
        # inheritance, which is the point of making it the source of truth.
        found = profiles(scan("src/good"))
        self.assertEqual(
            {"beforeSwap", "afterSwap", "afterSwapReturnDelta"},
            {k for k, v in found["ProductionAntiSandwichHook"]["permissions"].items() if v},
        )
        self.assertTrue(found["ProductionAntiSandwichHook"]["metrics"]["usesReturnsDelta"])
        self.assertTrue(found["ProductionLiquidityPenaltyHook"]["metrics"]["usesReturnsDelta"])

    def test_a_deliberate_revert_guard_is_not_an_implemented_callback(self) -> None:
        meta = profiles(scan("src/good"))["IntentionalRevertHook"]
        self.assertEqual([], meta["callbacks"])
        self.assertEqual(0, meta["metrics"]["callbacksImplemented"])
        self.assertEqual(1, meta["metrics"]["callbacksDeclared"])

    def test_owner_only_functions_in_both_shapes(self) -> None:
        found = profiles(scan("src/good"))
        self.assertTrue(found["OwnableAdminHook"]["metrics"]["hasOwnerOnlyFunctions"], "Ownable onlyOwner")
        self.assertTrue(found["HandRolledAdminHook"]["metrics"]["hasOwnerOnlyFunctions"], "require(msg.sender == admin)")
        for name in ("CleanHook", "ProductionLimitOrderHook", "IntentionalRevertHook"):
            self.assertFalse(found[name]["metrics"]["hasOwnerOnlyFunctions"], name)

    def test_hand_rolled_hook_without_permissions_has_none(self) -> None:
        meta = profiles(scan("src/bad"))["UnvalidatedCallback"]
        self.assertNotIn("permissions", meta)
        self.assertEqual(0, meta["metrics"]["callbacksDeclared"])
        self.assertEqual(3, meta["metrics"]["callbacksImplemented"])
        self.assertEqual(["afterSwap", "beforeAddLiquidity", "beforeSwap"], meta["callbacks"])

    def test_stub_is_not_implemented_but_override_is(self) -> None:
        meta = profiles(scan("src/bad"))["DivergentHook"]
        self.assertEqual(["afterSwap"], meta["callbacks"])
        self.assertEqual(1, meta["metrics"]["callbacksDeclared"])
        self.assertGreaterEqual(meta["metrics"]["stateWritesInCallbacks"], 1)

    def test_legacy_hooks_get_no_profile_except_the_partially_readable_one(self) -> None:
        # LegacyHook and LegacyAfterInitializeHook were never analysed and
        # must not claim otherwise. MixedAbiHook's current-ABI callbacks were,
        # so it carries a profile; its `partial` unsupported-ABI finding is
        # what revokes coverage in the CLI.
        self.assertEqual({"MixedAbiHook"}, set(profiles(scan("src/legacy"))))


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
        # Plus the hook-profile of the one partially readable contract; see
        # HookProfile.test_legacy_hooks_get_no_profile_except_the_partially_readable_one.
        findings = [f for f in scan("src/legacy") if f["check"] != "hookrisk-hook-profile"]
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
        [finding] = [
            f for f in scan("src/legacy") if anchor(f) == "MixedAbiHook" and f["check"] != "hookrisk-hook-profile"
        ]
        self.assertEqual("hookrisk-unsupported-abi", finding["check"])
        self.assertEqual("partial", finding["hookrisk"]["discriminator"])
        self.assertIn("beforeAddLiquidity", finding["description"])
        self.assertIn("did not judge", finding["description"])

    def test_hook_named_contract_without_hook_shape_is_left_alone(self) -> None:
        self.assertNotIn("HookRegistry", [anchor(f) for f in scan("src/legacy")])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(unittest.main())
