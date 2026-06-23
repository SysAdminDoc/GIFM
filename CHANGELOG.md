# Changelog

## Unreleased

- Added an image overlay layer (logo/sticker/watermark) with position, size, and opacity controls, burned into the output before encoding.
- Added optional "Send to Discord" webhook upload from a completed output, validating the webhook URL against an https Discord-host allowlist (no SSRF) and the 10 MiB webhook cap.
- Added URL import: paste a video URL to download it via yt-dlp (from PATH or `GIFM_YTDLP_PATH`) and stage it as a prepared source; missing yt-dlp degrades gracefully.
- Added rotate (90/180/270) and horizontal/vertical flip controls.
- Added color filters (grayscale, invert, sepia) and a saturation slider.
- Added an MP4 silent-loop output format (muted faststart H.264) that Discord autoplays inline at the smallest size; the auto-fit loop drives CRF.
- Added animated WebP as an output format (via bundled libwebp), Discord-native and typically much smaller than GIF, with the auto-fit loop driving WebP quality; avatars remain GIF-only.
- Expanded the smoke test with an encode-feature matrix covering crop, playback speed, reverse, boomerang, Bayer dither, loop count, captions, and the sticker APNG path (asserting the recorded FFmpeg command and 320x320 `image/apng` output).
- Pruned the portable Windows package to production dependencies only (dropped playwright/typescript/vite devDependencies, server test files, and non-Windows FFprobe binaries), shrinking bundled `node_modules` from ~562 MB to ~234 MB.

## v0.3.0 - 2026-06-23

- Added an optional gifsicle `-O3` post-optimization pass with lossy LZW compression as an auto-fit lever, detected from `PATH` or `GIFM_GIFSICLE_PATH`, surfaced as an "Optimize with gifsicle" toggle and an optimizer diagnostics row.
- Added a GIF loop control (infinite, play once, or a fixed loop count) applied through the FFmpeg and gifski encoders.
- Added a gifski quality slider, replacing the hardcoded quality value when the gifski backend is selected.
- Pinned the emoji target to a square 128x128 output and the avatar target to a square output via center-crop, so dimension-constrained Discord targets produce valid GIFs.
- Extracted the pure encoding-strategy, settings, and retention helpers into `server/encoding.js` and added a `node:test` unit suite (`npm run test:unit`).
- Added a Boosted 100 MB target preset for Level 3 server boost upload limits.
- Upgraded lucide-react to v1.x for a smaller dependency footprint.
- Improved auto-fit convergence with prediction-based frame-rate steps and deeper width cuts when far over target, reaching the size target in fewer encode passes.
- Added a playback speed control (0.25x-4x) and reverse/boomerang playback modes, applied through both the FFmpeg and gifski pipelines and accounted for in the size estimate.
- Added a crop control with a live preview overlay and position/size sliders that crops the source region before scaling.
- Added persisted light and high-contrast themes with a topbar theme selector, OS-preference detection on first load, and a flash-free pre-paint theme apply.
- Added a batch "Download all" action that streams completed outputs as a single ZIP via a dependency-free store-method archive writer.
- Added a Content-Security-Policy to the served UI and exposed a Bayer dither scale control (0-5).
- Added an APNG output format and a Sticker 512 KB target that exports a square 320x320 animated PNG for Discord stickers.
- Added top/bottom meme caption overlays rendered with a bundled SIL OFL font (Anton), burned into the output before scaling.
- Added locale switching with a Spanish translation and a topbar language selector; missing keys fall back to English.
- Bundled the Microsoft Edge WebView2 bootstrapper in the portable package and made `GIFM.exe` auto-install the runtime on first launch when it is missing.

## v0.2.0 - 2026-06-22

- Added a timeline editor with timecode fields, playhead-aware start/end marking, a visual selection rail, saved GIF cuts, and per-cut or all-cuts export actions.
- Added reusable prepared-source sessions so one long local video can be uploaded once and reused for many clip exports.
- Raised the default local upload ceiling to 20 GB, the managed data ceiling to 25 GB, and the trim start ceiling to 24 hours for long source videos.
- Added upload validation, typed API errors, local-only host guardrails, disk retention limits, and failed-job cleanup.
- Added a cancellable job queue with configurable concurrency and queue positions.
- Added expanded Discord target profiles and output suitability guidance.
- Added target-fit attempt strategies for duplicate-frame removal, nth-frame dropping, transparency rectangle optimization, and larger-than-source GIF rejection.
- Added local source probing plus a visual trim timeline with current-preview start/end controls.
- Added persisted settings, named presets, and recent output shortcuts.
- Added multi-file batch submission with per-file queue status, attempts, cancel, download, and reveal actions.
- Added visible focus states, reduced-motion handling, ARIA progress semantics, and an output alt-text helper.
- Added runtime diagnostics with FFmpeg/FFprobe versions, platform info, output estimate, latest FFmpeg command, and JSON export.
- Added Windows portable packaging and smoke testing scripts.
- Added a self-contained portable Windows `GIFM.exe` launcher that starts the bundled local server and opens the app.
- Changed the portable Windows `GIFM.exe` into a desktop WebView2 shell instead of a browser-launch-only wrapper.
- Added configurable `GIFM_OUTPUT_DIR` and a browser Save as action with download fallback.
- Added an optional user-provided gifski encoder backend with health diagnostics and licensing notes.
- Centralized the default English UI copy in a typed string catalog and added a UI smoke test for render coverage.
- Added browser-side source metadata/frame preflight before upload with FFprobe fallback.
- Refined the app hierarchy with local runtime trust cues, grouped settings, stronger empty states, calmer disabled/loading states, and mobile-first workflow ordering.
- Hardened job cleanup, retention, trim edge cases, invalid concurrency configuration, clipboard feedback, and stale recent-output recovery.
- Expanded the smoke test to cover malformed multipart uploads, upload size limits, unsupported content, no-video media, and the successful GIF path.
- Expanded the smoke test to cover queued and running job cancellation.

## v0.1.0 - 2026-06-22

- Initial GIFM release with local FFmpeg-backed video-to-GIF conversion.
- Added Discord 10 MB, Nitro 50 MB, and custom size targets.
- Added iterative GIF fitting by width, FPS, palette size, and optional duration trim.
- Added React/Vite interface with preview, progress, log, output size, download, and open-output controls.
- Added smoke test that generates a sample video and verifies a real GIF export.
- Suppressed FFmpeg palette image-sequence noise so the embedded log stays focused on actionable encoding details.
