# Rapid Mask Annotator

Install [`uv`](https://docs.astral.sh/uv/), then from this directory point the tool at a dataset folder containing `images/` and `masks/` subfolders (matching filenames, matching dimensions, masks single-channel PNGs with 0 = background and 255 = foreground):

```
uv run server.py --dataset C:/path/to/dataset
```

Works identically in PowerShell, cmd.exe, and bash. If you'd rather use an env var, the equivalents are:

- **PowerShell**: `$env:DATASET="C:/path/to/dataset"; uv run server.py`
- **cmd.exe**:    `set DATASET=C:\path\to\dataset && uv run server.py`
- **bash / zsh**: `DATASET=/path/to/dataset uv run server.py`

Then open `http://<host>:8000` in a browser. Optional flags: `--host` (default `0.0.0.0`), `--port` (default `8000`). `uv` resolves dependencies (`fastapi`, `uvicorn`, `pillow`) automatically from the PEP 723 header in `server.py` — no `requirements.txt`, no venv setup, no build step. If `uv` errors about hardlinks on this Dropbox-synced path, prepend `UV_LINK_MODE=copy` (bash) / `$env:UV_LINK_MODE="copy";` (PowerShell).

Keybinds: `←`/`→` save-and-navigate (wraps), `e` brush/eraser, `[`/`]` brush size, `z` undo, `i` invert display, `+`/`-` opacity.
