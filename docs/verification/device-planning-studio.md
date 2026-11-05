# Device planning studio: exercised geometric prototype

Internal engineering record,2026-11-04. This is a new implementation in `seldinger-planner`, not imported legacy application code. Independent engineering and source reviews were reconciled against current code and primary sources; see `device-studio-review-disposition.md`. No deployment, clinical validation or patient-specific efficacy claim is established.

## Implemented interaction

The app's **Device studio** action opens an image-linked workspace. The central NiiVue scene renders authored device wires, native accepted vessel and aneurysm surfaces, and optionally the original browser-local CTA. Controls expose camera zoom, linked slices versus3D, CTA window/opacity/cutaway, independent anatomy visibility, nominal device dimensions, intrasaccular position/orientation, picked paths and flow-diverter arclength offset.

The ordinary library contains Surpass Elite, Surpass Evolve, Pipeline Flex with Shield, Pipeline Vantage021with Shield, WEB SL, WEB SLS, Target360and Axium Prime. Source-listed sizes are distinct from exploratory geometric controls; source coverage is partial for some families. WEB's37captured size entries have their source SKU strings. Unknown wire gauges, pitch and mechanical parameters remain unknown. The nominal surfaces are parametric approximations, not manufacturer CAD replicas.

Pipeline Vantage027is an explicitly recalled reference, not an ordinary candidate. Contour is retained only as an investigational/reference model, not counted as verified US availability. The current source review must reconcile any remaining availability/label-version issues before final reporting.

## Actual public-case execution

Approved public Zenodo case006context:

- Case `IkEMF5YWYSm7LeodOXBSbQ`, artifact version `13`.
- Image SHA-256 `26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473`.
- Source revision `92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e`.
- Geometry result `UAwlS4kRZ7PZhfJa98c7bg`.

The app fetched both accepted native-mask surfaces, checked mask/surface identities and rendered them with the device. No mask or case mutation was made for this test. Independent surface readback decoded the actual native masks and mapped every returned STL vertex back into the source index space: maximum doubled-index half-grid errors were below0.000008. The surfaces contained34,720vessel and5,990aneurysm triangles. These are coordinate/integrity checks, not anatomical accuracy.

A WEB SLS8×6.6preview was placed at the saved operator sac seed. The modeled sampled-envelope clearance to the operator neck plane was0.84mm. Moving its S coordinate from−7.625to−15mm changed that diagnostic to−5.43mm and produced the actual parent-side crossing warning. This is an operator-plane geometric diagnostic, not proof of parent-lumen collision, sealing, containment or clinical suitability. The same case's measured sac-section width/height exceeded this device's nominal envelope; no successful fit or selected real-case size is claimed.

Both placements were saved independently in browser-local scenario storage. Exact stored coordinates were read back. After closing the studio, reopening the calibrated source and reopening the studio, both alternatives remained; restoring the first returned WEB SLS with its original center. Storage binds the case, image, source revision, artifact version, geometry result and device catalog version. It is not a server scenario ledger, cross-browser synchronization or a continuously revalidated multiuser plan.

All eight ordinary model choices were selected in actual Chrome WebGL, with no rendering alerts. A too-long FD on the existing8.90mmoperator path failed visibly rather than extrapolating a landing zone. That development path is not validated centerline anatomy and does not support the nominal12–20mmexamples without new operator path selection.

## Physics and advice boundary

- FD: curved counterbraid with parallel-transport frames and actual start/length path trimming. No force/contact model.
- WEB: distinct SL barrel and SLS spherical cage profiles, markers and pose controls. No device-specific compression mechanics.
- Coils: two catalog families and a deterministic length-constrained generic coil skeleton. Primary coil diameter must be explicitly supplied before material-volume packing arithmetic; the preview's display spacing is not a SKU diameter. No heat-set rollout or FEM mechanics.
- Planning checks: explicit geometric dimensions, source/recall warnings, treatment-class tradeoffs and operator-plane envelope crossing. No automatic treatment choice, suitability score, clinical risk or obliteration probability.
- Research bench: opt-in local thin-screen pressure equation from Abdehkakha et al.,2021, DOI10.1016/j.compbiomed.2021.104988, Eq.1. Original PMC MathML was checked. The hypothetical porosity0.75, hydraulic pore diameter0.12mm, velocity0.05m/s, density1060kg/m³ and viscosity0.0035Pa·s produce16.6195138889Pa. The live UI showed16.62Pa. These are declared bench inputs, not measurements of any selected device or patient. This is not a solved CFD flow field or a sac-inflow reduction model. The coefficient is not applied to WEB/coils.
- Ideal-helix bench: preserves strand length as expansion diameter changes, with an explicitly hypothetical two-turn helix. Not calibrated product mechanics.

Patient-specific baseline/treated3D CFD, validated apposition, branch patency, thrombus/healing simulation and clinical obliteration prediction remain unimplemented. They require separate solved-domain, parameter and validation work, not rhetoric or visual occlusion.

## Checks actually observed

- Backend:557passed,97optional heavyweight skips in the lightweight suite. Ruff lint/format and `git diff --check` passed. The isolated native surface/mask-geometry lane separately passed16synthetic tests, including the newly reproduced immutable-byte race and required-unit checks.
- Frontend:188passed; TypeScript and production build passed. Vite retains the existing large-chunk advisory. Production audit reported zero vulnerabilities before the final coordinate-input change, which added no dependencies.
- Regression traces included the missing STL filename extension, overlong path refusal, true path-offset trimming, preserved scenario braid angle, partial negative coordinate editing and signed plane crossing.

Ignored local receipts: `artifacts/device-planning/model-render-smoke.json`, `native-surface-verification.json`, `verify_native_surfaces.py`, `native-web-sls.png`, `native-comparison-verified.png` and per-family bench screenshots. A failed negative-coordinate-input screenshot is retained separately, not used as successful evidence. The input bug was reproduced and fixed with a draft/blur-commit control; actual typing then retained−15and produced the expected warning. Raw images and state remain out of git.

## Source and schema revision

Catalog `device-appearance-research-2026-11-04-v2` explicitly discloses partial size coverage and the unresolved US-manufacturer64versusFrench2025assessment40Surpass Elite wire discrepancy. Every model has an explicit display strand parameter instead of identifier-based fallback. Scenario model schema `procedural-device-v2` retains braid angle and rejects old v1records. Bench examples and anatomy alternatives are explicitly separate coordinate spaces.

The final v2browser check saved two different WEB SLS positions with S coordinates−15and−7.625, read both exact records back, confirmed the new catalog/schema versions and rendered their comparison without alerts. Receipts: `artifacts/device-planning/final-v2-browser-verified.json` and `final-v2-native-comparison-verified.png`.

## Publication boundary

Publish only source/tests/documentation through the authorized repository workflow after exact-diff/secret review and final checks. No merge is permitted without exact-head CI and the applicable approval/review gate. This document is an exercised geometric-prototype checkpoint, not completion of all milestones in the broader treatment-simulation plan.
