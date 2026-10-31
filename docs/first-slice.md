# First exercised slice

Goal: establish the new build with private, ignored credentials and real Meta/Baseten tool-call round trips before connecting clinical imaging.

Acceptance criteria:
1. Fixed HTTPS provider endpoints and exact model IDs. No contributor model by default.
2. Credentials never appear in repr, logs, exceptions, reports, or git.
3. Tool arguments are JSON objects, validated before dispatch. Unknown tools and cross-case arguments fail before executing a handler.
4. Model calls, tool calls, output tokens, per-request timeouts, and total elapsed time are bounded. No silent retry or provider fallback.
5. Preserve the complete assistant tool-call message in history, including opaque reasoning fields, when returning tool results.
6. Both keys are exercised against their actual catalog and a nonclinical developer-defined tool. Save only sanitized results and token/latency metadata.
7. Offline tests cover malformed responses, exhausted output, refusal, schema/case failures and redaction. A real round trip is separate evidence from offline tests.

Implementation sequence: tests RED for provider settings, implement settings GREEN; adapter RED, adapter GREEN; bounded runner RED, runner GREEN; live smoke and report. Keep source/tests distinct from ignored artifacts. No frontend, segmentation endpoint, or imaging data is implied by this slice.

Routing recommendation: product Muse Spark Open on Baseten; Meta standard Muse for optional Hermes workers and direct alternative model tests; Meta SAM for future ROI corrections. Do not change Hermes default model or delegation policy in this slice. Fireworks redemption is optional and cannot block the build.
