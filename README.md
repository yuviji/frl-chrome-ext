## FRL Chrome Extension Monorepo

Monorepo managed with pnpm (Node) and uv (Python).

### Quickstart

- Install prerequisites: recent Node (>=18), corepack, curl

```bash
make init
```

- Build extension and validate Python imports

```bash
make build
```

- Smoke test tool versions

```bash
make smoke
```

- Clean build artifacts

```bash
make clean
```

### Workspaces

- `extension/`: MV3 extension (skeleton build)
- `replayer/`: Python package (uv venv, editable install)
- `modal_ocr/`: Python package (uv venv, editable install)
- `examples/`: sample traces and data
- `scripts/`: JS utilities (pnpm workspace)
