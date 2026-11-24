#!/usr/bin/env python3
"""A virtual X-ray of a CT at a known pose, as a calibrated DICOM XA frame.

The engineering control for the abdominal line-up: the frame is computed
from the very scan the studio loads, through the studio's own C-arm
convention (``planner.carm_geometry``), with the scan first moved by a known
rigid ``volume_to_carm_ras`` matrix. A line-up that starts from the scan as it
lies should then find that matrix; the vessels, which the bone line-up does
not look at, are scored against it afterwards.

Each detector pixel is a ray from the source to the pixel's centre. The CT
is sampled every ``step`` mm along it with trilinear interpolation, turned
into attenuation (water 0.02 per mm, air 0), and the frame records what
reaches the detector, so bone and contrast read dark, as a detector reads
them. Numpy only, so it runs in the ingest runtime beside pydicom.

  python3 scripts/research/ram_only.py /Volumes/SeldingerRAM -- \\
      .runtime/ingest-runtime/bin/python scripts/research/virtual_xray.py \\
      CT.nii.gz SPEC.json OUT.dcm

SPEC holds ``view`` (the six numbers of ``planner.carm_geometry``),
``isocenter`` (RAS mm), ``volume_to_carm_ras`` (4 x 4), ``columns``, ``rows``
and optionally ``step_mm``. A record of the frame (its SHA-256 and the spec)
goes to stdout.
"""

import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from planner.carm_geometry import camera, validate_view

MU_WATER_PER_MM = 0.02
XA_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.12.1"
UID_ROOT = "2.25."
MAX_SIDE = 1024
_CHUNK_RAYS = 4096


def _rigid(matrix):
    import numpy as np

    m = np.asarray(matrix, dtype=float)
    if m.shape != (4, 4) or not np.allclose(m[3], [0, 0, 0, 1]):
        raise ValueError("volume_to_carm_ras must be a 4 x 4 rigid matrix")
    r = m[:3, :3]
    if not np.allclose(r @ r.T, np.eye(3), atol=1e-6) or np.linalg.det(r) <= 0:
        raise ValueError("volume_to_carm_ras must be a 4 x 4 rigid matrix")
    return m


def pixel_centres_mm(view, columns, rows):
    """Detector (right, up) millimetres of each pixel centre, rows from the
    top, as ``detectorToPixel`` in ``web/src/carmProjection.ts`` places them."""
    import numpy as np

    x = ((np.arange(columns) + 0.5) / columns - 0.5) * view["detector_width_mm"]
    y = (0.5 - (np.arange(rows) + 0.5) / rows) * view["detector_height_mm"]
    return np.meshgrid(x, y)


def trilinear(volume, index):
    """Values of ``volume`` at fractional voxel ``index`` (n x 3); -1000
    outside the volume."""
    import numpy as np

    base = np.floor(index).astype(np.int64)
    frac = index - base
    shape = np.array(volume.shape)
    out = np.zeros(len(index))
    weight_inside = np.zeros(len(index))
    for corner in range(8):
        offset = np.array([(corner >> k) & 1 for k in range(3)])
        at = base + offset
        w = np.prod(np.where(offset, frac, 1.0 - frac), axis=1)
        inside = ((at >= 0) & (at < shape)).all(axis=1)
        value = np.full(len(index), -1000.0)
        value[inside] = volume[tuple(at[inside].T)]
        out += w * value
        weight_inside += w * inside
    return np.where(weight_inside > 0, out, -1000.0)


def render(volume_hu, affine, view, isocenter, volume_to_carm_ras, columns, rows, step_mm=1.0):
    """Transmitted fraction per pixel (rows x columns), the scan moved by
    ``volume_to_carm_ras`` and seen through ``camera(view, isocenter)``."""
    import numpy as np

    view = validate_view(view)
    if not (16 <= columns <= MAX_SIDE and 16 <= rows <= MAX_SIDE):
        raise ValueError("Frame side out of range")
    if not 0.1 <= step_mm <= 5.0:
        raise ValueError("Step out of range")
    cam = camera(view, [float(c) for c in isocenter])
    u, v, d = (np.asarray(cam[k], dtype=float) for k in ("u", "v", "d"))
    source = np.asarray(cam["source"], dtype=float)
    sid = cam["source_detector_mm"]
    m = _rigid(volume_to_carm_ras)
    # C-arm point -> volume voxel: inverse of the move, then of the affine.
    to_voxel = np.linalg.inv(np.asarray(affine, dtype=float)) @ np.linalg.inv(m)
    # Depths that can cross the scan: its corners, moved, along the beam.
    shape = np.array(volume_hu.shape) - 1
    corners = np.array(
        [[i, j, k] for i in (0, shape[0]) for j in (0, shape[1]) for k in (0, shape[2])]
    )
    world = (m @ np.asarray(affine, dtype=float) @ np.c_[corners, np.ones(8)].T)[:3].T
    depth = (world - source) @ d
    near, far = max(1.0, depth.min()), min(sid - 1.0, depth.max())
    if far <= near:
        raise ValueError("The scan is not between the source and the detector")
    x, y = pixel_centres_mm(view, columns, rows)
    targets = source + sid * d + x.reshape(-1, 1) * u + y.reshape(-1, 1) * v
    directions = targets - source
    directions /= np.linalg.norm(directions, axis=1, keepdims=True)
    # Along each ray, the distance to depth t along the beam is t / cos.
    cos = directions @ d
    out = np.empty(len(targets))
    samples = np.arange(near, far, step_mm)
    data = np.asarray(volume_hu, dtype=np.float32)
    for start in range(0, len(targets), _CHUNK_RAYS):
        stop = min(len(targets), start + _CHUNK_RAYS)
        along = samples[None, :] / cos[start:stop, None]
        points = source + directions[start:stop, None, :] * along[..., None]
        flat = points.reshape(-1, 3)
        index = flat @ to_voxel[:3, :3].T + to_voxel[:3, 3]
        hu = trilinear(data, index).reshape(stop - start, len(samples))
        mu = np.clip(1.0 + hu / 1000.0, 0.0, None) * MU_WATER_PER_MM
        out[start:stop] = mu.sum(axis=1) * step_mm / cos[start:stop]
    return np.exp(-out).reshape(rows, columns)


