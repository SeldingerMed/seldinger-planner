"""Strict source-bound Phase3 territory context projection for local brief export.

`project_territory_context` validates server response envelopes against the
operator's four-field case identity and projects only whitelisted, finite
scalar producer outputs (producer result names preserved exactly). Anything
contradictory, malformed, non-finite, unknown, or array-like raises
`ValueError` instead of being silently dropped. `not_computed` / `stale`
statuses project an explicit absence with no numbers at all.

The projected context is `{case_id, image_sha256, artifact_version,
reference_revision, modes: {mode: per-mode context}}`, one entry per envelope
in the mapping. No raw inputs, contours, paths, per-profile rows, pixels, or
freeform provenance strings ever enter the projection. Scene/fusion projection
is supplied separately by `planner.local_brief`.
"""

import math
from typing import NoReturn

from planner.territory_workflows import CALCULATION_VERSION

ANNOTATION_SOURCE = "operator_traced"
IDENTITY_FIELDS = ("case_id", "image_sha256", "artifact_version", "reference_revision")
HEX_DIGEST_LENGTH = 64
MODES = ("tavr", "coronary_pci", "aortic_peripheral")
STATUS_CURRENT = "current"
STATUS_ABSENCE = ("not_computed", "stale")

# Known metric names of the actual producers (planner.compute_workflow results),
# preserved verbatim. Everything else in a result is rejected.
_TAVR_SCALAR_METRICS = frozenset(
    {
        "area_derived_diameter_mm",
        "area_mm2",
        "left_coronary_height_mm",
        "max_diameter_mm",
        "min_diameter_mm",
        "perimeter_derived_diameter_mm",
        "perimeter_mm",
        "right_coronary_height_mm",
    }
)
_CORONARY_SCALAR_METRICS = frozenset(
    {
        "bifurcation_angle_deg",  # optional: None when no bifurcation, distinct from 0
        "diameter_narrowing_pct",
        "distal_reference_diameter_mm",
        "lesion_length_mm",
        "proximal_reference_diameter_mm",
        "reference_taper_mm_per_mm",
        "sampled_minimum_diameter_mm",
    }
)
_AORTIC_SCALAR_METRICS = frozenset(
    {
        "alpha_deg",
        "beta_deg",
        "calcification_burden_pct",  # optional class burden; None distinct from 0
        "neck_length_mm",
        "sampled_maximum_diameter_mm",
        "sampled_minimum_diameter_mm",
        "thrombus_burden_pct",
    }
)
_MODE_SCALARS = {
    "tavr": _TAVR_SCALAR_METRICS,
    "coronary_pci": _CORONARY_SCALAR_METRICS,
    "aortic_peripheral": _AORTIC_SCALAR_METRICS,
}
_ACCESS_SCALAR_KEYS = ("length_mm", "sampled_minimum_diameter_mm")
STATION_METRICS = frozenset({"minimum_station", "maximum_station"})
ENUM_METRICS = {"diameter_basis": "area_equivalent"}

METRIC_LABELS = {
    "area_derived_diameter_mm": "Area-derived diameter (mm)",
    "area_mm2": "Area (mm2)",
    "left_coronary_height_mm": "Left coronary height (mm)",
    "max_diameter_mm": "Max diameter (mm)",
    "min_diameter_mm": "Min diameter (mm)",
    "perimeter_derived_diameter_mm": "Perimeter-derived diameter (mm)",
    "perimeter_mm": "Perimeter (mm)",
    "right_coronary_height_mm": "Right coronary height (mm)",
    "bifurcation_angle_deg": "Bifurcation angle (deg)",
    "diameter_basis": "Diameter basis",
    "diameter_narrowing_pct": "Diameter narrowing (%)",
    "distal_reference_diameter_mm": "Distal reference diameter (mm)",
    "lesion_length_mm": "Lesion length (mm)",
    "minimum_station": "Minimum station",
    "maximum_station": "Maximum station",
    "proximal_reference_diameter_mm": "Proximal reference diameter (mm)",
    "reference_taper_mm_per_mm": "Reference taper (mm/mm)",
    "sampled_minimum_diameter_mm": "Sampled minimum diameter (mm)",
    "sampled_maximum_diameter_mm": "Sampled maximum diameter (mm)",
    "alpha_deg": "Proximal neck angle alpha (deg)",
    "beta_deg": "Distal neck angle beta (deg)",
    "calcification_burden_pct": "Calcification burden (%)",
    "thrombus_burden_pct": "Thrombus burden (%)",
    "neck_length_mm": "Neck length (mm)",
}
ACCESS_METRIC_LABELS = {
    "length_mm": "Access length (mm)",
    "sampled_minimum_diameter_mm": "Access minimum diameter (mm)",
    "minimum_station": "Access minimum station",
}
_STATION_RANGE = (0, 127)


