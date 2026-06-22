# Roadmap - GIFM

## Research-Driven Additions

### P0
- [ ] P0 — Add upload validation, local-only guardrails, and disk quotas
  Why: Current uploads can write large untrusted files to disk before FFmpeg validation, and LAN exposure is not explicitly guarded.
  Evidence: `server/index.js` upload config; Express security docs; Multer README; CVE-2025-7338 context.
  Touches: `server/index.js`, upload policy helpers, cleanup/quota tests, `README.md`.
  Acceptance: Non-video/non-GIF and oversized files are rejected before FFmpeg; non-loopback `GIFM_HOST` requires explicit opt-in or emits a clear warning; uploads/output enforce max age and max bytes; tests cover malformed multipart, no-video, and limit paths.
  Complexity: M

- [ ] P0 — Add cancellable queued job runner with concurrency limits
  Why: Current jobs start FFmpeg work immediately with no cancel, backpressure, or child-process cleanup.
  Evidence: `server/index.js` `jobs` Map, `processJob`, and `runFfmpeg`; Shutter Encoder queue/batch behavior; Gifski batch issue.
  Touches: `server/index.js`, `src/App.tsx`, `scripts/smoke.mjs`, API tests.
  Acceptance: Jobs move through queued/running/cancelled/failed/completed states; only a configured number run at once; Cancel stops the FFmpeg child and cleans work files; UI shows queue position; tests prove cancellation and concurrency behavior.
  Complexity: L

- [ ] P0 — Harden API error handling and recovery states
  Why: Upload, probe, encode, and download failures are not normalized, and recovery guidance is sparse.
  Evidence: `server/index.js` upload/post/processJob catch paths; Express 5 error-handling docs; Multer storage docs.
  Touches: `server/index.js`, `src/App.tsx`, `scripts/smoke.mjs`.
  Acceptance: All API failures return a stable error shape; Multer errors use explicit middleware; failed uploads are cleaned; UI gives retry/clear actions; tests cover no file, bad JSON, too large, no video stream, ffprobe failure, and FFmpeg failure.
  Complexity: M

### P1
- [ ] P1 — Add Discord target profiles and output suitability checks
  Why: Discord size behavior is profile-dependent and currently changing experimentally, while GIFM only exposes 10 MB, 50 MB, and custom.
  Evidence: Discord File Attachments FAQ; Discord upload images/GIFs docs; `src/App.tsx` target presets.
  Touches: `src/App.tsx`, `server/index.js`, `README.md`.
  Acceptance: Profiles include Free 10 MB, Nitro Basic 50 MB, Full Nitro/custom, Emoji 256 KB, and avatar/server-icon guidance; completed output states whether it fits the selected target and recommends the next compression lever when it does not.
  Complexity: S

- [ ] P1 — Improve target-size fitting with frame-drop, duplicate-frame, and transparency optimization passes
  Why: Competitors expose frame dropping, duplicate-frame removal, transparency optimization, and LZW strategies; GIFM only adjusts width, FPS, colors, and optional duration.
  Evidence: Ezgif optimize; FreeConvert compressor; gifsicle optimizer issues; `server/index.js` `nextAttempt`.
  Touches: `server/index.js`, `src/App.tsx`, target-fit tests.
  Acceptance: Auto-fit can optionally remove every nth frame, merge near-duplicate frames, optimize unchanged pixels/transparency, and reject optimizer results larger than input; each attempt records the strategy used.
  Complexity: L

- [ ] P1 — Add visual trim and timeline controls with source metadata
  Why: Numeric start/duration fields are slower and less precise than current-position trim and movable range controls.
  Evidence: Ezgif video-to-GIF trim workflow; Gifski movable-trimmer issue; `src/App.tsx` `NumberField` start/duration controls.
  Touches: `src/App.tsx`, `server/index.js`.
  Acceptance: UI probes duration, resolution, FPS, codec, and rotation; users can drag a trim range and set start/end from the preview time; submitted settings match the visible range.
  Complexity: M

- [ ] P1 — Persist settings, saved presets, and recent outputs
  Why: Users should not recreate the same Discord export settings each session, and competitor users explicitly ask for remembered settings and recents.
  Evidence: Gifski settings/history issues; `src/App.tsx` `DEFAULT_SETTINGS`.
  Touches: `src/App.tsx`, browser storage helpers, `README.md`.
  Acceptance: Settings persist with a schema version; users can save named presets; recent outputs show filename, size, selected profile, and download/reveal actions while files still exist.
  Complexity: M

