#!/usr/bin/env python3
"""The studio, served whole from a RAM disk, for the line-up control.

The unchanged application (``planner.server.build_app``) with every store it
writes or reads placed under ROOT: the case database, references, inference
results, installed image sources (``ROOT/installed-sources``) and admitted
frames (``ROOT/installed-frames``). The built web client in ROOT/web is served
beside the API on 127.0.0.1:8765, one of the studio's own allowed origins.
Run inside ``ram_only.py`` with ROOT on the RAM disk; nothing under the
repository's ``.runtime`` is read or written.

  python3 scripts/research/ram_only.py /Volumes/SeldingerRAM -- \\
      .venv/bin/python scripts/research/control_server.py /Volumes/SeldingerRAM/control
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

PORT = 8765


def build(root: Path):
    from fastapi.staticfiles import StaticFiles

    from planner import image_source
    from planner.frame_source import InstalledFrameStore
    from planner.projection_source import InstalledProjectionStore
    from planner.server import build_app

    root = root.resolve()
    for name in ("installed-sources", "installed-frames", "installed-projections"):
        (root / name).mkdir(mode=0o700, exist_ok=True)
    # The registry reads this module attribute when it first resolves an
    # installed source.
    image_source.INSTALLED_SOURCES_ROOT = root / "installed-sources"
    database = root / "workspace.sqlite3"
    database.touch(mode=0o600, exist_ok=True)
    app = build_app(
        database,
        sample_dir=root / "approved-public-sample",
        reference_dir=root / "public-reference",
        inference_results_dir=root / "inference-results",
        projection_series_store=InstalledProjectionStore(root / "installed-projections"),
        projection_frame_store=InstalledFrameStore(root / "installed-frames"),
    )
    app.mount("/", StaticFiles(directory=root / "web", html=True), name="web")
    return app


def main(argv=None) -> int:
    import uvicorn

    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    uvicorn.run(build(Path(argv[0])), host="127.0.0.1", port=PORT, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