def _reject(message) -> NoReturn:
    raise ValueError(message)


def _is_hex_digest(value):
    return (
        isinstance(value, str)
        and len(value) == HEX_DIGEST_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _validate_identity(identity):
    if not isinstance(identity, dict) or set(identity) != set(IDENTITY_FIELDS):
        _reject("Identity must be exactly the four bound fields")
    if not isinstance(identity["case_id"], str) or not identity["case_id"]:
        _reject("Identity case_id must be a non-empty string")
    for field in ("image_sha256", "reference_revision"):
        if not _is_hex_digest(identity[field]):
            _reject(f"Identity {field} must be a hex digest")
    if not isinstance(identity["artifact_version"], str) or not identity["artifact_version"]:
        _reject("Identity artifact_version must be a non-empty string")
    return {field: identity[field] for field in IDENTITY_FIELDS}


def _validate_revision(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _reject("workflow_revision must be a non-negative integer")
    return value


def _validate_scalar(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _reject(f"Metric {name} must be a finite scalar")
    return float(value)


def _validate_station(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        _reject(f"Metric {name} must be an integer station")
    if not _STATION_RANGE[0] <= value <= _STATION_RANGE[1]:
        _reject(f"Metric {name} is outside the station range")
    return value


# Producer result keys that are known but never projected (arrays / nested rows).
_DROPPED_RESULT_KEYS = frozenset({"profiles"})
_ACCESS_RESULT_KEYS = frozenset({"left_access", "right_access"})
# Metrics the actual producers legitimately emit as null (distinct from 0).
_OPTIONAL_NONE_METRICS = frozenset(
    {"bifurcation_angle_deg", "calcification_burden_pct", "thrombus_burden_pct"}
)
# Actual producer `current` envelope keys (web fixture territory-path-workflows.json).
_CURRENT_KEYS = frozenset(
    {"status", "result_id", "inputs", "result", "dependencies", "input_sha256"}
)
_ACCESS_KEYS = frozenset(_ACCESS_SCALAR_KEYS) | {"minimum_station"}


# Mode-specific required non-scalar-set metrics (stations / diameter basis),
# per the actual producer results in the web fixture.
_REQUIRED_MODE_METRICS = {
    "tavr": frozenset(),
    "coronary_pci": frozenset({"minimum_station", "diameter_basis"}),
    "aortic_peripheral": frozenset({"minimum_station", "maximum_station"}),
}


def _project_metrics(mode, result):
    """Whitelist-known finite scalar outputs of one producer result."""
    allowed = _MODE_SCALARS[mode]
    required = allowed | _REQUIRED_MODE_METRICS[mode]
    if result.get("calculation_version") != CALCULATION_VERSION:
        _reject("Producer calculation_version does not match the expected version")
    if result.get("annotation_source") != ANNOTATION_SOURCE:
        _reject("Producer annotation_source is not the expected bounded provenance")
    metrics = {}
    for name, value in result.items():
        if name in ("calculation_version", "annotation_source"):
            continue
        if name in _DROPPED_RESULT_KEYS:
            if isinstance(value, list):
                continue  # known per-profile rows: never projected
            _reject(f"Producer result {name} must be the known rows array")
        if mode == "aortic_peripheral" and name in _ACCESS_RESULT_KEYS:
            continue  # projected separately as fixed scalar subkeys
        if name in STATION_METRICS:
            metrics[name] = _validate_station(value, name)
        elif name in ENUM_METRICS:
            if value != ENUM_METRICS[name]:
                _reject(f"Metric {name} has an unrecognized value")
            metrics[name] = value
        elif name in allowed:
            if value is None and name not in _OPTIONAL_NONE_METRICS:
                _reject(f"Metric {name} must not be null on a current result")
            metrics[name] = None if value is None else _validate_scalar(value, name)
        else:
            _reject(f"Producer result contains unwhitelisted key {name!r}")
    missing = required - set(metrics) - _ACCESS_RESULT_KEYS
    if missing:
        _reject(f"Producer result is missing required metrics {sorted(missing)}")
    return metrics


def _project_access(value, name):
    """Project one secondary access route as a fixed scalar subkey, or None."""
    if value is None:
        return None
    if not isinstance(value, dict):
        _reject(f"Metric {name} must be None or the producer access result")
    if set(value) != _ACCESS_KEYS:
        _reject(f"Producer access result {name} does not match the actual envelope")
    projected = {key: _validate_scalar(value[key], f"{name}.{key}") for key in _ACCESS_SCALAR_KEYS}
    projected["minimum_station"] = _validate_station(
        value["minimum_station"], f"{name}.minimum_station"
    )
    return projected


def _validate_result_id(value):
    if not isinstance(value, str) or not value or len(value) > 128:
        _reject("result_id must be a bounded non-empty string")
    if any(not (character.isalnum() or character in "-_") for character in value):
        _reject("result_id contains unexpected characters")
    return value


def _project_mode(mode, envelope, checked):
    """Project one workflow envelope against the bound identity."""
    if not isinstance(envelope, dict):
        _reject("Envelope must be a mapping")
    expected_keys = set(IDENTITY_FIELDS) | {"mode", "workflow_revision", "current"}
    if set(envelope) != expected_keys:
        _reject("Envelope shape does not match the server response contract")
    for field in IDENTITY_FIELDS:
        if envelope[field] != checked[field]:
            _reject(f"Envelope {field} contradicts the bound identity")
    if envelope["mode"] != mode:
        _reject("Envelope mode contradicts its workflow key")

    context = {
        "mode": mode,
        "workflow_revision": _validate_revision(envelope["workflow_revision"]),
    }

    current = envelope["current"]
    if current is None:
        _reject("Actual producer never emits a null current workflow")
    if not isinstance(current, dict) or "status" not in current:
        _reject("Envelope current entry is malformed")

    status = current["status"]
    if status in STATUS_ABSENCE:
        # Actual producer absence envelopes: not_computed carries nothing else;
        # stale keeps its result_id with cleared inputs and result.
        if status == "not_computed":
            if set(current) != {"status"}:
                _reject("not_computed current must carry only its status")
        else:
            if set(current) != {"status", "result_id", "inputs", "result"}:
                _reject("stale current must carry only status, result_id and cleared fields")
            if current.get("inputs") is not None or current.get("result") is not None:
                _reject(f"{status} workflow must not carry results")
            context["result_id"] = _validate_result_id(current["result_id"])
        context["status"] = status
        return context
    if status != STATUS_CURRENT:
        _reject(f"Unknown workflow status {status!r}")

    # current: every actual producer field must be present and consistent.
    if set(current) != _CURRENT_KEYS:
        _reject("Current workflow keys do not match the actual producer envelope")
    if current.get("result_id") is None or current.get("result") is None:
        _reject("Current workflow must carry a result_id and a result")
    context["result_id"] = _validate_result_id(current["result_id"])

    dependencies = current.get("dependencies")
    if not isinstance(dependencies, dict):
        _reject("Current workflow is missing dependency metadata")
    for field in IDENTITY_FIELDS:
        if dependencies.get(field) != checked[field]:
            _reject(f"Current dependencies {field} contradicts the bound identity")
    if dependencies.get("mode") != mode:
        _reject("Current dependencies mode contradicts the workflow")
    if dependencies.get("calculation_version") != CALCULATION_VERSION:
        _reject("Current dependencies carry an unexpected calculation version")

    input_sha256 = current.get("input_sha256")
    if not _is_hex_digest(input_sha256):
        _reject("Current workflow must carry a hex input_sha256")
    context["input_sha256"] = input_sha256

    result = current["result"]
    if not isinstance(result, dict):
        _reject("Producer result must be a mapping of known scalar outputs")
    context["status"] = STATUS_CURRENT
    context["annotation_source"] = ANNOTATION_SOURCE
    context["metrics"] = _project_metrics(mode, result)
    if mode == "aortic_peripheral":
        context["left_access"] = _project_access(result.get("left_access"), "left_access")
        context["right_access"] = _project_access(result.get("right_access"), "right_access")
    return context


def project_territory_context(identity: dict, envelopes: dict) -> dict:
    """Project server territory envelopes into a safe brief context.

    Returns `{**identity, calculation_version, modes: {mode: projection}}`
    with one projection per envelope, keyed by its workflow mode.
    """
    checked = _validate_identity(identity)
    if not isinstance(envelopes, dict) or not envelopes:
        _reject("Envelopes must be a non-empty mapping of mode to envelope")
    for mode in envelopes:
        if mode not in MODES:
            _reject(f"Unknown territory workflow mode {mode!r}")

    projections = {
        mode: _project_mode(mode, envelopes[mode], checked) for mode in MODES if mode in envelopes
    }
    return {**checked, "calculation_version": CALCULATION_VERSION, "modes": projections}


def _validate_render_value(name, value):
    if name in ENUM_METRICS:
        if value != ENUM_METRICS[name]:
            _reject(f"Context metric {name} has an unrecognized value")
        return value
    if name in STATION_METRICS:
        return _validate_station(value, name)
    if value is None:
        return None
    return _validate_scalar(value, name)


def _render_metrics(metrics):
    lines = []
    for name, value in metrics.items():
        if name not in METRIC_LABELS:
            _reject(f"Context contains unwhitelisted metric {name!r}")
        rendered = _validate_render_value(name, value)
        if rendered is None:
            lines.append(f"{METRIC_LABELS[name]}: not applicable")
        elif name in ENUM_METRICS:
            lines.append(f"{METRIC_LABELS[name]}: {rendered}")
        else:
            lines.append(f"{METRIC_LABELS[name]}: {rendered:g}")
    return lines


_MODE_TITLES = {
    "tavr": "TAVR",
    "coronary_pci": "Coronary PCI",
    "aortic_peripheral": "Aortic/peripheral",
}


def render_territory_context(context: dict) -> str:
    """Render a projected context as deterministic brief text with no raw data."""
    if not isinstance(context, dict) or set(context) != set(IDENTITY_FIELDS) | {
        "calculation_version",
        "modes",
    }:
        _reject("Context must come from project_territory_context")
    _validate_identity({field: context[field] for field in IDENTITY_FIELDS})
    if context["calculation_version"] != CALCULATION_VERSION:
        _reject("Context carries an unexpected calculation version")
    modes = context["modes"]
    if not isinstance(modes, dict) or not modes:
        _reject("Context must carry projected workflow modes")
    for mode in modes:
        if mode not in MODES:
            _reject(f"Context contains unknown workflow mode {mode!r}")

    lines = [
        "Territory context",
        f"Case: {context['case_id']}",
        f"Image: {context['image_sha256']}",
        f"Artifact version: {context['artifact_version']}",
        f"Reference revision: {context['reference_revision']}",
    ]
    for mode in MODES:
        if mode not in modes:
            continue
        projection = modes[mode]
        if not isinstance(projection, dict):
            _reject("Projected workflow mode must be a mapping")
        if projection.get("mode") != mode:
            _reject("Projection mode contradicts its workflow key")
        lines.append(
            f"{_MODE_TITLES[mode]} workflow (revision "
            f"{_validate_revision(projection['workflow_revision'])}):"
        )
        status = projection["status"]
        if status in STATUS_ABSENCE:
            if set(projection) - {"mode", "workflow_revision", "status", "result_id"}:
                _reject(f"{status} projection must not carry results")
            if projection.get("result_id") is not None:
                _validate_result_id(projection["result_id"])
            lines.append(f"  Status: {status.replace('_', ' ')}; no current result")
            lines.append("  No measurements are shown for a non-current result.")
            continue
        if status != STATUS_CURRENT or "metrics" not in projection:
            _reject("Current projection must carry projected metrics")
        lines.append("  Status: current")
        input_sha256 = projection.get("input_sha256")
        if input_sha256 is not None:
            if not _is_hex_digest(input_sha256):
                _reject("Current projection must carry a hex input_sha256")
            lines.append(f"  Inputs digest: {input_sha256}")
        if projection.get("annotation_source") != ANNOTATION_SOURCE:
            _reject("Current projection carries unexpected provenance")
        lines.append(
            f"  Result: {_validate_result_id(projection['result_id'])} (calculation "
            f"{context['calculation_version']}, {projection['annotation_source']})"
        )
        for line in _render_metrics(projection["metrics"]):
            lines.append(f"  {line}")
        for name in ("left_access", "right_access"):
            if name not in projection:
                continue
            access = projection[name]
            if access is None:
                continue
            lines.append(f"  {name.replace('_', ' ').capitalize()}:")
            for key, value in access.items():
                if key not in ACCESS_METRIC_LABELS:
                    _reject(f"Context contains unwhitelisted access metric {key!r}")
                lines.append(
                    f"    {ACCESS_METRIC_LABELS[key]}: {_validate_render_value(key, value):g}"
                )
    return "\n".join(lines)
