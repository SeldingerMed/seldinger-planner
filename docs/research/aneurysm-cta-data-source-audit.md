# Reconciled aneurysm CTA data sources

Internal source audit. Public availability, label semantics, permitted commercial use and independence from a trained checkpoint are different questions. No access request or external outreach was sent.

## Immediately usable public reference

**Blagosklonova et al., Zenodo15697196**, https://zenodo.org/records/15697196, DOI10.5281/zenodo.15697196, CC-BY-4.0. Actual172-case/122-STL reference manifest and acquired case013 are documented in `../verification/labeled-cta-reference-acquisition.md`. DICOM geometry, raw-member hashes, published measurement columns and source identities were actually exercised. Spatial agreement and predictive accuracy are not established by metadata parsing.

The full primary paper is accessible from its official publisher CDN even though the HTML landing page denied retrieval:

https://mdpi-res.com/d_attachment/data/data-11-00074/article_deploy/data-11-00074.pdf

Paper: *A Dataset of Annotated DICOM Images of Head CT Angiography for Intracranial Aneurysm Detection*, Data2026,11,74, DOI10.3390/data11040074.

Important primary-paper details:
- Section2.1 explicitly states that segmented-object coordinates align with the original-image coordinate system. This is source evidence for testing the DICOM-patient-coordinate interpretation, rather than choosing a mesh transform by maximizing image intensity. Apply/check the resulting LPS-to-RAS mapping against actual data before rasterization; do not assert that the paper explicitly spells out LPS/STL units when it does not.
- Section3.4: two clinicians segmented different subsets, cross-reviewed each other's segmentations and resolved discrepancies by consensus. Segmentation used individually chosen intensity thresholds after manual isolation. Meshes represent only contrast-opacified aneurysm lumen, excluding thrombus and calcification; this is not an outer-wall label.
- Section3.5: linear measures were performed manually by an experienced radiologist using adjustable MPR. Maximum length is neck-base-centre-to-most-remote-dome-point except fusiform/involved-bifurcation cases, where it spans the dilatation. Width is the largest transverse dome diameter; neck is recorded when present. These are not six device-specific sizing parameters, and the length is not automatically a perpendicular sac height.
- Section3.6 describes consensus segmentation review, not an independent two-reader measurement-agreement study of our software.

## Additional native voxel-label datasets

### TopAneu2026: released, not merely a proposal

**Primary data documentation:** https://topaneu-26.grand-challenge.org/data/

**Actual public release link supplied by organizers:** https://drive.switch.ch/index.php/s/O36U43RkChkNcHd

The primary page describes batch releases in June/July2026 and415scans from408patients, including109CTA series (58+47+4, programmatically summed). Serial scans require patient grouping, not filename-level splits. Center4 has54patients and62CTA series; center2 contributes47CTA series and40MRA series.

Labels are native `.nii.gz` aneurysm location masks (52 location/laterality classes), aneurysm-type masks (saccular/dissecting/fusiform), and per-case location JSON. Images were converted from DICOM, defaced, reoriented LPS+ and cropped to the brain. Auxiliary vessel masks are **model-predicted silver-standard**, not expert vessel ground truth. The changelog includes annotation corrections and exclusion of artifact/treated cases.

**Terms:** noncommercial research is allowed with attribution; commercial purposes require prior permission from the data owner. Download constitutes agreement. No dataset assets were downloaded and no permission request was sent. The public page's license must not be replaced with the CC-BY license on the separate Zenodo challenge-proposal PDF.

The initial helper statement that TopAneu had not been released was wrong: it inspected the April proposal rather than the current challenge data page. This is the strongest newly verified voxel-label lead, but not unconditionally usable for a Seldinger commercial prototype. An explicit permission decision/contact authorization is needed to pursue that route. Training/patient overlap with our checkpoint remains to be audited even though this release is newer than the competition training pipeline.

### Large IA segmentation, Bo et al.

Primary: https://zenodo.org/records/6801398, DOI10.5281/zenodo.6801398.

Record describes1338internalCTA/1489aneurysms and138externalCTA/101aneurysms, with voxel-wise masks. Files are restricted and terms are noncommercial research only. Access requires an institutional request naming the applicant, affiliation, supervisor and purpose. No request was made. Do not describe this as a frictionless open download or assume access permission would also permit commercial use.

### RSNA-ICA and corrected competition masks

Primary checkpoint source: https://github.com/PengchengShi1220/RSNA2025_Intracranial-Aneurysm-Detection/tree/1ead0ba4dc00bcd84591269995dde6a8446ca3ad

RSNA/Kaggle series labels and localizer coordinates are not universal aneurysm voxel masks. The checkpoint's corrected26class labels are explicitly research-only CC-BY-NC4.0 and not clinically reviewed. They are also directly connected to the model's training workflow. They were not adopted as an independent benchmark or downloaded under the model's Apache license.

## Deduplication and rejected claims

- **CMHA**, DOI10.6084/m9.figshare.26965450, and the paper https://pmc.ncbi.nlm.nih.gov/articles/PMC11557944/ describe the same dataset, not two candidates. Its published99patients/105MCAaneurysms plus44controls differ from Zenodo15697196's172-case cohort. Existing CMHA AHMU reference images and Zenodo case006 are different sources; the helper conflated them.
- The CMHA paper's article license is not the same question as the Figshare data license. Consult the actual data record for reuse rights.
- CADA is3DRA, ADAM isMRA, and IntrA is a geometry dataset without native CTA scans. Do not relabel them as CTA aneurysm detection datasets.
- Searching Medtronic's manuals library for WEB was a manufacturer/source error. WEB belongs to the TerumoNeuro/MicroVention channel. Official confirmation of the WEB17/VIA17 system: https://www.terumoneuro.com/newsroom/press-releases/lower-profile-web-intrasaccular-aneurysm-treatment-device-receives-fda . That2021release alone does not establish current IFU revision or complete current SKU availability.

## Operational consequence

Continue immediate engineering and reference work on the already acquired, CC-BY Zenodo data. Treat TopAneu as a genuine released voxel-label opportunity with a specific commercial-permission requirement, not as nonexistent data. Do not make licensing decisions, outreach or independence claims from helper summaries alone.
