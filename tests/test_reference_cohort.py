"""Synthetic source-shape tests. No patient pixels or real CSV rows in fixtures."""

import csv
import io

import pytest

from planner.reference_cohort import bind_archive_members, normalize_reference_csv

HEADER = [
    "ID",
    "IA(0/№_?)",
    "Sex",
    "Age, years",
    "Artery",
    "Saccular (0/1)",
    "Position",
    "Type",
    "Size",
    "Neck, mm",
    "Length, mm",
    "Width, mm",
    "Vobject, mm3",
    "Rupture (0/1)",
    "Bleb (0/1)",
    "Thrombus (0/1)",
    "Vessel (0/1)",
    "Calcification (0/1)",
    "Images count",
    "Slice Thickness, mm",
    "Head+Neck (0/1)",
    "",
    "",
]


def row(case="901", lesion="1_1", **changes):
    values = dict.fromkeys(HEADER, "NA")
    values.update(
        {
            "ID": case,
            "IA(0/№_?)": lesion,
            "Sex": "EXCLUDED_DEMOGRAPHIC",
            "Age, years": "EXCLUDED_DEMOGRAPHIC",
            "Saccular (0/1)": "1",
            "Position": "bifurcation",
            "Size": "middle",
            "Neck, mm": "3,2",
            "Length, mm": "5,3",
            "Width, mm": "5,2",
            "Vobject, mm3": "64,25",
            "Images count": "2",
        }
    )
    if lesion == "0":
        for key in [
            "Saccular (0/1)",
            "Position",
            "Type",
            "Size",
            "Neck, mm",
            "Length, mm",
            "Width, mm",
            "Vobject, mm3",
        ]:
            values[key] = "NA"
    values.update(changes)
    return [values[key] if key else "" for key in HEADER]


def source(rows, header=HEADER):
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue().encode("cp1251")


def test_normalizes_only_reference_columns_and_preserves_tokens():
    result = normalize_reference_csv(source([row(), row("902", "0")]))
    assert result[0]["case_id"] == "901"
    lesion = result[0]["lesions"][0]
    assert lesion["published_measurements"] == {
        "neck_mm": 3.2,
        "length_mm": 5.3,
        "width_mm": 5.2,
        "volume_mm3": 64.25,
    }
    assert lesion["measurement_tokens"]["neck_mm"] == "3,2"
    assert lesion["source_lesion_token"] == "1_1"
    assert lesion["stl_member"] == "Annotations/an_901.stl"
    assert result[1]["lesions"] == []
    assert result[1]["case_annotation"] == "aneurysm_absent"
    assert "EXCLUDED_DEMOGRAPHIC" not in repr(result)
    assert "device_inputs" not in repr(result)


def test_multiple_lesions_are_grouped_not_counted_as_patients():
    result = normalize_reference_csv(
        source([row(lesion="1_2"), row(lesion="2_2", **{"Images count": "n/a", "Neck, mm": "NA"})])
    )
    assert len(result) == 1
    assert result[0]["published_image_count"] == 2
    assert [r["stl_member"] for r in result[0]["lesions"]] == [
        "Annotations/an_901_1.stl",
        "Annotations/an_901_2.stl",
    ]
    assert result[0]["lesions"][1]["published_measurements"]["neck_mm"] is None


@pytest.mark.parametrize(
    "changes",
    [
        {"ID": "91"},
        {"ID": " 901"},
        {"IA(0/№_?)": "01_1"},
        {"IA(0/№_?)": "2_1"},
        {"Neck, mm": "NaN"},
        {"Length, mm": "Inf"},
        {"Width, mm": "0"},
        {"Vobject, mm3": "-1"},
        {"Neck, mm": "3.2.1"},
        {"Saccular (0/1)": "2"},
        {"Images count": "2.5"},
    ],
)
def test_rejects_invalid_values(changes):
    with pytest.raises(ValueError):
        normalize_reference_csv(source([row(**changes)]))


@pytest.mark.parametrize(
    "rows",
    [
        [row(lesion="1_2")],
        [row(), row()],
        [row(), row(lesion="0")],
        [row(lesion="1_2"), row(lesion="2_2", **{"Images count": "3"})],
    ],
)
def test_rejects_inconsistent_case_groups(rows):
    with pytest.raises(ValueError):
        normalize_reference_csv(source(rows))


def test_negative_case_cannot_retain_aneurysm_numbers():
    with pytest.raises(ValueError):
        normalize_reference_csv(source([row(lesion="0", **{"Width, mm": "2"})]))


def test_exact_header_and_row_width_required():
    with pytest.raises(ValueError):
        normalize_reference_csv(source([row()], header=["OTHER"] + HEADER[1:]))
    with pytest.raises(ValueError):
        normalize_reference_csv(source([row()[:-1]]))


def archive():
    return [
        {"member": "Annotations/an_901.stl", "compressed_bytes": 30, "uncompressed_bytes": 40},
        {"member": "Studies/901/a.dcm", "compressed_bytes": 3, "uncompressed_bytes": 6},
        {"member": "Studies/901/b.dcm", "compressed_bytes": 4, "uncompressed_bytes": 8},
    ]


def test_exact_archive_binding_and_no_registration_claim():
    cases = normalize_reference_csv(source([row()]))
    result = bind_archive_members(cases, archive())
    assert result[0]["archive_series"]["dicom_count"] == 2
    assert result[0]["archive_series"]["compressed_bytes"] == 7
    assert result[0]["archive_series"]["uncompressed_bytes"] == 14
    assert result[0]["voxel_labels_ready"] is False
    assert result[0]["training_overlap"] == "unknown"
    assert "archive_series" not in cases[0]


@pytest.mark.parametrize(
    "mutator",
    [
        lambda a: a[1:],
        lambda a: a[:-1],
        lambda a: a + [a[0]],
    ],
)
def test_missing_or_duplicate_archive_bindings_fail_closed(mutator):
    with pytest.raises(ValueError):
        bind_archive_members(normalize_reference_csv(source([row()])), mutator(archive()))
