# Research - GIFM

## Executive Summary
GIFM is a local React/Vite plus Express tool for turning MP4/video files and existing GIFs into Discord-sized animated GIFs with bundled FFmpeg/FFprobe and iterative fitting. Verified: its strongest current shape is a focused, privacy-preserving single-file workflow with Discord 10 MB / 50 MB targets, palettegen/paletteuse encoding, preview, logs, and exact output size. The highest-value direction is to make the local compressor trustworthy under real workloads before adding breadth: upload/job guardrails, cancellable queues, better target-size fitting, trim UX, persistent presets/history, accessibility, diagnostics, packaging, output-folder control, and optional higher-quality encoder backends.

Top opportunities, in order:
- P0: Add upload validation, local-only exposure guardrails, disk quotas, cleanup, and typed API errors.
- P0: Add cancellable queued jobs with concurrency limits and FFmpeg child-process cleanup.
- P1: Expand Discord profiles and output-fit checks beyond the current Free/Nitro/custom targets.
- P1: Improve auto-fit with duplicate-frame removal, frame-drop, unchanged-pixel/transparency optimization, and never-larger safeguards.
- P1: Add a visual trim timeline with source metadata and current-preview-time capture.
- P1: Persist settings, saved presets, and recent outputs.
- P1: Add batch conversion while preserving the focused Discord-GIF workflow.
- P1: Add focus-visible, reduced-motion, ARIA progress, keyboard drag/drop parity, and output alt-text helper.
- P2: Package a Windows-friendly portable/installer distribution so users do not need npm.
- P2/P3: Add output-folder save flow, optional gifski backend, i18n-ready strings, and WebCodecs preflight after core reliability lands.

## Product Map
- Core workflows: select one video/GIF, tune target/trim/width/FPS/colors/dither, upload to local API, encode with FFmpeg, inspect attempts/logs, download or reveal output.
- Core workflows: recompress existing GIFs, generate Discord-ready GIFs from Premiere exports, retry with auto-fit attempts, and use smoke tests to verify local conversion.
- User personas: Discord users making shareable GIFs, creators exporting large clips from Premiere/After Effects, technical users who want FFmpeg-quality control without command lines, and privacy-conscious users avoiding cloud converters.
- Platforms and distribution: Node local web app on Windows/macOS/Linux, Vite browser UI, Express loopback server, bundled static FFmpeg/FFprobe, PWA manifest, no packaged installer yet.
- Key data flows: browser file selection -> `multer` upload to `data/uploads` -> `ffprobe` stream metadata -> FFmpeg palette/frame work in `data/work` -> GIF in `data/output` -> download/reveal endpoint.

## Competitive Landscape
- gifski / Gifski: best-in-class GIF quality via libimagequant, temporal dithering, high FPS, and GUI quality controls. Learn: expose encoder quality modes and optional backend abstraction. Avoid: making the first version dependent on AGPL/binary packaging complexity before core job safety exists.
- gifsicle: mature optimizer for GIF structure, LZW, frame/disposal behavior, transparency, resizing, and lossless/lossy optimization. Learn: add post-encode optimization strategies and a never-larger safeguard. Avoid: opaque optimizer passes without attempt-level explanation.
- Ezgif and FreeConvert: strong web UX for video-to-GIF, crop/resize, current-position trim, drop frames, duplicate-frame removal, transparency optimization, and presets. Learn: visual trim, profile presets, and explicit optimization levers. Avoid: cloud-upload privacy tradeoffs and SEO-tool sprawl.
- Gifcurry: combines GUI/CLI/library with trim, crop, text, GIF/video export, and broad input formats. Learn: crop and trim are high-value adjacent controls. Avoid: becoming a general creative editor before Discord-size reliability is solved.
- ScreenToGif and Kap: recorder/editor tools with batch-like workflows, multiple export formats, plugin/distribution ecosystems, and Windows/macOS install paths. Learn: history, packaging, queue UX, and export affordances. Avoid: screen-recording/editor scope creep.
- Shutter Encoder: professional batch encoder with media info, estimated output size, watch folders, logs, and output-location workflows. Learn: diagnostics, queue management, source metadata, and output folder control. Avoid: overwhelming simple Discord users with full transcoder complexity.
- CloudConvert, Kapwing, Adobe Express: polished cloud conversion and simplified presets. Learn: target-size presets, simple size choices, and clear upload/result steps. Avoid: accounts, cloud storage, collaboration, and paywalled workflows that contradict local-first privacy.

## Security, Privacy, and Reliability
- Verified risk: `server/index.js` accepts uploads up to 2 GB with `multer.diskStorage`, preserves the original extension, and has no content sniffing, MIME allowlist, retention quota, or failed-upload cleanup. This creates local disk-exhaustion and confusing failure risks.
- Verified risk: `GIFM_HOST` can bind beyond `127.0.0.1` with no explicit warning or auth. Express security guidance says not to trust user input and recommends defensive headers and reduced fingerprinting; if exposed on a LAN, GIFM accepts arbitrary media uploads and runs FFmpeg on them.
- Verified risk: `jobs` is an in-memory `Map` in `server/index.js`; server restart loses job state while files remain in `data/uploads` and `data/output`.
- Verified risk: `processJob` starts FFmpeg work without a cancel endpoint, process registry, queue, or concurrency limit. Multiple uploads can saturate CPU/disk, and abandoned jobs keep running.
- Verified risk: errors from bad JSON, Multer limits, no-video files, ffprobe failure, and FFmpeg failure are not normalized into one typed API error shape. Recovery copy and retry actions in `src/App.tsx` are minimal.
- Verified status: `npm audit` currently reports 0 vulnerabilities, and GIFM uses `multer` 2.0.2, which is the patched line for CVE-2025-7338. Keep the upgrade/audit path because media upload stacks are high-risk.
- Missing guardrails: content-type/signature validation, source duration/resolution cost preflight, output/input byte quotas, max job count, local-only opt-in, upload/output cleanup, and health diagnostics for FFmpeg/FFprobe versions.
- Recovery and rollback needs: cancel running FFmpeg, delete failed job artifacts, retry from prior settings, export diagnostic bundle, and preserve enough attempt metadata to explain why an output did or did not meet the target.

