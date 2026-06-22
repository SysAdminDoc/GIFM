# GIFM

![Version](https://img.shields.io/badge/version-v0.1.0-4ecdc4)
![License](https://img.shields.io/badge/license-MIT-b7e35f)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-ffbd5b)

GIFM v0.1.0 is a local GIF maker and compressor for Discord-ready animated GIFs. It converts MP4, MOV, WebM, AVI, MKV, and existing GIF files with bundled FFmpeg, then retries width, FPS, and palette settings until the output fits the selected target.

## Features

- Discord Free 10 MB, Nitro Basic 50 MB, Full Nitro 500 MB, Emoji 256 KB, icon/avatar, and custom target presets.
- Video-to-GIF conversion from common video files.
- Existing GIF recompression through the same palette workflow.
- Multi-file batch submission through the same local queue and current preset.
- Visual trim timeline with source duration, resolution, FPS, codec, and rotation metadata.
- Auto-fit loop for width, frame rate, color count, duplicate-frame removal, nth-frame dropping, transparency rectangles, and optional duration trimming.
- Local preview, queued/running progress, cancellable jobs, FFmpeg log, exact output byte count, and download/open-output actions.
- Output suitability and attempt strategy copy that says whether the GIF fits the selected Discord target and which compression lever was used.
- Persisted settings, named presets, and recent outputs in browser storage.
- Keyboard-visible focus states, reduced-motion support, ARIA progress, and an output alt-text helper.
- Diagnostics panel with FFmpeg/FFprobe versions, platform info, source estimate, latest FFmpeg command, and copy/download JSON bundle.
- Save-as output flow using the browser file picker when available, with download fallback.
- Optional user-provided gifski backend for higher-quality encodes while keeping GIFM's bundled FFmpeg path as the default.

## Run Locally

```powershell
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The API runs on `http://127.0.0.1:4174`.

## Production Build

```powershell
npm run build
npm run preview
```

`npm run preview` serves the built app and API from `http://127.0.0.1:4174`.

## Portable Windows Package

```powershell
npm run package:portable
npm run package:smoke
```

The portable artifact is written to `release/GIFM-v<version>-win-x64/` and zipped beside it. It includes the built client, Express server, current Node runtime, `node_modules`, bundled FFmpeg/FFprobe modules, and `start-gifm.cmd`. To update a portable copy, replace the folder with a newly generated package.

## Verify

```powershell
npm run typecheck
npm run build
npm run test:smoke
npm run test:ui
npm run package:portable
npm run package:smoke
```

The smoke test generates a small local MP4, uploads it to GIFM, waits for the job to finish, downloads the result, validates the GIF header, and checks that the file fits the configured byte target.
The UI smoke test serves the built app and verifies the default English interface renders through the shared string catalog.

## Output Location

Generated GIFs are stored under `data/output/`. Uploaded sources, smoke artifacts, and temporary work files stay under `data/`; the directory is ignored by Git.

## Optional gifski Backend

GIFM does not bundle gifski. To enable it, install a gifski binary yourself and point GIFM at it before starting the app:

```powershell
$env:GIFM_GIFSKI_PATH = "C:\Tools\gifski.exe"
npm run dev
```

The Encoder setting then exposes `gifski` beside the default FFmpeg palette encoder. gifski is AGPL-licensed unless you use a commercial license, so verify the license before redistributing any package that includes or depends on it.

## Local Safety Controls

GIFM binds to `127.0.0.1` by default and rejects non-local hosts unless `GIFM_ALLOW_REMOTE=1` is set on a trusted network. Uploads are limited to 2 GB by default and are checked before FFmpeg runs.

Optional environment controls:

```powershell
$env:GIFM_MAX_UPLOAD_MB = "2048"
$env:GIFM_DATA_MAX_MB = "5120"
$env:GIFM_DATA_MAX_AGE_HOURS = "24"
$env:GIFM_MAX_CONCURRENT_JOBS = "1"
$env:GIFM_OUTPUT_DIR = "D:\GIFM-output"
$env:GIFM_GIFSKI_PATH = "C:\Tools\gifski.exe"
npm run dev
```

Completed outputs, uploads, and temporary work files are pruned by age and total size so abandoned runs do not keep filling disk.
