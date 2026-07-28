# hookrisk — one entry point per thing you might want to do.
#
# `make` on its own prints the targets. Every error message in
# errors/catalog.json that tells you to run something tells you to run one of
# these, so they are part of the interface rather than a convenience.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Prefer the repo-local virtualenv when it exists, so a contributor who ran
# `make venv` does not also have to remember to activate it.
VENV      := .venv
PYTHON    := $(shell [ -x $(VENV)/bin/python ] && echo $(VENV)/bin/python || echo python3)
PIP       := $(shell [ -x $(VENV)/bin/pip ] && echo $(VENV)/bin/pip || echo pip3)
SLITHER   := $(shell [ -x $(VENV)/bin/slither ] && echo $(VENV)/bin/slither || echo slither)

DETECTOR_ARGS := hookrisk-unprotected-callback,hookrisk-flag-divergence,hookrisk-custom-accounting

.PHONY: help
help: ## Show this help
	@echo "hookrisk"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2}'
	@echo

# --------------------------------------------------------------------------- #
# Setup
# --------------------------------------------------------------------------- #

.PHONY: setup
setup: venv deps install-detectors install-cli ## Everything needed to work on hookrisk
	@echo
	@./scripts/doctor.sh

.PHONY: venv
venv: ## Create the Python virtualenv
	@[ -d $(VENV) ] || python3 -m venv $(VENV)
	@$(VENV)/bin/pip install -q --upgrade pip
	@$(VENV)/bin/pip install -q 'slither-analyzer>=0.11.5,<0.12'
	@echo "venv ready: $$($(VENV)/bin/slither --version)"

.PHONY: deps
deps: ## Materialise pinned Solidity dependencies (harness/deps.lock)
	@./scripts/fetch-deps.sh

.PHONY: install-detectors
install-detectors: ## Install the Slither plugin into the active environment
	@$(PIP) install -q -e ./detectors
	@$(SLITHER) --list-detectors 2>/dev/null | grep -q 'hookrisk-' \
		&& echo "detectors registered" \
		|| { echo "detectors NOT registered — see HR-E004 in docs/TROUBLESHOOTING.md"; exit 1; }

.PHONY: install-cli
install-cli: ## Build the TypeScript CLI
	@cd cli && npm install --silent && npm run --silent build
	@echo "cli built: $$(node cli/dist/cli.js --version)"

.PHONY: doctor
doctor: ## Check what this environment can and cannot do
	@./scripts/doctor.sh

# --------------------------------------------------------------------------- #
# Generated files
# --------------------------------------------------------------------------- #

.PHONY: spec
spec: ## Regenerate hooks_spec.py from the pinned v4-core
	@$(PYTHON) scripts/gen_hooks_spec.py --core harness/lib/v4-core

.PHONY: docs
docs: ## Regenerate docs/TROUBLESHOOTING.md from errors/catalog.json
	@$(PYTHON) scripts/gen_error_docs.py

.PHONY: check-generated
check-generated: ## Fail if any generated file is stale
	@$(PYTHON) scripts/gen_hooks_spec.py --core harness/lib/v4-core --check
	@$(PYTHON) scripts/gen_error_docs.py --check

# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

.PHONY: test
test: test-harness test-cli test-corpus ## Run everything

.PHONY: test-harness
test-harness: ## Foundry: spec cross-check, invariants, planted-bug detection
	@cd harness && FOUNDRY_PROFILE=scan forge test

.PHONY: test-cli
test-cli: ## TypeScript: engines, scoring, config
	@cd cli && npm run --silent test

.PHONY: test-corpus
test-corpus: ## Detectors must fire on corpus/src/bad and stay silent on corpus/src/good
	@echo "--- corpus/src/bad (must fire) ---"
	@cd corpus && $(abspath $(SLITHER)) src/bad --detect $(DETECTOR_ARGS) --exclude-dependencies 2>&1 \
		| grep -E 'result\(s\) found' \
		| grep -qv '^INFO:Slither:. analyzed .* 0 result' \
		|| { echo "FAIL: detectors found nothing in the positive corpus"; exit 1; }
	@echo "--- corpus/src/good (must be silent) ---"
	@cd corpus && $(abspath $(SLITHER)) src/good --detect $(DETECTOR_ARGS) --exclude-dependencies 2>&1 \
		| grep -qE '0 result\(s\) found' \
		|| { echo "FAIL: false positive on the negative corpus"; exit 1; }
	@echo "corpus gates passed"

.PHONY: deep
deep: ## Overnight invariant run (5000 sequences, depth 128)
	@cd harness && FOUNDRY_PROFILE=deep forge test --match-contract Invariants

# --------------------------------------------------------------------------- #
# Demo
# --------------------------------------------------------------------------- #

.PHONY: demo
demo: ## Scan a clean hook and a hook with a planted bug, end to end
	@echo "=============================================================="
	@echo " 1. A correct hook: no findings, invariants hold"
	@echo "=============================================================="
	@cd corpus && HOOKRISK_SLITHER_BIN=$(abspath $(SLITHER)) \
		node ../cli/dist/cli.js scan src/good/CleanHook.sol:CleanHook --no-gate || true
	@echo
	@echo "=============================================================="
	@echo " 2. A hook that charges 3.5% while documenting 1%"
	@echo "    Structurally flawless. Only execution can see it."
	@echo "=============================================================="
	@cd harness && forge build >/dev/null 2>&1 && HOOKRISK_SLITHER_BIN=$(abspath $(SLITHER)) \
		node ../cli/dist/cli.js scan src/hooks/FeeHooks.sol:SkimmingFeeHook --skip-static; \
		echo "exit code: $$? (2 = gate failed)"

.PHONY: clean
clean: ## Remove build output, keep dependencies
	@rm -rf cli/dist harness/out harness/cache corpus/out corpus/cache
	@rm -f harness/hook-risk.json harness/HOOK_RISK.md harness/hookrisk.sarif
	@rm -f corpus/hook-risk.json corpus/HOOK_RISK.md corpus/hookrisk.sarif
	@echo "cleaned"