- [ ] P1 — Add batch conversion and reusable queue controls
  Why: Discord users often make several GIFs from exported clips, but GIFM only accepts one file per job.
  Evidence: Gifski batch issue; Shutter Encoder batch/watch behavior; FreeConvert apply/save preset behavior; `server/index.js` `upload.single('media')`.
  Touches: `server/index.js`, `src/App.tsx`, queue tests.
  Acceptance: Multi-file selection creates a queue, one preset can apply to all jobs, per-file status/size/attempts are visible, and each output can be downloaded or revealed individually.
  Complexity: L

- [ ] P1 — Add accessibility and reduced-motion polish
  Why: The UI lacks explicit focus-visible and reduced-motion handling, and Discord encourages alt text for uploaded images/GIFs.
  Evidence: `src/styles.css`; `src/App.tsx`; Discord upload images/GIFs docs.
  Touches: `src/styles.css`, `src/App.tsx`.
  Acceptance: All controls have visible keyboard focus, drag/drop has a keyboard-equivalent file picker path, progress uses ARIA progressbar semantics, animations respect reduced motion, and output includes an alt-text helper field.
  Complexity: S

- [ ] P1 — Add diagnostics panel and command/export log bundle
  Why: Users need to diagnose FFmpeg failures, binary-version mismatches, and source-media surprises without re-running from a terminal.
  Evidence: Shutter Encoder file-information/log behavior; ffmpeg-static package behavior; `server/index.js` health/log handling.
  Touches: `server/index.js`, `src/App.tsx`, `README.md`.
  Acceptance: UI shows FFmpeg/FFprobe path and version, platform, source stream metadata, estimated output size, final FFmpeg args, and one-click copy/export of diagnostic JSON.
  Complexity: M

### P2
- [ ] P2 — Add desktop or portable distribution packaging
  Why: The target user wants a local tool, but the current install path requires npm and terminal commands.
  Evidence: ScreenToGif distribution options; Gifski GUI distribution requests; `README.md` run instructions.
  Touches: package scripts, release workflow, build config, `README.md`.
  Acceptance: A Windows portable ZIP or installer launches GIFM and opens the browser automatically, includes bundled FFmpeg/FFprobe, documents update/uninstall steps, and ships with a smoke-tested release artifact.
  Complexity: L

- [ ] P2 — Add direct save and output-folder workflow
  Why: Fixed `data/output` plus browser download/reveal is less ergonomic than choosing an output folder or save target.
  Evidence: Shutter Encoder output-location workflow; MDN File System API; `server/index.js` output/download/reveal paths.
  Touches: `src/App.tsx`, `server/index.js`.
  Acceptance: User can choose an output directory or browser save target when supported; the app remembers the choice; fallback remains download/reveal on unsupported browsers.
  Complexity: M

- [ ] P2 — Add optional high-quality encoder backend abstraction
  Why: gifski is a quality benchmark, but licensing and packaging risk make it better as an optional backend instead of a hard dependency.
  Evidence: gifski README; Gifski app behavior; `server/index.js` hard-coded FFmpeg strategy.
  Touches: `server/index.js`, encoder modules, UI settings, `README.md` license notes.
  Acceptance: Encoder interface supports the existing FFmpeg backend and an optional user-provided gifski binary or WASM path; UI exposes backend choice; docs explain AGPL/commercial-license implications.
  Complexity: XL

### P3
- [ ] P3 — Centralize UI strings for later i18n
  Why: Localization is useful for mature media tools, but GIFM should first stabilize core reliability and distribution.
  Evidence: ScreenToGif localization workflow; hard-coded strings in `src/App.tsx`.
  Touches: `src/App.tsx`, string catalog tests.
  Acceptance: Visible UI strings move to a typed default-English catalog; no translation files are required yet; tests verify default English render paths.
  Complexity: S

- [ ] P3 — Explore WebCodecs or worker-based client preflight
  Why: Browser media APIs can improve preview and metadata speed, but FFmpeg should remain the dependable encode backend.
  Evidence: MDN WebCodecs; W3C WebCodecs; `src/App.tsx` object URL preview.
  Touches: `src/App.tsx`, optional worker helper.
  Acceptance: Supported browsers can sample metadata/frames before upload; unsupported browsers fall back to the current server probe without blocking conversion.
  Complexity: L
