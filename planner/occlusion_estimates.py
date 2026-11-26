"""Occlusion estimates by treatment for intracranial aneurysms.

Evaluates the portable model exported by the seldinger-outcomes repository
(schema ``seldinger.occlusion-model.v1``): a random-effects meta-regression fitted to published
clinical series. It returns the expected rate of complete angiographic occlusion for aneurysms
like the one described, for each treatment option, with a 95% confidence interval and the range
between centres. Standard library only, so the base server needs no numerical stack.
"""

import json
import math
import os
from pathlib import Path

SCHEMA = "seldinger.occlusion-model.v1"
DEFAULT_PATH = (
    Path(__file__).resolve().parents[1] / ".runtime" / "outcomes" / "occlusion-model.json"
)

# Worksheet options -> modelled techniques.
TECHNIQUES = {
    "coiling": ["coil"],
    "assisted_coiling": ["BAC", "SAC"],
    "flow_diversion": ["FD", "FD_coil"],
    "intrasaccular": ["WEB"],
    "clipping": ["clip"],
}
LABELS = {
    "coil": "Coiling",
    "BAC": "Balloon-assisted coiling",
    "SAC": "Stent-assisted coiling",
    "FD": "Flow diverter",
    "FD_coil": "Flow diverter with coils",
    "WEB": "WEB intrasaccular device",
    "clip": "Microsurgical clipping",
}
TREATMENTS = list(TECHNIQUES)

TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "treatments": {
            "type": "array",
            "items": {"enum": TREATMENTS},
            "uniqueItems": True,
            "minItems": 1,
            "maxItems": len(TREATMENTS),
        },
        "months": {"type": "integer", "minimum": 0, "maximum": 60},
        "max_size_mm": {"type": "number", "exclusiveMinimum": 0.5, "exclusiveMaximum": 60},
        "neck_mm": {"type": "number", "exclusiveMinimum": 0.2, "exclusiveMaximum": 40},
        "rupture_status": {"enum": ["unknown", "unruptured", "ruptured"]},
        "circulation": {"enum": ["unknown", "anterior", "posterior"]},
        "bifurcation": {"type": "boolean"},
    },
    "required": [],
    "additionalProperties": False,
}

TOOL_DESCRIPTION = (
    "Estimate complete angiographic occlusion for each aneurysm treatment option (coiling, "
    "assisted coiling, flow diversion, intrasaccular device, clipping) at a follow-up time, from a "
    "model fitted to published clinical series. Use it when the user asks about treatment options, "
    "expected occlusion, recurrence or durability. Pass only values stated in the case plan, the "
    "computed context or the user's message: max_size_mm (largest aneurysm dimension), neck_mm, "
    "rupture_status, circulation (anterior/posterior), bifurcation, months (0 = end of procedure, "
    "default 12) and optionally treatments. Leave unknown values out; the result lists which inputs "
    "were set to the published average. Results are rates for aneurysms like this one across "
    "centres, with a 95% confidence interval and the range between centres."
)


class OcclusionModelError(ValueError):
    """The installed model file is missing fields or has the wrong schema."""


def _finite(values, name):
    if not isinstance(values, list) or not values:
        raise OcclusionModelError(f"{name} must be a non-empty list")
    for v in values:
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
            raise OcclusionModelError(f"{name} must contain finite numbers")
    return [float(v) for v in values]


