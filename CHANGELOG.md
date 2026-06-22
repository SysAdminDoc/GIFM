# Changelog

## Unreleased

- Added upload validation, typed API errors, local-only host guardrails, disk retention limits, and failed-job cleanup.
- Added a cancellable job queue with configurable concurrency and queue positions.
- Added expanded Discord target profiles and output suitability guidance.
- Added target-fit attempt strategies for duplicate-frame removal, nth-frame dropping, transparency rectangle optimization, and larger-than-source GIF rejection.
- Added local source probing plus a visual trim timeline with current-preview start/end controls.
- Expanded the smoke test to cover malformed multipart uploads, upload size limits, unsupported content, no-video media, and the successful GIF path.
- Expanded the smoke test to cover queued and running job cancellation.

## v0.1.0 - 2026-06-22

- Initial GIFM release with local FFmpeg-backed video-to-GIF conversion.
- Added Discord 10 MB, Nitro 50 MB, and custom size targets.
- Added iterative GIF fitting by width, FPS, palette size, and optional duration trim.
- Added React/Vite interface with preview, progress, log, output size, download, and open-output controls.
- Added smoke test that generates a sample video and verifies a real GIF export.
- Suppressed FFmpeg palette image-sequence noise so the embedded log stays focused on actionable encoding details.
