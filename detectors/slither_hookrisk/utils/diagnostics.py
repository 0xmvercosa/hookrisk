"""Error catalogue loader, classifier and terminal formatter.

Every failure hookrisk reports goes through here. The point is that a user who
hits a problem gets three things in the same breath: what went wrong, why, and
what to type next. Raw tool output rarely provides the second and almost never
the third — the failure that motivated this module was crytic-compile aborting
with ``AssertionError: Contract IExttload not found`` when the real problem was a
``..`` in a Foundry ``libs`` entry, which no amount of staring at the message
would tell you.

The catalogue itself lives in ``errors/catalog.json`` at the repository root and
is shared verbatim with the TypeScript CLI, so the same failure reads the same
way whichever surface you hit it through.

Typical use::

    from slither_hookrisk.utils import diagnostics

    try:
        diagnostics.require_tool("forge", "HR-E001")
        out = diagnostics.run_checked(["forge", "build"])
    except diagnostics.HookriskError as exc:
        print(exc.render(), file=sys.stderr)
        raise SystemExit(exc.exit_code)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Sequence

__all__ = [
    "HookriskError",
    "ErrorSpec",
    "catalog",
    "spec_for",
    "classify",
    "raise_for_output",
    "require_tool",
    "run_checked",
    "supports_colour",
]

#: Exit status for a failure we could not map to a specific catalogue entry.
FALLBACK_CODE = "HR-E901"


# --------------------------------------------------------------------------- #
# Catalogue loading
# --------------------------------------------------------------------------- #


def _candidate_paths() -> Iterable[Path]:
    """Locations to search for catalog.json, most specific first.

    Two deployment shapes have to work. Installed as a wheel, the catalogue is
    copied into the package as data (``make build-detectors`` does this, so that
    a `pip install slither-hookrisk` is self-contained). Running from a source
    checkout, the package sits three levels below the repository root and the
    canonical file is the one under ``errors/``. Preferring the packaged copy
    means an installed plugin never silently reads a working tree it happens to
    be sitting next to.
    """
    here = Path(__file__).resolve()
    yield here.parent.parent / "data" / "catalog.json"
    # detectors/slither_hookrisk/utils/ -> repo root is three parents up.
    yield here.parents[3] / "errors" / "catalog.json"
    override = os.environ.get("HOOKRISK_ERROR_CATALOG")
    if override:
        yield Path(override)


@dataclass(frozen=True)
class ErrorSpec:
    """One catalogue entry, already compiled and ready to raise."""

    code: str
    title: str
    cause: str
    fix: tuple[str, ...]
    exit_code: int
    patterns: tuple[re.Pattern[str], ...] = field(default=())
    see_also: tuple[str, ...] = field(default=())

    def matches(self, text: str) -> bool:
        return any(p.search(text) for p in self.patterns)


@lru_cache(maxsize=1)
def catalog() -> dict[str, ErrorSpec]:
    """Parse and cache the error catalogue.

    Raises:
        RuntimeError: if no catalogue can be found. This is deliberately not a
            HookriskError — without the catalogue we cannot describe the failure
            in the catalogue's own terms, and pretending otherwise would recurse.
    """
    for path in _candidate_paths():
        if path and path.is_file():
            raw = json.loads(path.read_text())
            break
    else:
        searched = "\n  ".join(str(p) for p in _candidate_paths() if p)
        raise RuntimeError(
            "hookrisk error catalogue not found. Searched:\n  "
            f"{searched}\n"
            "Set HOOKRISK_ERROR_CATALOG to its location, or reinstall the "
            "package with `make build-detectors`."
        )

    specs: dict[str, ErrorSpec] = {}
    for entry in raw["errors"]:
        specs[entry["code"]] = ErrorSpec(
            code=entry["code"],
            title=entry["title"],
            cause=entry["cause"],
            fix=tuple(entry.get("fix", ())),
            exit_code=int(entry["exitCode"]),
            patterns=tuple(
                re.compile(p, re.IGNORECASE | re.MULTILINE)
                for p in entry.get("match", ())
            ),
            see_also=tuple(entry.get("seeAlso", ())),
        )
    return specs


def spec_for(code: str) -> ErrorSpec:
    """Look up one entry, falling back to the generic internal error."""
    specs = catalog()
    return specs.get(code) or specs[FALLBACK_CODE]


# --------------------------------------------------------------------------- #
# The exception
# --------------------------------------------------------------------------- #


class HookriskError(Exception):
    """A failure with a catalogue entry behind it.

    Carries everything needed to print an actionable message and to choose a
    process exit status that CI can branch on.
    """

    def __init__(
        self,
        code: str,
        *,
        detail: str | None = None,
        raw_output: str | None = None,
        context: dict[str, str] | None = None,
    ) -> None:
        self.spec = spec_for(code)
        self.code = self.spec.code
        self.detail = detail
        self.raw_output = raw_output
        self.context = context or {}
        super().__init__(f"[{self.code}] {self.spec.title}")

    @property
    def exit_code(self) -> int:
        return self.spec.exit_code

    def render(self, *, colour: bool | None = None) -> str:
        """Format for a terminal: title, cause, numbered fixes, then raw output.

        Raw tool output goes last and is truncated. It matters for debugging but
        it is the least useful thing on screen, and putting it first is how tools
        train users to ignore their own error messages.
        """
        if colour is None:
            colour = supports_colour()
        bold, dim, red, reset = ("\033[1m", "\033[2m", "\033[31m", "\033[0m") if colour else ("",) * 4

        lines = [f"{red}{bold}{self.code}{reset}{bold}  {self.spec.title}{reset}", ""]
        if self.detail:
            lines += [f"  {self.detail}", ""]
        lines += [f"  {dim}Why:{reset} {self.spec.cause}", ""]

        if self.spec.fix:
            lines.append(f"  {dim}Try:{reset}")
            lines += [f"    {i}. {step}" for i, step in enumerate(self.spec.fix, 1)]
            lines.append("")

        if self.context:
            width = max(len(k) for k in self.context)
            lines.append(f"  {dim}Context:{reset}")
            lines += [f"    {k.ljust(width)}  {v}" for k, v in self.context.items()]
            lines.append("")

        if self.spec.see_also:
            lines.append(f"  {dim}See also:{reset}")
            lines += [f"    {url}" for url in self.spec.see_also]
            lines.append("")

        if self.raw_output:
            trimmed = self.raw_output.strip().splitlines()
            shown = trimmed[-12:]
            elided = len(trimmed) - len(shown)
            lines.append(f"  {dim}Tool output{f' (last 12 of {len(trimmed)} lines)' if elided else ''}:{reset}")
            lines += [f"    {dim}{line}{reset}" for line in shown]
            lines.append("")

        lines.append(f"  {dim}Full reference: docs/TROUBLESHOOTING.md#{self.code.lower()}{reset}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #


def classify(text: str) -> ErrorSpec | None:
    """Map raw tool output onto a catalogue entry.

    Entries are tested in catalogue order, which is ordered from most specific to
    most general, so a message matching both a precise entry and a broad one gets
    the precise diagnosis.
    """
    if not text:
        return None
    for spec in catalog().values():
        if spec.patterns and spec.matches(text):
            return spec
    return None


def raise_for_output(text: str, *, default: str = FALLBACK_CODE, **kwargs) -> None:
    """Classify ``text`` and raise the matching HookriskError.

    Always raises. Use when a subprocess has already failed and its output is the
    only evidence available.
    """
    spec = classify(text)
    raise HookriskError(spec.code if spec else default, raw_output=text, **kwargs)


# --------------------------------------------------------------------------- #
# Process helpers
# --------------------------------------------------------------------------- #


def supports_colour() -> bool:
    """Colour only when a human is plausibly reading.

    Honours NO_COLOR (https://no-color.org) and FORCE_COLOR, and stays quiet when
    stderr is redirected — CI logs are grim enough without escape sequences.
    """
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    return sys.stderr.isatty()


def require_tool(name: str, code: str, *, min_version: str | None = None) -> str:
    """Assert an external tool is callable, returning its resolved path.

    Args:
        name: Executable to look for on PATH.
        code: Catalogue code to raise when it is missing.
        min_version: Optional lower bound, compared as a dotted release tuple
            against the first version-looking token in ``<name> --version``.

    Raises:
        HookriskError: if the tool is absent, or older than ``min_version``.
    """
    path = shutil.which(name)
    if path is None:
        raise HookriskError(code, detail=f"`{name}` was not found on PATH.")

    if min_version is None:
        return path

    try:
        out = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        # A tool that cannot report its version still works often enough that
        # refusing to run would be more annoying than the risk it protects from.
        return path

    found = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
    if found and _as_tuple(found.group(0)) < _as_tuple(min_version):
        raise HookriskError(
            code,
            detail=f"`{name}` is {found.group(0)}, but hookrisk needs {min_version} or newer.",
            context={"path": path},
        )
    return path


def _as_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def run_checked(
    cmd: Sequence[str],
    *,
    cwd: Path | str | None = None,
    timeout: int = 1800,
    env: dict[str, str] | None = None,
    expect_codes: Iterable[int] = (0,),
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess, converting failure into a diagnosed HookriskError.

    Args:
        cmd: Argument vector. Never a shell string — hook paths and contract
            names come from user input and would be an injection surface.
        cwd: Working directory.
        timeout: Wall-clock seconds before the child is killed.
        env: Extra environment variables, merged over the current environment.
        expect_codes: Exit statuses treated as success. Slither, for instance,
            exits non-zero when it merely *found* something.

    Raises:
        HookriskError: classified from the child's combined output.
    """
    merged = {**os.environ, **(env or {})}
    try:
        proc = subprocess.run(
            list(cmd),
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=merged,
        )
    except FileNotFoundError as exc:
        raise HookriskError(
            FALLBACK_CODE,
            detail=f"Could not execute `{cmd[0]}`.",
            raw_output=str(exc),
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise HookriskError(
            "HR-E303",
            detail=f"`{' '.join(cmd[:3])}...` exceeded {timeout}s.",
            raw_output=(exc.stdout or "") if isinstance(exc.stdout, str) else "",
            context={"timeout": f"{timeout}s", "cwd": str(cwd or Path.cwd())},
        ) from exc

    if proc.returncode not in set(expect_codes):
        combined = f"{proc.stdout}\n{proc.stderr}"
        spec = classify(combined)
        raise HookriskError(
            spec.code if spec else FALLBACK_CODE,
            detail=f"`{' '.join(cmd[:4])}...` exited {proc.returncode}.",
            raw_output=combined,
            context={"cwd": str(cwd or Path.cwd()), "exit": str(proc.returncode)},
        )
    return proc
