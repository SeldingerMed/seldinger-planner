# Seldinger Planner

New CTA-first intracranial aneurysm planning application. This is a new build, not a port of seldinger-app. Reuse Seldinger-trained segmentation and exact preprocessing behind explicit adapters. Preserve the old app and ML worktrees.

Follow the Hermes-native engineering harness and test-driven development. Never use OMP. No patient/partner data, model weights, credentials, or bulk generated artifacts in git. Never read or print .env during ordinary code review. Secrets belong only in ignored .env (0600), never in frontend environment variables or config files.

Distinguish trained inference, curated annotations, clinician edits, synthetic fixtures, and cached outputs. No automatic aneurysm-detection or clinical-validity claims without measured evidence. Every future case tool must bind to server-selected case identity and artifact version. Never give the product agent shell access or arbitrary filesystem/URL tools.

Current slice: provider adapters and a bounded nonclinical tool-call conformance probe. It is not a clinical planning application yet. No clinical images are sent by this slice. No external deployment is authorized by this file.
