# Private tailnet browser access

Scope: browser access to the existing nonclinical public-data prototype. This is not device mechanics, hemodynamics, or outcome validation.

## Runtime

The Studio is headless. User-facing links use its verified Tailscale IPv4 and port, not a loopback address. Discover the current address with the installed Tailscale CLI rather than treating an example address as permanent.

Start the API with `SELDINGER_BROWSER_ORIGINS=http://<studio-tailnet-ip>:5173 .venv/bin/python -m planner.server`. The API remains bound to loopback port8765. Start the frontend from `web/` with `npm run dev -- --host <studio-tailnet-ip> --port 5173 --strictPort`. Vite proxies `/api` to the loopback API. These are local development processes, not an installed startup service or public deployment. No public tunnel is involved. The repository's default listener remains loopback-only.

The optional browser-origin grant accepts only exact HTTP/HTTPS IPv4 origins in100.64.0.0/10, with a positive explicit port and no credentials, path, query, or fragment. Noncanonical uppercase schemes are rejected rather than silently normalized. An unconfigured browser origin is denied. This Origin check is a browser-request defense, not application authentication. Network access relies on the existing tailnet identity and ACL boundary.

## Browser compatibility

HTTP IP-address origins are not secure contexts. `crypto.subtle` and `crypto.randomUUID` are unavailable there, although `crypto.getRandomValues` remains available. The browser helper retains native SHA-256 where available and otherwise uses exactly pinned upstream `@noble/hashes`2.4.0. Hash comparisons and existing artifact read caps are retained. UUIDv4 identifiers use `getRandomValues`, with version and variant bits set explicitly. No `Math.random` fallback is used.

An explicit `?case=<22-character-base64url-id>` link reopens the selected existing case on a fresh browser after its image is loaded. Both returned case identity and image fingerprint must match. Missing, mismatched, and malformed explicit links do not create a replacement case. This does not make browser-local device scenarios shared server-side across devices.

## Observed verification

- Real private tailnet URL: public calibrated CTA opened with its existing revision13 case, accepted anatomy, and geometry result.
- Actual browser reported an insecure context and unavailable native UUID API. A placement was saved with a valid random v4 identifier, the studio was closed and reopened, and the stored placement restored with the same5mm exploratory length and no alerts. The temporary scenario was removed using an exact-value compare, preserving prior stored values.
- The5mm geometry was an exploratory renderer/serialization test, not a source-listed nominal size or treatment recommendation. A20mm device was correctly rejected for exceeding the available operator path.
- A development hot-reload WebGL-context failure occurred during verification and cleared after a cold reload. This does not establish graphics reliability on every client.
- Frontend:203 tests across36 files, typecheck, and production build passed. Production npm audit reported zero vulnerabilities. Existing large-chunk build warnings remain.
- Base suite before final two parser-hardening cases:563 passed,99 skipped. Final focused access/safety suite:10 passed. Ruff on the changed Python files and `git diff --check` passed.
- Independent read-only review found no blockers. Its two low-severity configuration observations, port0 and noncanonical uppercase schemes, were reproduced with failing tests and fixed. Subsequent formatting and this small parser-hardening delta were verified by the parent; the original review manifest is not an exact-final-byte review certificate.

Generated browser receipt: ignored `artifacts/tailnet-access/verification.json`. No CTA, segmentation, model, credential, or generated device asset is included in this source change.