def _uid(seed: str) -> str:
    return UID_ROOT + str(int(hashlib.sha256(seed.encode()).hexdigest()[:30], 16))


def detector_pixels(image):
    """A log-processed detector image of the transmitted fraction: the line
    integral, inverted so that larger is brighter, scaled to 12 bits with
    its 99.5th percentile at black, as a detector's log look-up table
    would."""
    import numpy as np

    line = -np.log(np.clip(image, 1e-12, 1.0))
    top = max(float(np.percentile(line, 99.5)), 1e-6)
    return np.rint((1.0 - np.clip(line / top, 0, 1)) * 4095).astype(np.uint16)


def admitted_gray8(pixels):
    """The 8-bit frame the frame admission command keeps from one stored
    frame: one linear scale from its least to its largest value
    (``planner.frame_ingest``)."""
    import numpy as np

    values = np.asarray(pixels, dtype=np.float64)
    low, high = float(values.min()), float(values.max())
    span = high - low or 1.0
    return np.rint((values - low) * (255.0 / span)).astype(np.uint8)


def xa_dicom(image, view, seed: str) -> bytes:
    """One uncompressed single-frame XA object with the view's geometry,
    16-bit MONOCHROME2, log-processed (larger is brighter: less attenuation)."""
    import io

    import pydicom
    from pydicom.dataset import FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian

    view = validate_view(view)
    rows, columns = image.shape
    if not math.isclose(
        view["detector_width_mm"] / columns, view["detector_height_mm"] / rows, rel_tol=1e-9
    ):
        raise ValueError("Detector pixels must be square")
    pixels = detector_pixels(image)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = XA_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = _uid(seed + ":instance")
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = pydicom.Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = XA_SOP_CLASS
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = _uid(seed + ":study")
    ds.SeriesInstanceUID = _uid(seed + ":series")
    ds.Modality = "XA"
    ds.ImageType = ["DERIVED", "SECONDARY"]
    ds.SeriesDescription = "Virtual X-ray, engineering control"
    ds.BurnedInAnnotation = "NO"
    ds.PositionerMotion = "STATIC"
    ds.PositionerPrimaryAngle = f"{view['primary_deg']:.6g}"
    ds.PositionerSecondaryAngle = f"{view['secondary_deg']:.6g}"
    ds.DistanceSourceToDetector = f"{view['source_detector_mm']:.6g}"
    ds.DistanceSourceToPatient = f"{view['source_isocenter_mm']:.6g}"
    spacing = view["detector_width_mm"] / columns
    ds.ImagerPixelSpacing = [f"{spacing:.10g}", f"{spacing:.10g}"]
    ds.Rows, ds.Columns = rows, columns
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
    ds.PixelRepresentation = 0
    ds.PixelData = pixels.tobytes()
    buffer = io.BytesIO()
    ds.save_as(buffer, enforce_file_format=True)
    return buffer.getvalue()


def main(argv=None) -> int:
    import nibabel as nib
    import numpy as np

    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    ct_path, spec_path, out_path = (Path(a) for a in argv)
    if out_path.exists():
        raise SystemExit("Output exists")
    ct_bytes = ct_path.read_bytes()
    spec = json.loads(spec_path.read_text())
    image = nib.Nifti1Image.from_bytes(
        __import__("gzip").decompress(ct_bytes) if ct_bytes[:2] == b"\x1f\x8b" else ct_bytes
    )
    volume = np.asanyarray(image.dataobj)
    frame = render(
        volume,
        image.affine,
        spec["view"],
        spec["isocenter"],
        spec["volume_to_carm_ras"],
        spec["columns"],
        spec["rows"],
        spec.get("step_mm", 1.0),
    )
    ct_sha = hashlib.sha256(ct_bytes).hexdigest()
    data = xa_dicom(frame, spec["view"], seed=ct_sha + json.dumps(spec, sort_keys=True))
    with out_path.open("xb") as stream:
        stream.write(data)
    print(
        json.dumps(
            {
                "ct_sha256": ct_sha,
                "frame_sha256": hashlib.sha256(data).hexdigest(),
                "spec": spec,
                "method": "virtual_xray_trilinear_v1",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
