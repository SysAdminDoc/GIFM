# Research — GIFM

## Executive Summary
[Verified] GIFM v0.5.2 is a local-first React/Vite + Express + WebView2 GIF/video converter focused on Discord-ready exports, with bundled FFmpeg/FFprobe, prepared source sessions, timeline trimming, frame editing, batch conversion, diagnostics, i18n, and Discord fit simulation. Its strongest current shape is not a generic media editor; it is a fast, private, local conversion workstation for people who need predictable upload-size outcomes. Highest-value direction: harden trust and recovery around the existing workflows before expanding scope. Top opportunities, in order: release verification after CI removal; dependency-lock refresh discipline; startup hydration of persisted jobs/sources; manifest migration and corruption recovery; cancellable/progress URL imports; security-header and remote-mode regression tests; platform/distribution clarity; visual regression snapshots across states/themes; source-loaded mobile/touch timeline audit; translation completeness checks.

## Product Map
- [Verified] Core workflows: load/drop local media or URL/shell import; inspect client/server metadata; trim source and save clips; tune encoder/format/size presets; export single or batch outputs with progress, logs, diagnostics, reveal, save-as, Discord webhook, and recent outputs.
- [Verified] User personas: Discord emoji/sticker/server admins; creators compressing clips to upload limits; support/community users making quick GIFs; power users comparing encoder and palette settings locally.
- [Verified] Platforms and distribution: source-run web app is Node 20+ on desktop OSes; packaged desktop distribution is Windows x64 portable via .NET 8 WebView2 launcher; macOS/Linux packages remain blocked in `Roadmap_Blocked.md`.
- [Verified] Key integrations and data flows: browser file input/XMLHttpRequest upload -> `server/index.js` multer temp files -> magic-byte/FFprobe validation -> FFmpeg/gifski/gifsicle encoders -> `data/output/`; sources/jobs persist in `data/manifest.json`; UI settings/presets/clips/recents persist in localStorage; job updates use SSE with polling fallback.

## Competitive Landscape
- **ScreenToGif**: Excellent recorder/editor mental model, per-frame editing, and Windows polish. GIFM should learn from its preview/debuggability expectations and dependency-download failure modes. Avoid expanding into screen/region recording unless the maintainer explicitly accepts that scope shift.
- **gifski + gifsicle**: Strongest dedicated GIF encoding/optimization ecosystem. GIFM already exposes optional paths; learn from their issue queues around frame dropping, WASM builds, and malformed GIF safety. Avoid bundling AGPL/GPL optional binaries without an explicit license and redistribution decision.
- **LosslessCut**: Strong FFmpeg desktop workflow with session persistence and export/interchange formats. GIFM should learn from durable session restore and clear clip-state recovery. Avoid broad non-destructive video-editor scope such as CSV/EDL import unless it directly improves GIFM clip batching.
- **Ezgif**: Table-stakes GIF utility breadth: optimize, split frames, resize, crop, effects, format conversion. GIFM should learn from simple, direct task affordances and fast before/after feedback. Avoid server-hosted privacy tradeoffs and ad-heavy multi-tool sprawl.
- **Kapwing / VEED / CloudConvert**: Commercial tools package progress visibility, subtitles, presets, file persistence, and hosted export flows. GIFM should learn from polished progress/recovery and explicit tier limits. Avoid cloud accounts, watermarking, team workspaces, or paywall-shaped complexity.
- **ShareX / File Converter**: Useful adjacent patterns for shell integration, fast local workflows, and context-menu conversion. GIFM should learn from settings search and shell performance complaints. Avoid becoming a general-purpose converter with unrelated formats.
- **Discord / Lilliput platform behavior**: Discord's image pipeline and WebP/AVIF support make format-aware presets valuable. GIFM should continue tracking Discord-specific size/format behavior. Avoid claiming exact platform parity where Discord behavior is server-side and can change.

## Security, Privacy, and Reliability
- [Verified] `server/index.js` has good local-first guardrails: loopback binding by default, `GIFM_ALLOW_REMOTE` opt-in, cross-site write rejection, private/loopback URL rejection for URL import, rate limiting in remote mode, CSP, `X-Content-Type-Options`, `Referrer-Policy`, COOP, and CORP.
- [Verified] `npm audit --omit=dev --json` reported 0 production vulnerabilities on 2026-06-26. `npm outdated` still showed the lock trailing semver-allowed production updates for `react`, `react-dom`, and `multer`; upload parsing and UI runtime should be refreshed with smoke coverage.
- [Verified] Commit `31a37d2` removed `.github/workflows/ci.yml` and `.github/workflows/release.yml` for local builds only. `README.md` documents a manual verification sequence, but there is no single release gate or checksum/provenance manifest for the portable ZIP and downloaded WebView2 bootstrapper.
- [Verified] `scripts/package-portable.mjs` downloads `MicrosoftEdgeWebview2Setup.exe` from a Microsoft redirect and includes it if the download looks large enough; the package has smoke testing but no generated release manifest with hashes.
- [Verified] `server/index.js` persists sources and completed jobs to `data/manifest.json`, and exposes `/api/sources` and `/api/jobs/history`; `src/App.tsx` only hydrates `/api/health` and `/api/pending-import` on startup, so restart-safe state exists server-side but is not restored into the primary UI.
- [Verified] `loadManifest()` silently drops unsupported manifest versions and corrupt JSON. That is acceptable for a convenience cache today, but it will become risky once users rely on prepared source sessions and recent outputs.
- [Verified] URL import is synchronous from the UI's perspective: `/api/import-url` runs yt-dlp with `--no-progress`, a 5-minute timeout, and no cancel endpoint; `UrlImportRow` shows only a busy button. Long downloads have weaker feedback than encode jobs.

