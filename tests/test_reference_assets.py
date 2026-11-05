"""Synthetic tests for the offline reference source preparer (Task 1).

No real dataset is used: every fixture is synthesized in-memory with the
stdlib and written to tmp_path. Values are coordinate-coded so crop bytes
are provable exactly.
"""

import gzip
import hashlib
import math
import struct

import pytest

from planner.reference_assets import ReferencePreparationError, prepare_reference

SOURCE_URL = "https://doi.org/10.6084/m9.figshare.26965450.v1"
TRANSFORM = [[-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]]


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_nifti_bytes(
    dims,
    spacing,
    translation,
    *,
    slope=2.0,
    inter=10.0,
    units_byte=2,
    datatype=64,
    bitpix=64,
    qform_code=0,
    srow=None,
    payload=None,
    sform_code=1,
    extensions=b"\0\0\0\0",
):
    d0, d1, d2 = dims
    n = d0 * d1 * d2
    if payload is None:
        payload = b"".join(struct.pack("<d", float(i)) for i in range(n))
    pixdim = [0.0, spacing[0], spacing[1], spacing[2], 0.0, 0.0, 0.0, 0.0]
    pixdim[0] = 1.0
    if srow is None:
        srow = [
            [spacing[0], 0.0, 0.0, translation[0]],
            [0.0, spacing[1], 0.0, translation[1]],
            [0.0, 0.0, spacing[2], translation[2]],
        ]
    buf = bytearray(352)
    struct.pack_into("<i", buf, 0, 348)
    struct.pack_into("<8h", buf, 40, 3, d0, d1, d2, 0, 0, 0, 0)
    struct.pack_into("<3f", buf, 56, 0.0, 0.0, 0.0)
    struct.pack_into("<3h", buf, 68, 0, datatype, bitpix)  # intent_code, datatype, bitpix
    struct.pack_into("<h", buf, 74, 0)  # slice_start
    struct.pack_into("<8f", buf, 76, *pixdim)
    struct.pack_into("<4f", buf, 108, 352.0, slope, inter, 0.0)
    buf[122] = 0  # slice_code
    buf[123] = units_byte & 0xFF  # NIfTI-1 xyzt_units
    struct.pack_into("<4f", buf, 124, 0, 0, 0, 0)  # cal_max/min, slice_duration, toffset
    struct.pack_into("<2i", buf, 140, 0, 0)  # glmax, glmin
    struct.pack_into("<2h", buf, 252, qform_code, sform_code)
    struct.pack_into("<3f", buf, 256, 0.0, 0.0, 0.0)
    struct.pack_into("<12f", buf, 280, *[v for row in srow for v in row])
    buf[344:348] = b"n+1\x00"
    header = bytes(buf[:348])
    assert len(header) == 348, len(header)
    raw = header + extensions + payload
    return gzip.compress(raw, mtime=0)


def build_binary_stl(triangles, header=b"\x00" * 80):
    out = bytearray(header)
    out += struct.pack("<I", len(triangles))
    for normal, tri in triangles:
        out += struct.pack("<3f", *normal)
        for v in tri:
            out += struct.pack("<3f", *v)
        out += struct.pack("<H", 0)
    return bytes(out)


def build_ascii_stl(triangles):
    lines = ["solid fixture"]
    for normal, tri in triangles:
        lines.append(f"facet normal {normal[0]:e} {normal[1]:e} {normal[2]:e}")
        lines.append("outer loop")
        for v in tri:
            lines.append(f"vertex {v[0]:e} {v[1]:e} {v[2]:e}")
        lines.append("endloop")
        lines.append("endfacet")
    lines.append("endsolid fixture")
    return ("\n".join(lines) + "\n").encode("ascii")


