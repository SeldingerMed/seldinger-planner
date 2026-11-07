"""Multi-territory pathology and procedure plugin framework.

Consolidates `seldinger-app/apps/pathology/framework.py`, `findings.py`, `masks.py`,
and `modules.py` into `seldinger-planner` so Neurovascular, Cath/Structural Heart,
and Peripheral Vascular procedures share a unified plugin contract.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, runtime_checkable

from planner.calculators import (
    compute_aneurysm_morphometrics,
    compute_evar_seal_zone,
    compute_nascet_stenosis,
    compute_tavr_annulus_sizing,
)

Modality = Literal["CTA", "NCCT", "CTP", "MRA", "DSA", "3D-DSA", "OCT", "IVUS"]
TerritoryName = Literal[
    "neurovascular",
    "coronary",
    "structural_heart",
    "peripheral_vascular",
]
Severity = Literal["normal", "mild", "moderate", "severe", "critical", "unknown"]


@dataclass(frozen=True)
class ModelCard:
    name: str
    architecture: str
    version: str
    weights_Env_or_path: str = ""
    trained_on: str = ""
    modalities: tuple[Modality, ...] = ("CTA",)
    metrics: dict[str, float] = field(default_factory=dict)
    license: str = "research-only"
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OverlaySpec:
    key: str
    label: str
    kind: Literal["mask", "surface", "centerline", "vector_field", "plane"]
    color_rgba: tuple[int, int, int, int] = (239, 68, 68, 180)
    default_visible: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Finding:
    id: str
    pathology: str
    territory: TerritoryName
    title: str
    severity: Severity = "unknown"
    confidence: float | None = None
    location: str | None = None
    laterality: Literal["L", "R", "midline", "bilateral", "unknown"] = "unknown"
    measurements: dict[str, Any] = field(default_factory=dict)
    scores: dict[str, Any] = field(default_factory=dict)
    device_categories: list[str] = field(default_factory=list)
    summary: str = ""
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FindingCollection:
    case_id: str
    findings: list[Finding] = field(default_factory=list)
    generated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    module_versions: dict[str, str] = field(default_factory=dict)

    def add(self, finding: Finding) -> None:
        self.findings.append(finding)

    def by_pathology(self, key: str) -> list[Finding]:
        return [f for f in self.findings if f.pathology == key]

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "generated_at": self.generated_at,
            "module_versions": dict(self.module_versions),
            "findings": [f.to_dict() for f in self.findings],
        }


@dataclass
class CaseContext:
    case_id: str
    modality: Modality = "CTA"
    territory: TerritoryName = "neurovascular"
    measurements: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class TerritoryPlugin(Protocol):
    key: str
    display_name: str
    territory: TerritoryName
    modalities: tuple[Modality, ...]
    model_card: ModelCard
    required_masks: tuple[str, ...]

    def calculators(self) -> list[str]: ...
    def device_categories(self) -> list[str]: ...
    def overlays(self) -> list[OverlaySpec]: ...
    def analyze(self, ctx: CaseContext) -> list[Finding]: ...


class IntracranialAneurysmPlugin:
    key = "intracranial_aneurysm"
    display_name = "Intracranial Saccular & Fusiform Aneurysm"
    territory: TerritoryName = "neurovascular"
    modalities: tuple[Modality, ...] = ("CTA", "MRA", "3D-DSA")
    required_masks: tuple[str, ...] = ("vessel", "aneurysm")
    model_card = ModelCard(
        name="Seldinger Neurovascular Aneurysm + Vessel Suite",
        architecture="ResUNet3D Vessel + nnUNet3D Aneurysm + Plane-Mesh Morphometry",
        version="2.0.0",
        modalities=("CTA", "MRA", "3D-DSA"),
    )

    def calculators(self) -> list[str]:
        return ["aneurysm_morphometrics", "phases_score", "elapss_score"]

    def device_categories(self) -> list[str]:
        return ["flow_diverter", "intrasaccular", "coil", "neuro_stent"]

    def overlays(self) -> list[OverlaySpec]:
        return [
            OverlaySpec("vessel", "Parent Vessel Lumen", "surface", (56, 189, 248, 140)),
            OverlaySpec("aneurysm", "Aneurysm Sac", "surface", (239, 68, 68, 190)),
            OverlaySpec("neck_plane", "Ostium / Neck Plane", "plane", (250, 204, 21, 180)),
        ]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        m = ctx.measurements
        dw = m.get("dome_width_mm") or m.get("width")
        dh = m.get("dome_height_mm") or m.get("height")
        nw = m.get("neck_width_mm") or m.get("neck_diameter")
        scores: dict[str, Any] = {}
        if dw is None or dh is None or nw is None:
            return []
        if dw and dh and nw:
            scores["morphometrics"] = compute_aneurysm_morphometrics(
                dome_width_mm=float(dw),
                dome_height_mm=float(dh),
                neck_width_mm=float(nw),
                parent_artery_diameter_mm=m.get("parent_artery_diameter_mm"),
                sac_volume_mm3=m.get("sac_volume_mm3"),
                sac_surface_area_mm2=m.get("sac_surface_area_mm2"),
            )
        return [
            Finding(
                id=f"{ctx.case_id}:aneurysm:1",
                pathology=self.key,
                territory=self.territory,
                title="Intracranial Aneurysm Target",
                severity="unknown",
                measurements=dict(m),
                scores=scores,
                device_categories=self.device_categories(),
                summary="3D neck/sac/parent vessel morphometry and endovascular device sizing target.",
                provenance={"clinical_suitability_established": False},
            )
        ]


class AcuteStrokeLVOPlugin:
    key = "acute_ischemic_stroke_lvo"
    display_name = "Acute Ischemic Stroke / Large Vessel Occlusion"
    territory: TerritoryName = "neurovascular"
    modalities: tuple[Modality, ...] = ("CTA", "NCCT", "CTP", "DSA")
    required_masks: tuple[str, ...] = ("vessel", "thrombus")
    model_card = ModelCard(
        name="LVO Clot & Collateral Analyzer",
        architecture="3D Vessel Cutoff + Clot Burden Calculator",
        version="1.0.0",
        modalities=("CTA", "NCCT", "CTP"),
    )

    def calculators(self) -> list[str]:
        return ["clot_length", "aspects_collateral_summary"]

    def device_categories(self) -> list[str]:
        return ["thrombectomy"]

    def overlays(self) -> list[OverlaySpec]:
        return [
            OverlaySpec("vessel", "Arterial Tree", "surface", (56, 189, 248, 140)),
            OverlaySpec("thrombus", "Occlusive Thrombus", "surface", (249, 115, 22, 200)),
        ]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        if ctx.metadata.get("operator_confirmed_lvo") is not True:
            return []
        return [
            Finding(
                id=f"{ctx.case_id}:lvo:1",
                pathology=self.key,
                territory=self.territory,
                title="Large Vessel Occlusion Target",
                measurements=dict(ctx.measurements),
                device_categories=self.device_categories(),
                provenance={"clinical_suitability_established": False},
            )
        ]


class CarotidStenosisPlugin:
    key = "carotid_stenosis"
    display_name = "Extracranial / Intracranial Carotid Stenosis"
    territory: TerritoryName = "neurovascular"
    modalities: tuple[Modality, ...] = ("CTA", "MRA", "DSA")
    required_masks: tuple[str, ...] = ("vessel", "calcification")
    model_card = ModelCard(
        name="NASCET Lumen & Plaque Analyzer",
        architecture="Cross-Sectional Minimum Lumen / Reference Diameter",
        version="1.0.0",
        modalities=("CTA", "MRA", "DSA"),
    )

    def calculators(self) -> list[str]:
        return ["nascet_stenosis"]

    def device_categories(self) -> list[str]:
        return ["carotid"]

    def overlays(self) -> list[OverlaySpec]:
        return [OverlaySpec("vessel", "Carotid Bifurcation Lumen", "surface", (56, 189, 248, 150))]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        m = ctx.measurements
        scores: dict[str, Any] = {}
        if m.get("minimal_lumen_diameter_mm") is None or m.get("distal_normal_diameter_mm") is None:
            return []
        if m.get("minimal_lumen_diameter_mm") is not None:
            scores["nascet"] = compute_nascet_stenosis(
                minimal_lumen_diameter_mm=float(m["minimal_lumen_diameter_mm"]),
                distal_normal_diameter_mm=float(m["distal_normal_diameter_mm"]),
            )
        return [
            Finding(
                id=f"{ctx.case_id}:carotid:1",
                pathology=self.key,
                territory=self.territory,
                title="Carotid Stenosis Lesion",
                measurements=dict(m),
                scores=scores,
                device_categories=self.device_categories(),
                provenance={"clinical_suitability_established": False},
            )
        ]


class CoronaryLesionPCIPlugin:
    key = "coronary_lesion_pci"
    display_name = "Coronary Stenosis & Bifurcation PCI Planning"
    territory: TerritoryName = "coronary"
    modalities: tuple[Modality, ...] = ("CTA", "DSA", "IVUS", "OCT")
    required_masks: tuple[str, ...] = ("coronary_lumen", "calcification")
    model_card = ModelCard(
        name="Coronary QCA & Stent Landing Planner",
        architecture="Centerline Lumen Profile + Reference Taper",
        version="1.0.0",
        modalities=("CTA", "DSA", "IVUS", "OCT"),
    )

    def calculators(self) -> list[str]:
        return []  # Coronary-specific QCA is a later implementation, not NASCET.

    def device_categories(self) -> list[str]:
        return ["coronary_des"]

    def overlays(self) -> list[OverlaySpec]:
        return [OverlaySpec("coronary_lumen", "Coronary Tree Lumen", "surface", (244, 63, 94, 160))]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        if ctx.metadata.get("operator_confirmed_coronary_lesion") is not True:
            return []
        return [
            Finding(
                id=f"{ctx.case_id}:coronary:1",
                pathology=self.key,
                territory=self.territory,
                title="Coronary Target Lesion",
                measurements=dict(ctx.measurements),
                device_categories=self.device_categories(),
                provenance={"clinical_suitability_established": False},
            )
        ]


class AorticValveTAVRPlugin:
    key = "aortic_valve_tavr"
    display_name = "Structural Heart / TAVR Annular & Coronary Clearance"
    territory: TerritoryName = "structural_heart"
    modalities: tuple[Modality, ...] = ("CTA",)
    required_masks: tuple[str, ...] = ("aortic_root", "calcification", "coronary_ostia")
    model_card = ModelCard(
        name="TAVR Annular Plane & Coronary Clearance Suite",
        architecture="Double-Oblique Annular Contour + Sinus/Ostia Geometry",
        version="1.0.0",
        modalities=("CTA",),
    )

    def calculators(self) -> list[str]:
        return ["tavr_annulus_sizing"]

    def device_categories(self) -> list[str]:
        return ["tavr"]

    def overlays(self) -> list[OverlaySpec]:
        return [
            OverlaySpec("aortic_root", "Aortic Root & Sinuses", "surface", (251, 146, 60, 150)),
            OverlaySpec("annular_plane", "Basal Annular Ring Plane", "plane", (52, 211, 153, 190)),
        ]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        m = ctx.measurements
        scores: dict[str, Any] = {}
        if m.get("annulus_area_mm2") is None or m.get("annulus_perimeter_mm") is None:
            return []
        if m.get("annulus_area_mm2") and m.get("annulus_perimeter_mm"):
            scores["tavr_sizing"] = compute_tavr_annulus_sizing(
                annulus_area_mm2=float(m["annulus_area_mm2"]),
                annulus_perimeter_mm=float(m["annulus_perimeter_mm"]),
                left_coronary_height_mm=m.get("left_coronary_height_mm"),
                right_coronary_height_mm=m.get("right_coronary_height_mm"),
            )
        return [
            Finding(
                id=f"{ctx.case_id}:tavr:1",
                pathology=self.key,
                territory=self.territory,
                title="Aortic Root & Annular Complex",
                measurements=dict(m),
                scores=scores,
                device_categories=self.device_categories(),
                provenance={"clinical_suitability_established": False},
            )
        ]


class AorticAneurysmEVARPlugin:
    key = "aortic_aneurysm_evar"
    display_name = "Peripheral & Aortic / EVAR-TEVAR Seal Zone Planner"
    territory: TerritoryName = "peripheral_vascular"
    modalities: tuple[Modality, ...] = ("CTA", "MRA", "DSA")
    required_masks: tuple[str, ...] = ("aorta_lumen", "outer_wall", "thrombus")
    model_card = ModelCard(
        name="EVAR/TEVAR Seal Zone & Iliac Access Suite",
        architecture="Infrarenal Neck Centerline + Access Minimum Lumen",
        version="1.0.0",
        modalities=("CTA", "MRA"),
    )

    def calculators(self) -> list[str]:
        return ["evar_seal_zone"]

    def device_categories(self) -> list[str]:
        return ["peripheral"]

    def overlays(self) -> list[OverlaySpec]:
        return [
            OverlaySpec("aorta_lumen", "Aorto-Iliac Lumen", "surface", (239, 68, 68, 160)),
            OverlaySpec("thrombus", "Mural Thrombus", "surface", (148, 163, 184, 130)),
        ]

    def analyze(self, ctx: CaseContext) -> list[Finding]:
        m = ctx.measurements
        scores: dict[str, Any] = {}
        if any(
            m.get(key) is None
            for key in (
                "infrarenal_neck_diameter_mm",
                "infrarenal_neck_length_mm",
                "infrarenal_angle_deg",
            )
        ):
            return []
        if (
            m.get("infrarenal_neck_diameter_mm")
            and m.get("infrarenal_neck_length_mm") is not None
            and m.get("infrarenal_angle_deg") is not None
        ):
            scores["evar_seal"] = compute_evar_seal_zone(
                infrarenal_neck_diameter_mm=float(m["infrarenal_neck_diameter_mm"]),
                infrarenal_neck_length_mm=float(m["infrarenal_neck_length_mm"]),
                infrarenal_angle_deg=float(m["infrarenal_angle_deg"]),
                min_iliac_access_diameter_mm=m.get("min_iliac_access_diameter_mm"),
            )
        return [
            Finding(
                id=f"{ctx.case_id}:evar:1",
                pathology=self.key,
                territory=self.territory,
                title="Aorto-Iliac Aneurysm & Seal Zone",
                measurements=dict(m),
                scores=scores,
                device_categories=self.device_categories(),
                provenance={"clinical_suitability_established": False},
            )
        ]


TERRITORY_REGISTRY: dict[str, TerritoryPlugin] = {}


def register_territory_plugin(plugin: TerritoryPlugin) -> None:
    TERRITORY_REGISTRY[plugin.key] = plugin


for _default_plugin in (
    IntracranialAneurysmPlugin(),
    AcuteStrokeLVOPlugin(),
    CarotidStenosisPlugin(),
    CoronaryLesionPCIPlugin(),
    AorticValveTAVRPlugin(),
    AorticAneurysmEVARPlugin(),
):
    register_territory_plugin(_default_plugin)


def get_territory_plugin(key: str) -> TerritoryPlugin | None:
    return TERRITORY_REGISTRY.get(key)


def list_territory_plugins(territory: TerritoryName | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for plugin in TERRITORY_REGISTRY.values():
        if territory is not None and plugin.territory != territory:
            continue
        out.append(
            {
                "key": plugin.key,
                "display_name": plugin.display_name,
                "territory": plugin.territory,
                "modalities": list(plugin.modalities),
                "required_masks": list(plugin.required_masks),
                "calculators": plugin.calculators(),
                "device_categories": plugin.device_categories(),
                "overlays": [o.to_dict() for o in plugin.overlays()],
                "model_card": plugin.model_card.to_dict(),
            }
        )
    return out


def enabled_plugins_for_modality(modality: Modality) -> list[TerritoryPlugin]:
    return [p for p in TERRITORY_REGISTRY.values() if modality in p.modalities]


def analyze_case_territories(
    ctx: CaseContext, *, keys: list[str] | None = None
) -> FindingCollection:
    collection = FindingCollection(case_id=ctx.case_id)
    selected = (
        [TERRITORY_REGISTRY[k] for k in keys if k in TERRITORY_REGISTRY]
        if keys
        else enabled_plugins_for_modality(ctx.modality)
    )
    for plugin in selected:
        if plugin.territory != ctx.territory or ctx.modality not in plugin.modalities:
            continue
        collection.module_versions[plugin.key] = plugin.model_card.version
        for finding in plugin.analyze(ctx):
            collection.add(finding)
    return collection
