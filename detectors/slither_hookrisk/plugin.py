"""Slither plugin entry point.

Slither discovers detectors through the ``slither_analyzer.plugin`` entry point
declared in pyproject.toml. It calls ``make_plugin()`` and expects a pair of
lists: detector classes and printer classes.

Registering here rather than by directory scan is deliberate — a detector that
is written but not listed does not silently ship, and the order of this list is
the order findings appear.
"""

from __future__ import annotations

from typing import Type

from slither.detectors.abstract_detector import AbstractDetector
from slither.printers.abstract_printer import AbstractPrinter

from .detectors.hs01_unprotected_callback import UnprotectedHookCallback
from .detectors.hs02_flag_divergence import (
    CustomAccountingDeclared,
    FlagImplementationDivergence,
)

#: Every detector, most severe class first.
DETECTORS: list[Type[AbstractDetector]] = [
    UnprotectedHookCallback,
    FlagImplementationDivergence,
    CustomAccountingDeclared,
]

PRINTERS: list[Type[AbstractPrinter]] = []


def make_plugin() -> tuple[list[Type[AbstractDetector]], list[Type[AbstractPrinter]]]:
    """Return the detectors and printers this plugin provides."""
    return DETECTORS, PRINTERS