def make_fixtures(
    tmp_path,
    dims=(4, 5, 6),
    spacing=(2.0, 3.0, 5.0),
    translation=(7.0, -4.0, 11.0),
    payload=None,
    **kwargs,
):
    tmp_path.mkdir(parents=True, exist_ok=True)
    cta = tmp_path / "case.nii.gz"
    cta.write_bytes(build_nifti_bytes(dims, spacing, translation, payload=payload, **kwargs))
    tri = ((0.0, 0.0, 0.0), (2.0, 0.0, 0.0), (0.0, 4.0, 0.0))
    aneurysm = tmp_path / "an.stl"
    aneurysm.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
    artery = tmp_path / "art.stl"
    artery.write_bytes(build_ascii_stl([((0.0, 1.0, 0.0), tri)]))
    return {
        "cta_path": cta,
        "aneurysm_path": aneurysm,
        "artery_path": artery,
        "expected_sha256": {
            "cta": sha256_file(cta),
            "aneurysm": sha256_file(aneurysm),
            "artery": sha256_file(artery),
        },
    }


def run_prepare(tmp_path, start=(1, 1, 1), stop=(3, 4, 5), **kwargs):
    fixes = make_fixtures(tmp_path, **kwargs)
    out = tmp_path / "out"
    manifest = prepare_reference(
        fixes["cta_path"],
        fixes["aneurysm_path"],
        fixes["artery_path"],
        out,
        expected_sha256=fixes["expected_sha256"],
        ijk_start=start,
        ijk_stop=stop,
    )
    return manifest, out, fixes


@pytest.mark.parametrize("offset", [352.5, float("nan"), float("inf"), -float("inf"), float(2**31)])
def test_invalid_payload_offset_is_not_silently_truncated(tmp_path, offset):
    fixes = make_fixtures(tmp_path)
    raw = bytearray(gzip.decompress(fixes["cta_path"].read_bytes()))
    struct.pack_into("<f", raw, 108, offset)
    fixes["cta_path"].write_bytes(gzip.compress(raw, mtime=0))
    fixes["expected_sha256"]["cta"] = sha256_file(fixes["cta_path"])
    with pytest.raises(ReferencePreparationError, match="offset"):
        prepare_reference(
            **fixes, output_dir=tmp_path / "out", ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5)
        )
    assert not (tmp_path / "out").exists()


def test_singleton_inactive_dimensions_are_valid_3d(tmp_path):
    from planner.reference_assets import _parse_nifti_header

    raw = bytearray(gzip.decompress(build_nifti_bytes((4, 5, 6), (2, 3, 5), (7, -4, 11))))
    struct.pack_into("<4h", raw, 48, 1, 1, 1, 1)
    assert _parse_nifti_header(bytes(raw[:352]), "synthetic")["dims"] == (4, 5, 6)


@pytest.mark.parametrize("bad", [-1, 0.5, True])
def test_invalid_origin_rejected_before_output_creation(tmp_path, bad):
    with pytest.raises(ReferencePreparationError, match="index|indices|bound"):
        run_prepare(tmp_path, start=(bad, 1, 1))
    assert not (tmp_path / "out").exists()


def test_empty_symlink_output_is_rejected(tmp_path):
    fixes = make_fixtures(tmp_path / "source")
    target = tmp_path / "unrelated"
    target.mkdir()
    out = tmp_path / "out"
    out.symlink_to(target, target_is_directory=True)
    with pytest.raises(ReferencePreparationError, match="symlink"):
        prepare_reference(**fixes, output_dir=out, ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5))
    assert not list(target.iterdir())


def test_size_cap_applies_before_hashing(tmp_path, monkeypatch):
    import planner.reference_assets as module

    fixes = make_fixtures(tmp_path)
    monkeypatch.setattr(module, "MAX_GZ_BYTES", 1)

    def forbidden_hash(_):
        raise AssertionError("Oversized input was read before its cap check")

    monkeypatch.setattr(module, "_file_sha256", forbidden_hash)
    with pytest.raises(ReferencePreparationError, match="cap"):
        prepare_reference(
            **fixes, output_dir=tmp_path / "out", ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5)
        )