## Architecture Assessment
- `server/index.js` should be split into API routes, upload policy, job store/queue, FFmpeg runner, encoder strategy, cleanup/quota service, and diagnostics. The current single-file server makes reliability changes riskier than needed.
- `src/App.tsx` should be split into upload state, settings schema, job polling hook, preset/profile model, preview/timeline component, and result/history components. The current large component will become hard to extend for queue, history, and accessibility states.
- `nextAttempt` in `server/index.js` is the right boundary for target-size strategy, but it currently adjusts only width, FPS, colors, and optional duration. Add strategy objects so frame dropping, duplicate-frame removal, transparency optimization, and optional external optimizers are testable.
- `scripts/smoke.mjs` verifies the happy path. Test gaps: malformed upload, no-video upload, file-size limit, existing GIF recompress, target miss, multi-attempt strategy, queue/cancel, cleanup, reveal/download errors, and API error shape.
- UI gaps in `src/styles.css` and `src/App.tsx`: no explicit focus-visible styling, no reduced-motion handling, no ARIA progress semantics, no keyboard-equivalent drag/drop path called out, no persistent settings, no saved presets, no history, and no light/high-contrast theme strategy.
- Documentation gaps: no troubleshooting matrix for FFmpeg failures, no explanation of Discord target caveats/current size experiments, no packaged-app install path, no security/privacy boundary for LAN binding, no FFmpeg-static version/licensing note, and no dependency upgrade/audit routine.
- Distribution gap: `README.md` is npm-first. For the stated target user, a portable Windows build or installer should be a product requirement, not an afterthought.

## Rejected Ideas
- Full creative editor with stickers, effects, captions, and social templates: sourced from Kapwing/Gifcurry, but it conflicts with GIFM's focused Discord compressor purpose.
- Cloud conversion, accounts, team storage, or API billing: sourced from CloudConvert/Kapwing, but it contradicts the local-first privacy value.
- Discord bot upload automation: sourced from Discord workflow pain, but credentials, permissions, and platform-policy risk are not needed for local GIF creation.
- Animated WebP/APNG as the primary output: sourced from Discord community requests and ScreenToGif/Kap, but the user asked for animated GIFs for Discord; keep alternate formats as later export options only.
- Plugin marketplace now: sourced from Kap, but GIFM needs queue, presets, diagnostics, and packaging before third-party extension points.
- Browser-only FFmpeg.wasm replacement: sourced from browser-based compressor patterns and WebCodecs/File System APIs, but large WASM downloads and browser resource limits make it weaker than the current bundled-FFmpeg local architecture for long clips.
- Bundling gifski immediately: sourced from gifski/Gifski quality, but AGPL/commercial licensing, binary distribution, and pipeline complexity make it better as an optional backend after an encoder abstraction exists.
- Multi-user/server deployment: sourced from Express web-app patterns, but GIFM is a local single-user tool; harden LAN exposure rather than turning it into a hosted service.
- Native mobile app: sourced from Discord mobile usage, but GIFM's core value depends on local desktop files, bundled FFmpeg, and large creator exports; keep the browser UI responsive instead.

## Sources
OSS:
- https://github.com/ImageOptim/gifski/
- https://github.com/sindresorhus/Gifski
- https://github.com/kohler/gifsicle
- https://github.com/centminmod/ffmpeg-video-to-gif
- https://github.com/lettier/gifcurry
- https://github.com/NickeManarin/ScreenToGif
- https://github.com/wulkano/kap
- https://github.com/davisonio/awesome-gif

Commercial:
- https://ezgif.com/video-to-gif
- https://ezgif.com/optimize
- https://www.freeconvert.com/gif-compressor
- https://cloudconvert.com/mp4-to-gif
- https://www.kapwing.com/tools/convert/video-to-gif
- https://www.adobe.com/express/feature/video/convert/video-to-gif
- https://www.shutterencoder.com/documentation/

Platform and specs:
- https://support.discord.com/hc/en-us/articles/25444343291031-File-Attachments-FAQ
- https://support.discord.com/hc/en-us/articles/211866427-How-do-I-upload-images-and-GIFs
- https://ffmpeg.org/ffmpeg-filters.html
- https://www.w3.org/Graphics/GIF/spec-gif89a.txt
- https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
- https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- https://www.w3.org/TR/webcodecs/

Dependencies and security:
- https://expressjs.com/en/advanced/best-practice-security/
- https://expressjs.com/en/guide/error-handling/
- https://github.com/expressjs/multer/blob/main/README.md
- https://nvd.nist.gov/vuln/detail/CVE-2025-7338
- https://github.com/advisories/GHSA-g7r4-m6w7-qqqr
- https://github.com/eugeneware/ffmpeg-static

Community:
- https://superuser.com/questions/556029/how-do-i-convert-a-video-to-gif-using-ffmpeg-with-reasonable-quality
- https://www.reddit.com/r/AfterEffects/comments/vv3urp/how_to_compress_gif_file_size_for_export_without/

## Open Questions
None blocking prioritization.
