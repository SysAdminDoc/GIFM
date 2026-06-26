# Roadmap — GIFM

## Research-Driven Additions

- [ ] P0 — Add a single local release verification gate
  Why: CI/release workflows were removed for local builds, but the portable ZIP still needs a repeatable trust gate.
  Evidence: commit `31a37d2`; `README.md` manual Verify sequence; `scripts/package-portable.mjs` packaging without generated checksums.
  Touches: `package.json`, `scripts/`, `scripts/package-portable.mjs`, `scripts/package-smoke.mjs`, `README.md`.
  Acceptance: one command runs typecheck, build, unit, smoke, UI smoke, portable package, package smoke, and writes a release manifest with SHA-256 hashes for the ZIP and bundled WebView2 bootstrapper.
  Complexity: M

- [ ] P0 — Refresh production dependency lock and add audit/freshness checks
  Why: production audit is clean, but the lock trails semver-allowed updates for React, React DOM, and Multer, including the upload parser.
  Evidence: `npm audit --omit=dev --json`; `npm outdated --json`; `package.json`; `package-lock.json`.
  Touches: `package-lock.json`, `package.json` if ranges change, `scripts/smoke.mjs`, `scripts/ui-smoke.mjs`.
  Acceptance: production dependencies are updated within declared ranges, `npm audit --omit=dev` is clean, upload smoke tests pass, and release verification fails on future production vulnerabilities.
  Complexity: S

- [ ] P1 — Hydrate persisted sources and completed jobs on startup
  Why: restart-safe server state exists but the primary UI only restores health and shell pending import.
  Evidence: `server/index.js` exposes `/api/sources` and `/api/jobs/history`; `src/App.tsx` startup effects fetch only `/api/health` and `/api/pending-import`.
  Touches: `src/App.tsx`, `src/types.ts`, `src/strings.ts`, `server/index.js` if response shape needs tightening.
  Acceptance: after restart, existing prepared sources and completed outputs appear in the UI with usable actions, missing files are shown as unavailable without crashes, and shell pending import still wins when present.
  Complexity: M

- [ ] P1 — Add manifest migration and corruption recovery coverage
  Why: unsupported or corrupt manifests are currently ignored silently, which risks losing trusted state as the manifest schema grows.
  Evidence: `server/index.js` `loadManifest()` and `saveManifest()` use `version: 1` and catch corrupt reads without backup or user-visible diagnostics.
  Touches: `server/index.js` or `server/manifest.js`, `server/*.test.js`, diagnostics payload.
  Acceptance: current manifests load, future-version manifests are preserved or backed up, corrupt manifests are renamed with a recovery note, and tests cover valid, corrupt, missing-path, and unsupported-version cases.
  Complexity: M

- [ ] P1 — Convert URL import into a cancellable progress job
  Why: long URL imports provide weaker feedback than encoding jobs and cannot be cancelled from the UI.
  Evidence: `server/index.js` `/api/import-url` runs yt-dlp with `--no-progress`; `src/components/SettingsPanel.tsx` `UrlImportRow` has only a busy state.
  Touches: `server/index.js`, `src/components/SettingsPanel.tsx`, `src/App.tsx`, `src/jobPolling.ts`, `src/strings.ts`, `scripts/smoke.mjs`.
  Acceptance: URL import reports percent/bytes/stage through SSE or polling, exposes cancel, cleans partial downloads, returns clear timeout/failure states, and preserves existing private-host rejection.
  Complexity: L

- [ ] P1 — Add security and remote-mode regression checks
  Why: GIFM has strong local security controls, but they should be protected by automated smoke assertions.
  Evidence: `server/index.js` security headers, remote rate limit, private URL rejection, cross-site write rejection; Express security best-practice docs.
  Touches: `scripts/smoke.mjs`, `server/index.js`, `README.md` if remote-mode guidance changes.
  Acceptance: smoke tests assert no `X-Powered-By`, expected CSP/security headers, cross-site write rejection, private URL import rejection, and rate limiting when `GIFM_ALLOW_REMOTE=1`.
  Complexity: S

- [ ] P1 — Clarify source-run versus packaged platform support
  Why: README badges imply Windows/macOS/Linux support while the portable desktop package is Windows-only, creating a distribution trust gap.
  Evidence: `README.md` platform badge and Portable Windows Package section; `scripts/package-portable.mjs` throws outside Windows; `Roadmap_Blocked.md` macOS/Linux package item.
  Touches: `README.md`, `CHANGELOG.md` only if release notes need clarification.
  Acceptance: docs clearly distinguish Node source-run platforms from the Windows portable app, explain the manual folder-replacement update path, and keep blocked macOS/Linux packaging out of active roadmap claims.
  Complexity: S

- [ ] P2 — Add visual regression snapshots for key UI states
  Why: current UI smoke covers text, overflow, locales, themes, focus, reduced motion, and ARIA, but not visual drift in loaded or completed states.
  Evidence: `scripts/ui-smoke.mjs`; `assets/screenshots/gifm-main.png`; Playwright screenshot snapshot docs.
  Touches: `scripts/ui-smoke.mjs`, `assets/screenshots/`, test fixtures, `src/styles.css` if instability is found.
  Acceptance: deterministic snapshots cover empty, source-loaded timeline, completed output, batch queue, mobile 375px, light theme, and high-contrast theme with a documented update command.
  Complexity: M

- [ ] P2 — Split remaining UI and server monoliths around workflow boundaries
  Why: `src/App.tsx` and `server/index.js` still concentrate unrelated workflows, slowing future recovery, import, and testing work.
  Evidence: `src/App.tsx` is 2,130 lines; `server/index.js` is 2,041 lines; `src/components/SettingsPanel.tsx` is 818 lines.
  Touches: `src/App.tsx`, `src/components/`, `src/jobPolling.ts`, `server/index.js`, `server/`, `server/*.test.js`.
  Acceptance: timeline, preview/output actions, startup recovery, manifest persistence, and URL import are in focused modules with unchanged public behavior and no regression in smoke/UI tests.
  Complexity: L

- [ ] P2 — Audit source-loaded mobile and touch timeline interaction
  Why: the timeline has accessible range inputs, but the visual rail preview uses mouse handlers and mobile smoke only verifies no overflow.
  Evidence: `src/App.tsx` `timeline-rail` uses `onMouseDown/onMouseMove/onMouseLeave`; `scripts/ui-smoke.mjs` mobile check is empty-state overflow only; WCAG target-size guidance.
  Touches: `src/App.tsx`, `src/styles.css`, `scripts/ui-smoke.mjs`, `src/strings.ts` if helper copy changes.
  Acceptance: source-loaded timeline controls work with pointer/touch, touch targets meet documented sizing, mobile smoke loads a fixture and verifies trim interaction without overflow or clipping.
  Complexity: M

- [ ] P2 — Add translation completeness and pseudolocale checks
  Why: deep-merge fallback prevents missing strings but can hide untranslated English in non-English locales.
  Evidence: `src/strings.ts` partial locale overrides with English fallback; `scripts/ui-smoke.mjs` checks only a small visible subset per locale.
  Touches: `src/strings.ts`, `scripts/ui-smoke.mjs`, `scripts/`.
  Acceptance: a check reports untranslated/fallback keys by locale, a pseudolocale catches clipping/overflow in core screens, and UI smoke still verifies en/es/fr/de/ja.
  Complexity: M