@pytest.mark.parametrize("field", ["slope", "inter"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_scaling_is_rejected_before_output_creation(tmp_path, field, value):
    with pytest.raises(ReferencePreparationError, match="finite.*scal|scal.*finite"):
        run_prepare(tmp_path, **{field: value})
    assert not (tmp_path / "out").exists()


def test_unit_byte_uses_nifti1_offset_123():
    from planner.reference_assets import _parse_nifti_header

    raw = gzip.decompress(build_nifti_bytes((4, 5, 6), (2, 3, 5), (7, -4, 11)))
    assert raw[123] == 2
    assert _parse_nifti_header(raw[:352], "synthetic")["xyzt_units"] == 2


def test_manifest_affine_matches_serialized_float32_header_exactly(tmp_path):
    manifest, out, _ = run_prepare(tmp_path, spacing=(0.1, 0.2, 0.3), translation=(0.4, -0.6, 0.8))
    raw = gzip.decompress((out / "reference-cta.nii.gz").read_bytes())
    actual = [list(struct.unpack_from("<4f", raw, 280 + 16 * r)) for r in range(3)]
    assert manifest["crop"]["cropped_affine"] == actual


def test_crop_origin_uses_signed_sform_not_absolute_spacing(tmp_path):
    matrix = [[-2.0, 0.0, 0.0, 7.0], [0.0, 3.0, 0.0, -4.0], [0.0, 0.0, 5.0, 11.0]]
    manifest, out, _ = run_prepare(tmp_path, srow=matrix, units_byte=0)
    assert manifest["crop"]["cropped_affine"][0][3] == 5
    assert (
        struct.unpack_from("<f", gzip.decompress((out / "reference-cta.nii.gz").read_bytes()), 292)[
            0
        ]
        == 5
    )
    assert manifest["source_header"]["xyzt_units"] == 0


def test_crop_exact_bytes_affine_and_header_preservation(tmp_path):
    manifest, out, fixes = run_prepare(tmp_path)
    img = out / "reference-cta.nii.gz"
    data = gzip.decompress(img.read_bytes())
    src_data = gzip.decompress(fixes["cta_path"].read_bytes())
    d0, d1, d2 = 4, 5, 6
    src = [struct.unpack_from("<d", src_data, 352 + 8 * i)[0] for i in range(d0 * d1 * d2)]
    i0, j0, k0 = 1, 1, 1
    i1, j1, k1 = 3, 4, 5
    expected = b"".join(
        struct.pack("<d", src[(k * d1 + j) * d0 + i])
        for k in range(k0, k1)
        for j in range(j0, j1)
        for i in range(i0, i1)
    )
    assert data[352:] == expected
    # raw voxel bytes preserved, not scaled
    assert struct.unpack_from("<d", data, 352)[0] == src[(k0 * d1 + j0) * d0 + i0]
    hdr = data[:348]
    dim = struct.unpack_from("<8h", hdr, 40)
    assert dim[:4] == (3, 2, 3, 4)
    assert struct.unpack_from("<f", hdr, 112)[0] == 2.0  # scl_slope
    assert struct.unpack_from("<f", hdr, 116)[0] == 10.0  # scl_inter
    assert hdr[123] == 2  # xyzt_units preserved
    pixdim = struct.unpack_from("<8f", hdr, 76)
    assert pixdim[1:4] == (2.0, 3.0, 5.0)
    assert struct.unpack_from("<f", hdr, 108)[0] == 352.0
    srow_x = struct.unpack_from("<4f", hdr, 280)
    assert srow_x[3] == pytest.approx(7.0 + 2.0 * 1.0)
    assert struct.unpack_from("<4f", hdr, 296)[3] == pytest.approx(-4.0 + 3.0 * 1.0)
    assert struct.unpack_from("<4f", hdr, 312)[3] == pytest.approx(11.0 + 5.0 * 1.0)
    assert manifest["schema_version"] == 1
    assert manifest["case_label"] == "CMHA AHMU1218001"
    assert manifest["source_url"] == SOURCE_URL
    assert manifest["license_url"] == "https://creativecommons.org/licenses/by/4.0/"
    assert manifest["image"] == {
        "filename": "reference-cta.nii.gz",
        "sha256": sha256_file(img),
    }
    assert manifest["source_sha256"] == fixes["expected_sha256"]
    assert manifest["transform"] == {"matrix": TRANSFORM, "status": "candidate_image_consistent"}
    assert manifest["source_header"] == {
        "xyzt_units": 2,
        "scl_slope": 2.0,
        "scl_inter": 10.0,
        "spacing": [2.0, 3.0, 5.0],
    }
    assert manifest["crop"]["origin_ijk"] == [1, 1, 1]
    assert manifest["crop"]["size_voxels"] == [2, 3, 4]
    assert manifest["crop"]["source_affine"] == [
        [2.0, 0.0, 0.0, 7.0],
        [0.0, 3.0, 0.0, -4.0],
        [0.0, 0.0, 5.0, 11.0],
    ]
    assert manifest["crop"]["cropped_affine"] == [
        [2.0, 0.0, 0.0, 9.0],
        [0.0, 3.0, 0.0, -1.0],
        [0.0, 0.0, 5.0, 16.0],
    ]
    ann = {a["id"]: a for a in manifest["annotations"]}
    assert set(ann) == {"aneurysm", "artery"}
    assert ann["aneurysm"]["filename"] == "reference-aneurysm.stl"
    assert ann["artery"]["filename"] == "reference-artery.stl"
    assert ann["aneurysm"]["sha256"] == sha256_file(out / "reference-aneurysm.stl")
    assert ann["artery"]["sha256"] == sha256_file(out / "reference-artery.stl")
    assert all(a["triangle_count"] == 1 for a in ann.values())
    for value in manifest["focus_ras"]:
        assert math.isfinite(value)
    assert "/" not in manifest["image"]["filename"]
    assert all("/" not in a["filename"] for a in ann.values())


def test_focus_ras_is_transformed_aneurysm_bbox_center(tmp_path):
    manifest, _out, _ = run_prepare(tmp_path)
    tri = [(0.0, 0.0, 0.0), (2.0, 0.0, 0.0), (0.0, 4.0, 0.0)]
    tx = [(-v[0], -v[1], v[2]) for v in tri]
    xs = [v[0] for v in tx]
    ys = [v[1] for v in tx]
    zs = [v[2] for v in tx]
    assert manifest["focus_ras"] == [
        (min(xs) + max(xs)) / 2,
        (min(ys) + max(ys)) / 2,
        (min(zs) + max(zs)) / 2,
    ]


def test_deterministic_outputs(tmp_path):
    m1, out1, _ = run_prepare(tmp_path / "a")
    m2, out2, _ = run_prepare(tmp_path / "b")
    assert (out1 / "reference-cta.nii.gz").read_bytes() == (
        out2 / "reference-cta.nii.gz"
    ).read_bytes()
    assert (out1 / "reference-aneurysm.stl").read_bytes() == (
        out2 / "reference-aneurysm.stl"
    ).read_bytes()
    assert m1 == m2


def test_binary_stl_with_solid_facet_header_is_not_misclassified(tmp_path):
    fixes = make_fixtures(tmp_path)
    source = fixes["aneurysm_path"].read_bytes()
    fixes["aneurysm_path"].write_bytes(
        b"solid facet binary producer header".ljust(80, b" ") + source[80:]
    )
    fixes["expected_sha256"]["aneurysm"] = sha256_file(fixes["aneurysm_path"])
    manifest = prepare_reference(
        **fixes, output_dir=tmp_path / "out", ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5)
    )
    assert manifest["annotations"][0]["triangle_count"] == 1


def test_binary_stl_transform_recomputes_normals(tmp_path):
    _, out, _ = run_prepare(tmp_path)
    raw = (out / "reference-aneurysm.stl").read_bytes()
    count = struct.unpack_from("<I", raw, 80)[0]
    assert count == 1
    assert len(raw) == 84 + 50 * count
    normal = struct.unpack_from("<3f", raw, 84)
    assert normal == pytest.approx((0.0, 0.0, 1.0))
    verts = [struct.unpack_from("<3f", raw, 96 + 12 * i) for i in range(3)]
    assert verts[0] == (0.0, 0.0, 0.0)
    assert verts[1] == (-2.0, 0.0, 0.0)
    assert verts[2] == (0.0, -4.0, 0.0)


def test_ascii_stl_input_transformed_to_binary(tmp_path):
    _, out, _ = run_prepare(tmp_path)
    raw = (out / "reference-artery.stl").read_bytes()
    assert struct.unpack_from("<I", raw, 80)[0] == 1
    verts = [struct.unpack_from("<3f", raw, 96 + 12 * i) for i in range(3)]
    assert verts[1] == (-2.0, 0.0, 0.0)


@pytest.mark.parametrize("failure", ["mesh", "manifest"])
def test_failed_preparation_cleans_its_outputs_and_allows_corrected_retry(
    tmp_path, monkeypatch, failure
):
    from pathlib import Path

    fixes = make_fixtures(tmp_path)
    out = tmp_path / "out"
    original_mesh = fixes["artery_path"].read_bytes()
    write_text = Path.write_text
    if failure == "mesh":
        fixes["artery_path"].write_bytes(b"invalid synthetic STL")
        fixes["expected_sha256"]["artery"] = sha256_file(fixes["artery_path"])
    else:

        def fail_manifest(path, *args, **kwargs):
            if path == out / "manifest.json":
                path.write_bytes(b"{partial synthetic failure")
                raise OSError("synthetic manifest write failure")
            return write_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", fail_manifest)
    expected = ReferencePreparationError if failure == "mesh" else OSError
    with pytest.raises(expected):
        prepare_reference(**fixes, output_dir=out, ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5))
    assert list(out.iterdir()) == []
    fixes["artery_path"].write_bytes(original_mesh)
    fixes["expected_sha256"]["artery"] = sha256_file(fixes["artery_path"])
    monkeypatch.setattr(Path, "write_text", write_text)
    prepare_reference(**fixes, output_dir=out, ijk_start=(1, 1, 1), ijk_stop=(3, 4, 5))
    assert (out / "manifest.json").is_file()