## Architecture Assessment
- [Verified] `src/App.tsx` is 2,130 lines and still owns startup, uploads, timeline editor, preview/output, batch state, and job orchestration. Refactor candidates: startup hydration hook, `TimelineEditor`, `PreviewPanel`, output actions, and batch/job controller.
- [Verified] `server/index.js` is 2,041 lines and owns routing, upload handling, URL import, job lifecycle, security middleware, manifest persistence, retention, FFprobe helpers, and diagnostics. Refactor candidates: route modules, manifest store, URL import service, retention service, security middleware tests.
- [Verified] `src/styles.css` is 2,318 lines. The visual system is cohesive, but regression coverage is mostly smoke/overflow checks; `scripts/ui-smoke.mjs` does not use Playwright visual snapshots for source-loaded, completed-output, or high-contrast states.
- [Verified] Accessibility baseline is strong: focus-visible styles, reduced-motion CSS, ARIA progress, live status, hidden motion state, semantic empty states, and keyboard range inputs. Gap: source-loaded timeline rail preview uses mouse-only handlers and mobile smoke only verifies no overflow, not touch/timeline interaction.
- [Verified] i18n has English plus partial Spanish/French/German/Japanese overrides using deep merge fallback. This prevents missing strings but can hide untranslated English in non-English locales; current UI smoke checks only a small visible subset.
- [Verified] Observability is good for encode jobs (SSE, fallback polling, logs, latest command, diagnostics bundle) but not for URL import, release packaging, or manifest recovery events.
- [Likely] WebCodecs could improve client-side frame sampling for supported formats, but current FFmpeg-backed server processing is the right primary engine. Treat WebCodecs as a measured spike only, not a replacement.

## Rejected Ideas
- Cloud accounts, hosted projects, team collaboration, and multi-user permissions — contradicted by GIFM's local-first privacy model. Source: Kapwing/VEED commercial feature sets.
- Full screen/region recorder — valuable in ScreenToGif/Kap, but already blocked as a philosophy/scope decision in `Roadmap_Blocked.md`.
- macOS/Linux packaged apps — already blocked in `Roadmap_Blocked.md` by target build environments and launcher strategy; docs clarity is still recommended.
- Auto-update via Velopack/winget — already blocked in `Roadmap_Blocked.md` pending signing/release-feed decisions.
- FFmpeg 7 `palettegen/paletteuse use_alpha` — already blocked in `Roadmap_Blocked.md` because `ffmpeg-static` still ships an older FFmpeg.
- Plugin marketplace or arbitrary encoder plugins — too much maintenance/security surface for a focused local converter. Source: ShareX/File Converter breadth.
- ffmpeg.wasm as the primary processing engine — worse fit for 20 GB local uploads, optional native tools, and Windows portable packaging; keep FFmpeg native.
- AI upscaling/interpolation/background removal — not supported by project dependencies, adds model/GPU bloat, and does not improve the core Discord-fit workflow.

## Sources
### OSS and adjacent tools
- https://github.com/NickeManarin/ScreenToGif
- https://github.com/NickeManarin/ScreenToGif/issues/1461
- https://github.com/NickeManarin/ScreenToGif/issues/1460
- https://github.com/NickeManarin/ScreenToGif/issues/1458
- https://github.com/mifi/lossless-cut
- https://github.com/mifi/lossless-cut/issues/2727
- https://github.com/ImageOptim/gifski
- https://github.com/ImageOptim/gifski/issues/372
- https://github.com/kohler/gifsicle
- https://github.com/kohler/gifsicle/issues/217
- https://github.com/ShareX/ShareX
- https://github.com/Tichau/FileConverter

### Commercial tools
- https://ezgif.com/
- https://www.kapwing.com/tools/make/gif
- https://www.veed.io/tools/video-to-gif
- https://cloudconvert.com/mp4-to-gif

### Platform, standards, and docs
- https://discord.com/blog/modern-image-formats-at-discord-supporting-webp-and-avif
- https://discord.com/blog/how-discord-resizes-150-million-images-every-day-with-go-and-c
- https://support.discord.com/hc/en-us/articles/4402687377815-Tips-for-Sticker-Creators-FAQ
- https://github.com/discord/lilliput
- https://ffmpeg.org/ffmpeg-filters.html
- https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
- https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

### Security, release, and testing
- https://expressjs.com/en/advanced/best-practice-security.html
- https://helmetjs.github.io/
- https://playwright.dev/docs/test-snapshots
- https://docs.npmjs.com/generating-provenance-statements
- https://github.com/ossf/scorecard

## Open Questions
None.