def _expit(x):
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def _quantile(sorted_values, q):
    pos = (len(sorted_values) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


class OcclusionModel:
    def __init__(self, spec: dict):
        if not isinstance(spec, dict) or spec.get("schema") != SCHEMA:
            raise OcclusionModelError("Unsupported occlusion model schema")
        names = spec.get("names")
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise OcclusionModelError("names must be a list of strings")
        self.names: list[str] = names
        self.index = {n: i for i, n in enumerate(self.names)}
        self.beta = _finite(spec.get("beta"), "beta")
        if len(self.beta) != len(self.names):
            raise OcclusionModelError("beta length does not match names")
        self.tau = _finite([spec.get("tau")], "tau")[0]
        self.nodes = _finite(spec.get("gh_nodes"), "gh_nodes")
        self.weights = _finite(spec.get("gh_weights"), "gh_weights")
        if len(self.nodes) != len(self.weights) or abs(sum(self.weights) - 1) > 1e-6:
            raise OcclusionModelError("Quadrature nodes and weights are inconsistent")
        self.draws = []
        for d in spec.get("bootstrap") or []:
            b = _finite(d.get("beta"), "bootstrap beta")
            if len(b) != len(self.names):
                raise OcclusionModelError("bootstrap beta length does not match names")
            self.draws.append((b, _finite([d.get("tau")], "bootstrap tau")[0]))
        self.family = spec.get("family") or {}
        self.ref = spec.get("ref") or {}
        self.t_ref = float(spec.get("t_ref_months", 12.0))
        self.imputation = spec.get("imputation_means") or {}
        self.evidence = spec.get("evidence") or {}
        self.validation = spec.get("validation")
        self.outcome = spec.get("outcome")
        self.sha256 = spec.get("sha256")
        self.studies = spec.get("studies")
        needed = ["log_size", "ruptured", "posterior", "wide_neck", "bifurcation"]
        for technique in {t for ts in TECHNIQUES.values() for t in ts}:
            fam = self.family.get(technique)
            if (
                fam is None
                or f"int:{technique}" not in self.index
                or f"time:{technique}" not in self.index
                or f"imm:{fam}" not in self.index
                or f"log_size:{fam}" not in self.index
                or any(c not in self.imputation.get(fam, {}) for c in needed)
            ):
                raise OcclusionModelError(f"Model does not cover {technique}")
        if any(c not in self.ref for c in needed) or any(c not in self.index for c in needed[1:]):
            raise OcclusionModelError("Model covariate references are incomplete")

    @classmethod
    def load(cls, path: Path | None = None):
        """Return the installed model, or None when no model file is installed."""
        path = Path(os.environ.get("SELDINGER_OCCLUSION_MODEL") or path or DEFAULT_PATH)
        if not path.is_file():
            return None
        return cls(json.loads(path.read_text()))

    def _row(self, technique, months, cov):
        fam = self.family[technique]
        x = [0.0] * len(self.names)
        x[self.index[f"int:{technique}"]] = 1.0
        x[self.index[f"time:{technique}"]] = math.log1p(months) - math.log1p(self.t_ref)
        if months == 0:
            x[self.index[f"imm:{fam}"]] = 1.0
        x[self.index[f"log_size:{fam}"]] = cov["log_size"] - self.ref["log_size"]
        for c in ("ruptured", "posterior", "wide_neck", "bifurcation"):
            x[self.index[c]] = cov[c] - self.ref[c]
        return x

    def _rate(self, x, beta, tau):
        eta = sum(a * b for a, b in zip(x, beta))
        return sum(w * _expit(eta + tau * z) for z, w in zip(self.nodes, self.weights)), eta

    def estimate(self, args: dict) -> dict:
        months = int(args.get("months", 12))
        size, neck = args.get("max_size_mm"), args.get("neck_mm")
        rupture = args.get("rupture_status", "unknown")
        circulation = args.get("circulation", "unknown")
        bifurcation = args.get("bifurcation")
        wide_neck = None
        if neck is not None:
            wide_neck = 1.0 if neck >= 4 or (size is not None and size / neck < 2) else 0.0
        given = {
            "log_size": math.log(size) if size is not None else None,
            "ruptured": {"ruptured": 1.0, "unruptured": 0.0}.get(rupture),
            "posterior": {"posterior": 1.0, "anterior": 0.0}.get(circulation),
            "wide_neck": wide_neck,
            "bifurcation": None if bifurcation is None else float(bifurcation),
        }
        assumed = [
            label
            for key, label in (
                ("log_size", "aneurysm size"),
                ("ruptured", "rupture status"),
                ("posterior", "circulation"),
                ("wide_neck", "neck width"),
                ("bifurcation", "bifurcation location"),
            )
            if given[key] is None
        ]
        results = []
        for treatment in args.get("treatments") or TREATMENTS:
            for technique in TECHNIQUES[treatment]:
                imp = self.imputation[self.family[technique]]
                cov = {k: (v if v is not None else float(imp[k])) for k, v in given.items()}
                x = self._row(technique, months, cov)
                rate, eta = self._rate(x, self.beta, self.tau)
                entry = {
                    "treatment": treatment,
                    "technique": LABELS[technique],
                    "complete_occlusion": round(rate, 3),
                    "between_centre_range95": [
                        round(_expit(eta - 1.96 * self.tau), 3),
                        round(_expit(eta + 1.96 * self.tau), 3),
                    ],
                    "published_studies": int(self.evidence.get(technique, {}).get("studies", 0)),
                    "published_aneurysms": int(
                        self.evidence.get(technique, {}).get("aneurysms_weighted", 0)
                    ),
                }
                if self.draws:
                    rates = sorted(self._rate(x, b, t)[0] for b, t in self.draws)
                    entry["ci95"] = [
                        round(_quantile(rates, 0.025), 3),
                        round(_quantile(rates, 0.975), 3),
                    ]
                results.append(entry)
        results.sort(key=lambda r: -r["complete_occlusion"])
        return {
            "outcome": "complete angiographic occlusion (Raymond-Roy 1 or equivalent)",
            "months_after_treatment": months,
            "inputs": {
                "max_size_mm": size,
                "neck_mm": neck,
                "wide_neck": None if wide_neck is None else bool(wide_neck),
                "rupture_status": rupture,
                "circulation": circulation,
                "bifurcation": bifurcation,
            },
            "set_to_published_average": assumed,
            "estimates": results,
            "model": {
                "basis": f"Random-effects meta-regression of {self.studies} published clinical series",
                "not_modelled": "Procedural complications, rupture risk and retreatment burden",
                "validation": self.validation,
                "model_sha256": self.sha256,
            },
        }