def test_hash_mismatch_rejected_no_manifest(tmp_path):
    fixes = make_fixtures(tmp_path)
    fixes["expected_sha256"]["cta"] = "0" * 64
    out = tmp_path / "out"
    with pytest.raises(Exception, match="hash"):
        prepare_reference(
            fixes["cta_path"],
            fixes["aneurysm_path"],
            fixes["artery_path"],
            out,
            expected_sha256=fixes["expected_sha256"],
            ijk_start=(0, 0, 0),
            ijk_stop=(2, 2, 2),
        )
    assert not (out / "manifest.json").exists()


def test_truncated_source_rejected(tmp_path):
    good = build_nifti_bytes((4, 5, 6), (2.0, 3.0, 5.0), (7.0, -4.0, 11.0))
    short = good[:-40]
    cta = tmp_path / "case.nii.gz"
    cta.write_bytes(short)
    tri = ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    aneurysm = tmp_path / "an.stl"
    aneurysm.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
    artery = tmp_path / "art.stl"
    artery.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
    with pytest.raises(Exception, match="EOF|truncated"):
        prepare_reference(
            cta,
            aneurysm,
            artery,
            tmp_path / "out",
            expected_sha256={
                "cta": sha256_file(cta),
                "aneurysm": sha256_file(aneurysm),
                "artery": sha256_file(artery),
            },
            ijk_start=(0, 0, 0),
            ijk_stop=(4, 5, 6),
        )


