# GIFM

![Version](https://img.shields.io/badge/version-v0.1.0-4ecdc4)
![License](https://img.shields.io/badge/license-MIT-b7e35f)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-ffbd5b)

GIFM v0.1.0 is a local GIF maker and compressor for Discord-ready animated GIFs. It converts MP4, MOV, WebM, AVI, MKV, and existing GIF files with bundled FFmpeg, then retries width, FPS, and palette settings until the output fits the selected target.

## Features

- Discord 10 MB, Nitro 50 MB, and custom target presets.
- Video-to-GIF conversion from common video files.
- Existing GIF recompression through the same palette workflow.
- Trim controls for start time and duration.
- Auto-fit loop for width, frame rate, color count, and optional duration trimming.
- Local preview, progress, FFmpeg log, exact output byte count, and download/open-output actions.

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

## Verify

```powershell
npm run typecheck
npm run build
npm run test:smoke
```

The smoke test generates a small local MP4, uploads it to GIFM, waits for the job to finish, downloads the result, validates the GIF header, and checks that the file fits the configured byte target.

## Output Location

Generated GIFs are stored under `data/output/`. Uploaded sources, smoke artifacts, and temporary work files stay under `data/`; the directory is ignored by Git.
