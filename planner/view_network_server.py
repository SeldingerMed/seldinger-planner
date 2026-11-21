"""Serves the view network's weights to the overlay studio.

One file, at one fixed place, with its size and SHA-256 fixed in
`model_assets`. The route takes no parameters: a request cannot name a file,
a hash or a version. The bytes are verified on every read, and the browser
checks them again before it parses them.

The weights are a research artifact, trained on synthetic projections of
artery masks released for academic research use. Serving them makes no claim
about what the network's proposals are worth.
"""

from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import Response

from planner.model_assets import VIEW_NETWORK, ModelArtifactError, verified_checkpoint

_REPO_ROOT = Path(__file__).resolve().parents[1]
VIEW_NETWORK_FILE = _REPO_ROOT / ".runtime" / "models" / "view-network-v1" / "view-network.bin"


def register_view_network_routes(app, *, path=None, expected=VIEW_NETWORK):
    """`path` and `expected` are for tests. A deployment passes neither."""

    @app.get("/api/view-network")
    def view_network():
        file = VIEW_NETWORK_FILE if path is None else path
        try:
            with verified_checkpoint(file, expected=expected) as stream:
                data = stream.read()
        except ModelArtifactError:
            # Absence is decided here, where the read failed, so a file that
            # went in the meantime is still an absence. A link in place of
            # the file is a fault, not an absence, even a link to nothing.
            if not file.is_symlink() and not file.exists():
                raise HTTPException(404, "View network is not installed") from None
            raise HTTPException(503, "View network failed integrity checks") from None
        except OSError:
            # The bytes could not be read to be verified, so none are served.
            raise HTTPException(503, "View network failed integrity checks") from None
        return Response(
            data,
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store", "X-View-Network-Sha256": expected.sha256},
        )