def test_invalid_bounds_rejected(tmp_path):
    with pytest.raises(ReferencePreparationError):
        run_prepare(tmp_path, start=(0, 0, 0), stop=(5, 6, 7))


def test_unsupported_inputs_rejected(tmp_path):
    bad_qform = build_nifti_bytes((4, 5, 6), (2.0, 3.0, 5.0), (7.0, -4.0, 11.0), qform_code=1)
    non_diag = build_nifti_bytes(
        (4, 5, 6),
        (2.0, 3.0, 5.0),
        (7.0, -4.0, 11.0),
        srow=[[2.0, 0.1, 0.0, 7.0], [0.0, 3.0, 0.0, -4.0], [0.0, 0.0, 5.0, 11.0]],
    )
    for bad in (bad_qform, non_diag):
        cta = tmp_path / "case.nii.gz"
        cta.write_bytes(bad)
        tri = ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
        aneurysm = tmp_path / "an.stl"
        aneurysm.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
        artery = tmp_path / "art.stl"
        artery.write_bytes(build_ascii_stl([((0.0, 0.0, 1.0), tri)]))
        with pytest.raises(Exception, match="unsupported"):
            prepare_reference(
                cta,
                aneurysm,
                artery,
                tmp_path / "out",
                expected_sha256={
                    "cta": sha256_file(cta),
                    "aneurysm": sha256_file(aneurysm),
                    "artery": sha256_file(artery),
                },
                ijk_start=(0, 0, 0),
                ijk_stop=(2, 2, 2),
            )


