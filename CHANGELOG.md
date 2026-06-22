# Changelog

## Unreleased

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
