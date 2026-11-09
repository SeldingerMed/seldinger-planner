"""Deterministic anatomy-to-geometry operator-input proposals.

Derives an editable ``OperatorGeometryInputs``-shaped proposal (neck plane,
interior seed, nearby parent-vessel path) from the accepted vessel and
aneurysm binary masks plus the RAS-mm affine. The proposal is a numerical
starting point only: it is never a validated clinical measurement, it is
returned with ``operator_confirmation_required=True``, and the caller (the
parent worker/API) owns source, mask and identity binding. Optional imaging
imports stay lazy so lightweight consumers can import this module without
NumPy.
"""

from typing import Any, cast

MAX_GRID_VOXELS = 8_000_000  # bounded per-mask proposal support
MIN_INTERFACE_VOXELS = 3  # a neck plane needs a disc, not a point or edge
MAX_INTERFACE_VOXELS = 100_000  # bounded interface estimation budget

_METHOD = "accepted_mask_anatomy_geometry_proposal"


def propose_aneurysm_inputs(
    vessel_mask,
    aneurysm_mask,
    affine_ras,
    *,
    spatial_units,
    target_ras=None,
):
    """Propose deterministic editable geometry inputs for one aneurysm sac.

    Uses one selected connected aneurysm component: the component containing
    ``target_ras`` when given (it must round onto aneurysm foreground), or the
    only component when the mask has exactly one. Multiple components without
    an explicit target are ambiguous and rejected rather than silently chosen.

    Returns ``{inputs, diagnostics, method, operator_confirmation_required}``
    where ``inputs`` matches the existing ``OperatorGeometryInputs`` shape:
    ``neck_origin`` (interface centroid), ``neck_normal`` (unit, outward to
    the sac), ``aneurysm_seed`` (deepest interior sac voxel), ``parent_path``
    plus interior ``proximal_index``/``distal_index`` from the existing
    ``propose_centerline`` between the two farthest interface vessel voxels.
    """
    import numpy as np
    from scipy import ndimage

    if spatial_units != "mm":
        raise ValueError("spatial_units must be explicitly 'mm' for RAS proposals")
    aff = np.asarray(affine_ras, dtype=float)
    if (
        aff.shape != (4, 4)
        or not np.isfinite(aff).all()
        or not np.array_equal(aff[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous RAS affine")
    determinant = float(np.linalg.det(aff))
    if not np.isfinite(determinant) or abs(determinant) < 1e-12:
        raise ValueError("Invalid singular or non-finite RAS affine")
    basis = aff[:3, :3]
    lengths = np.linalg.norm(basis, axis=0)
    gram = basis.T @ basis
    if (
        not np.isfinite(lengths).all()
        or np.any(lengths <= 0)
        or not np.allclose(gram / np.outer(lengths, lengths), np.eye(3), rtol=0, atol=1e-6)
    ):
        raise ValueError("Physical-distance proposals require orthogonal source axes")
    inverse = np.linalg.inv(aff)

    def load_binary(mask, label):
        array = np.asarray(mask)
        if array.ndim != 3:
            raise ValueError(f"{label} mask must be a three-dimensional grid")
        if array.size > MAX_GRID_VOXELS:
            raise ValueError(f"{label} mask exceeds the grid size bound")
        if array.dtype.kind not in "biuf" or not np.all((array == 0) | (array == 1)):
            raise ValueError(f"{label} mask must be binary with values 0 or 1")
        return array == 1

    vessel = load_binary(vessel_mask, "Vessel")
    aneurysm = load_binary(aneurysm_mask, "Aneurysm")
    if vessel.shape != aneurysm.shape:
        raise ValueError("Vessel and aneurysm masks must share one grid")
    if not vessel.any():
        raise ValueError("Vessel mask is empty")
    if not aneurysm.any():
        raise ValueError("Aneurysm mask is empty")

    structure = ndimage.generate_binary_structure(3, 1)
    component_labels, count = cast(
        tuple[np.ndarray, int], ndimage.label(aneurysm, structure=structure)
    )

    def point_index(point, label):
        p = np.asarray(point, dtype=float)
        if p.shape != (3,) or not np.isfinite(p).all():
            raise ValueError(f"Operator {label} must have three finite coordinates")
        native = (inverse @ np.r_[p, 1.0])[:3]
        if any(v < 0 or v > n - 1 for v, n in zip(native, aneurysm.shape, strict=True)):
            raise ValueError(f"Operator {label} is outside the installed image")
        return tuple(round(float(v)) for v in native)  # ties to even

    if target_ras is not None:
        target_idx = point_index(target_ras, "target")
        if not aneurysm[target_idx]:
            raise ValueError("Operator target must round onto aneurysm foreground")
        component = int(component_labels[target_idx])
        selected_by_target = True
    else:
        if count != 1:
            raise ValueError(
                "Aneurysm mask has multiple connected components; an explicit "
                "operator target is required instead of a silent choice"
            )
        component = 1
        selected_by_target = False

    sac = component_labels == component
    component_voxels = int(np.count_nonzero(sac))

    touch = ndimage.generate_binary_structure(3, 3)
    # The accepted vessel mask may include the sac itself; the interface and
    # parent anchors are derived against the vessel outside the sac.
    vessel_only = vessel & ~sac
    if not vessel_only.any():
        raise ValueError("No vessel foreground outside the aneurysm component")
    vessel_touching_sac = vessel_only & ndimage.binary_dilation(sac, structure=touch)
    sac_touching_vessel = sac & ndimage.binary_dilation(vessel_only, structure=touch)
    interface_voxels = int(np.count_nonzero(sac_touching_vessel))
    if interface_voxels < MIN_INTERFACE_VOXELS:
        raise ValueError("No bounded aneurysm-vessel interface to propose a neck from")
    if interface_voxels > MAX_INTERFACE_VOXELS:
        raise ValueError("Aneurysm-vessel interface exceeds the bounded proposal budget")

    ijk = np.argwhere(sac_touching_vessel)
    ras = (aff[:3, :3] @ ijk.T).T + aff[:3, 3]
    neck_origin = ras.mean(axis=0)
    centered = ras - neck_origin
    covariance = (centered.T @ centered) / len(ras)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    # The neck plane is spanned by the two largest interface spread
    # directions; a contact cap may curve, but a line or point is degenerate.
    if not np.isfinite(eigenvalues).all() or eigenvalues[1] < 1e-9:
        raise ValueError("Aneurysm interface is degenerate; no neck plane is defined")
    neck_normal = eigenvectors[:, 0]
    # Weighted axis marginals need only dimension-sized vectors, not an
    # N-by-3 native/world coordinate pair for the entire sac component.
    centroid_native = np.asarray(
        [
            sac.sum(axis=tuple(k for k in range(3) if k != axis), dtype=np.float64)
            @ np.arange(sac.shape[axis], dtype=np.float64)
            / component_voxels
            for axis in range(3)
        ]
    )
    outward = aff[:3, :3] @ centroid_native + aff[:3, 3] - neck_origin
    orientation = float(neck_normal @ outward)
    # Numerical sign resolution relative to the physical grid, not an
    # anatomical accuracy threshold. An in-plane centroid cannot define a
    # dome side; an EDT seed may also be in that plane, so do not invent one.
    if not np.isfinite(orientation) or abs(orientation) <= float(max(lengths)) * 1e-6:
        raise ValueError("Neck normal orientation is ambiguous; choose operator inputs manually")
    if orientation < 0.0:
        neck_normal = -neck_normal
    norm = float(np.linalg.norm(neck_normal))
    if not np.isfinite(norm) or norm <= 1e-12:
        raise ValueError("Degenerate neck normal")
    neck_normal = neck_normal / norm

    # Deepest interior sac voxel by physical EDT (first max in raster order).
    distance = cast(np.ndarray, ndimage.distance_transform_edt(sac, sampling=_voxel_mm(aff)))
    flat = distance.ravel()
    seed_idx = np.unravel_index(int(np.argmax(flat)), distance.shape)
    aneurysm_seed = aff[:3, :3] @ np.asarray(seed_idx, dtype=float) + aff[:3, 3]

    # Parent anchors: farthest interface vessel voxels (diameter heuristic:
    # farthest from centroid, then farthest from that point), deterministic.
    vessel_ijk = np.argwhere(vessel_touching_sac)
    vessel_ras = (aff[:3, :3] @ vessel_ijk.T).T + aff[:3, 3]
    first = int(np.argmax(np.linalg.norm(vessel_ras - neck_origin, axis=1)))
    second = int(np.argmax(np.linalg.norm(vessel_ras - vessel_ras[first], axis=1)))
    start_ras = vessel_ras[first]
    end_ras = vessel_ras[second]
    start_idx = tuple(int(v) for v in vessel_ijk[first])
    end_idx = tuple(int(v) for v in vessel_ijk[second])
    vessel_labels, _ = cast(tuple[np.ndarray, int], ndimage.label(vessel_only, structure=structure))
    if vessel_labels[start_idx] != vessel_labels[end_idx]:
        raise ValueError("Aneurysm interface spans disconnected vessel components")

    from planner.centerline import propose_centerline

    path = propose_centerline(
        vessel_only, affine_ras, start_ras, end_ras, spatial_units=spatial_units
    )

    return {
        "inputs": {
            "neck_origin": neck_origin.tolist(),
            "neck_normal": neck_normal.tolist(),
            "aneurysm_seed": aneurysm_seed.tolist(),
            "parent_path": path["path_ras"],
            "proximal_index": path["proximal_index"],
            "distal_index": path["distal_index"],
        },
        "diagnostics": {
            "aneurysm_component_voxels": component_voxels,
            "interface_voxel_count": interface_voxels,
            "neck_plane_rms_residual_mm": float(np.sqrt(max(eigenvalues[0], 0.0))),
            "parent_point_count": int(path["point_count"]),
            "parent_length_mm": float(path["length_mm"]),
            "target_component_selected": selected_by_target,
            "grid_shape": [int(v) for v in aneurysm.shape],
        },
        "method": _METHOD,
        "operator_confirmation_required": True,
    }


def _voxel_mm(aff) -> Any:
    import numpy as np

    return np.linalg.norm(aff[:3, :3], axis=0)