def test_non_finite_stl_rejected(tmp_path):
    tri = ((0.0, 0.0, 0.0), (float("nan"), 0.0, 0.0), (0.0, 1.0, 0.0))
    cta = tmp_path / "case.nii.gz"
    cta.write_bytes(build_nifti_bytes((4, 5, 6), (2.0, 3.0, 5.0), (7.0, -4.0, 11.0)))
    aneurysm = tmp_path / "an.stl"
    aneurysm.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
    artery = tmp_path / "art.stl"
    artery.write_bytes(build_binary_stl([((0.0, 0.0, 1.0), tri)]))
    with pytest.raises(Exception, match="finite"):
        prepare_reference(
            cta,
            aneurysm,
            artery,
            tmp_path / "out",
            expected_sha256={
                "cta": sha256_file(cta),
                "aneurysm": sha256_file(aneurysm),
                "artery": sha256_file(artery),
            },
            ijk_start=(0, 0, 0),
            ijk_stop=(2, 2, 2),
        )


def test_truncated_stl_rejected(tmp_path):
    good = build_binary_stl(
        [((0.0, 0.0, 1.0), ((0.0, 0.0, 0.0), (2.0, 0.0, 0.0), (0.0, 4.0, 0.0)))]
    )
    cta = tmp_path / "case.nii.gz"
    cta.write_bytes(build_nifti_bytes((4, 5, 6), (2.0, 3.0, 5.0), (7.0, -4.0, 11.0)))
    aneurysm = tmp_path / "an.stl"
    aneurysm.write_bytes(good[:-10])
    artery = tmp_path / "art.stl"
    artery.write_bytes(good)
    with pytest.raises(Exception, match="truncated"):
        prepare_reference(
            cta,
            aneurysm,
            artery,
            tmp_path / "out",
            expected_sha256={
                "cta": sha256_file(cta),
                "aneurysm": sha256_file(aneurysm),
                "artery": sha256_file(artery),
            },
            ijk_start=(0, 0, 0),
            ijk_stop=(2, 2, 2),
        )


def test_symlink_input_and_nonempty_output_rejected(tmp_path):
    fixes = make_fixtures(tmp_path / "fix")
    link = tmp_path / "link.nii.gz"
    link.symlink_to(fixes["cta_path"])
    fixes["expected_sha256"]["cta"] = sha256_file(link)
    with pytest.raises(Exception, match="symlink"):
        prepare_reference(
            link,
            fixes["aneurysm_path"],
            fixes["artery_path"],
            tmp_path / "out",
            expected_sha256=fixes["expected_sha256"],
            ijk_start=(0, 0, 0),
            ijk_stop=(2, 2, 2),
        )
    fixes2 = make_fixtures(tmp_path / "fix2")
    out = tmp_path / "out2"
    out.mkdir()
    (out / "stale.txt").write_text("x")
    with pytest.raises(Exception, match="output"):
        prepare_reference(
            fixes2["cta_path"],
            fixes2["aneurysm_path"],
            fixes2["artery_path"],
            out,
            expected_sha256=fixes2["expected_sha256"],
            ijk_start=(0, 0, 0),
            ijk_stop=(2, 2, 2),
        )
