SHELL := /bin/bash

ROOT := $(CURDIR)
EXT_DIR := $(ROOT)/extension
REPLAYER_DIR := $(ROOT)/replayer
MODAL_OCR_DIR := $(ROOT)/modal_ocr
UV := $(shell command -v uv 2>/dev/null || echo $$HOME/.local/bin/uv)

## help: Show this help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t- /'

## init: Install pnpm deps and create uv venvs with editable installs
init:
	# Ensure pnpm via corepack
	@if ! command -v corepack >/dev/null 2>&1; then echo "corepack not found. Install Node.js >= 18"; fi
	@corepack enable || true
	@corepack prepare pnpm@latest --activate || true
	@pnpm install
	@[ -d "$(EXT_DIR)" ] && pnpm -C $(EXT_DIR) install || true
	# Ensure uv
	@if ! command -v uv >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh -s -- -y; fi
	# Python: replayer
	@mkdir -p $(REPLAYER_DIR)
	@cd $(REPLAYER_DIR) && \
		"$(UV)" venv .venv && \
		"$(UV)" pip install -p .venv/bin/python -U pip setuptools wheel && \
		"$(UV)" pip install -p .venv/bin/python -e .
	# Python: modal_ocr
	@mkdir -p $(MODAL_OCR_DIR)
	@cd $(MODAL_OCR_DIR) && \
		"$(UV)" venv .venv && \
		"$(UV)" pip install -p .venv/bin/python -U pip setuptools wheel && \
		"$(UV)" pip install -p .venv/bin/python -e .

## build: Build extension and verify Python packages import
build:
	@pnpm -C $(EXT_DIR) build
	@$(REPLAYER_DIR)/.venv/bin/python -c "import replayer; print('replayer import ok')"
	@$(MODAL_OCR_DIR)/.venv/bin/python -c "import modal_ocr; print('modal_ocr import ok')"

## clean: Remove build artifacts and virtualenvs
clean:
	@rm -rf node_modules pnpm-lock.yaml
	@rm -rf $(EXT_DIR)/node_modules $(EXT_DIR)/dist
	@rm -rf $(REPLAYER_DIR)/.venv $(MODAL_OCR_DIR)/.venv

## smoke: Print tool versions
smoke:
	@echo "node   : $$(node -v 2>/dev/null || echo 'not found')"
	@echo "pnpm   : $$(pnpm -v 2>/dev/null || echo 'not found')"
	@echo "uv     : $$($(UV) --version 2>/dev/null || echo 'not found')"
	@echo "python (replayer): $$( ($(REPLAYER_DIR)/.venv/bin/python --version) 2>/dev/null || echo 'not found')"
	@echo "python (modal_ocr): $$( ($(MODAL_OCR_DIR)/.venv/bin/python --version) 2>/dev/null || echo 'not found')"
