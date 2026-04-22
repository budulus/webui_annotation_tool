# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "fastapi",
#     "uvicorn[standard]",
#     "pillow",
# ]
# ///
"""Rapid mask annotation tool — FastAPI backend.

Run with uv:
    DATASET=/path/to/dataset uv run server.py
or:
    uv run server.py --dataset /path/to/dataset --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
STATIC_DIR = SCRIPT_DIR / "static"
EXCLUDE_SUFFIX = "_exclude"


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def safe_name(filename: str) -> str:
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="invalid filename")
    return filename


def is_excluded(name: str) -> bool:
    return Path(name).stem.endswith(EXCLUDE_SUFFIX)


def with_exclude(name: str, exclude: bool) -> str:
    p = Path(name)
    stem = p.stem
    already = stem.endswith(EXCLUDE_SUFFIX)
    if exclude and not already:
        return f"{stem}{EXCLUDE_SUFFIX}{p.suffix}"
    if not exclude and already:
        return f"{stem[: -len(EXCLUDE_SUFFIX)]}{p.suffix}"
    return name


def make_app(dataset: Path) -> FastAPI:
    images_dir = dataset / "images"
    masks_dir = dataset / "masks"
    if not images_dir.is_dir() or not masks_dir.is_dir():
        raise SystemExit(
            f"Dataset at {dataset} must contain 'images/' and 'masks/' subdirectories."
        )

    app = FastAPI()
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/manifest.json")
    def manifest():
        return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")

    @app.get("/api/list")
    def list_files():
        image_names = {p.name for p in images_dir.iterdir() if p.is_file()}
        mask_names = {p.name for p in masks_dir.iterdir() if p.is_file()}
        both = sorted(image_names & mask_names, key=natural_key)
        return JSONResponse(both)

    @app.get("/api/image/{filename}")
    def get_image(filename: str):
        name = safe_name(filename)
        path = images_dir / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="image not found")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/mask/{filename}")
    def get_mask(filename: str):
        name = safe_name(filename)
        path = masks_dir / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="mask not found")
        return FileResponse(path, media_type="image/png")

    @app.post("/api/mask/{filename}")
    async def post_mask(filename: str, request: Request):
        name = safe_name(filename)
        image_path = images_dir / name
        mask_path = masks_dir / name
        if not image_path.is_file():
            raise HTTPException(status_code=404, detail="source image not found")

        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="empty body")

        try:
            incoming = Image.open(io.BytesIO(body))
            incoming.load()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid PNG")

        with Image.open(image_path) as src:
            if incoming.size != src.size:
                raise HTTPException(
                    status_code=400,
                    detail=f"dimension mismatch: got {incoming.size}, expected {src.size}",
                )

        mask_l = incoming.convert("L")
        tmp_path = mask_path.with_suffix(mask_path.suffix + ".tmp")
        try:
            mask_l.save(tmp_path, format="PNG", optimize=False)
            os.replace(tmp_path, mask_path)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        return {"ok": True}

    @app.post("/api/exclude/{filename}")
    async def post_exclude(filename: str, request: Request):
        name = safe_name(filename)
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")
        if not isinstance(payload, dict) or "exclude" not in payload:
            raise HTTPException(status_code=400, detail="missing 'exclude' field")
        want_exclude = bool(payload["exclude"])

        target = with_exclude(name, want_exclude)
        if target == name:
            return {"ok": True, "filename": name}

        src_image = images_dir / name
        src_mask = masks_dir / name
        dst_image = images_dir / target
        dst_mask = masks_dir / target

        if not src_image.is_file() or not src_mask.is_file():
            raise HTTPException(status_code=404, detail="source pair not found")
        if dst_image.exists() or dst_mask.exists():
            raise HTTPException(
                status_code=409,
                detail=f"target '{target}' already exists",
            )

        os.replace(src_image, dst_image)
        try:
            os.replace(src_mask, dst_mask)
        except OSError as e:
            try:
                os.replace(dst_image, src_image)
            except OSError:
                pass
            raise HTTPException(
                status_code=500,
                detail=f"mask rename failed: {e}",
            )

        return {"ok": True, "filename": target}

    return app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Rapid mask annotation tool")
    ap.add_argument(
        "--dataset",
        default=os.environ.get("DATASET"),
        help="Path to dataset directory containing images/ and masks/",
    )
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)
    if not args.dataset:
        ap.error("Dataset path required via --dataset or DATASET env var")
    args.dataset = Path(args.dataset).expanduser().resolve()
    return args


if __name__ == "__main__":
    args = parse_args()
    app = make_app(args.dataset)
    print(f"Serving {args.dataset} on http://{args.host}:{args.port}", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port)
