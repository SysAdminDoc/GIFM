import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ApiError,
  targetProfiles,
  clamp,
  even,
  formatBytes,
  parseFrameRate,
  parseLoopCount,
  normalizeTargetPreset,
  dimensionLockForPreset,
  parseSettings as parseSettingsRaw,
  nextAttempt,
  isProtectedPath,
  exceedsFrameBudget,
  discordTargetChecks
} from './encoding.js';
import { buildStoreZip } from './zip.js';
import { ctx } from './context.js';
import {
  videoFilterChain, buildChainOpts, overlayPosition, escapeMoviePath,
  resolveOverlayPath, resolveSubtitlePath, captionFilters, escapeDrawtextPath, escapeDrawtextText,
  strategyLabel, ditherFilter, trimArgs,
  runFfmpeg, runFfmpegToGifski, runGifsicle,
  encodeWithFfmpeg, encodeWithApng, encodeWithWebp, encodeWithMp4, encodeWithAvif, encodeWithGifski,
  optimizeOutput,
  recordCommand, commandToken, parseFfmpegTime,
  log, checkCancelled, cancelError, isCancellationError,
  trackChild, clearTrackedChild, killActiveChild, killChild
} from './encoders.js';

const VERSION = '0.5.1';
const PORT = parsePositiveInteger(process.env.GIFM_PORT ?? process.env.PORT, 4174);
const HOST = (process.env.GIFM_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const ALLOW_REMOTE = process.env.GIFM_ALLOW_REMOTE === '1';
const GIFSKI_PATH = process.env.GIFM_GIFSKI_PATH ? path.resolve(process.env.GIFM_GIFSKI_PATH) : '';
const GIFSICLE_CONFIGURED = Boolean(process.env.GIFM_GIFSICLE_PATH);
const GIFSICLE_PATH = GIFSICLE_CONFIGURED ? path.resolve(process.env.GIFM_GIFSICLE_PATH) : 'gifsicle';
const YTDLP_PATH = process.env.GIFM_YTDLP_PATH ? path.resolve(process.env.GIFM_YTDLP_PATH) : 'yt-dlp';
const MAX_UPLOAD_BYTES = parseByteLimit(process.env.GIFM_MAX_UPLOAD_BYTES, process.env.GIFM_MAX_UPLOAD_MB, 20 * 1024 * 1024 * 1024);
const DATA_MAX_BYTES = parseByteLimit(process.env.GIFM_DATA_MAX_BYTES, process.env.GIFM_DATA_MAX_MB, 25 * 1024 * 1024 * 1024);
const DATA_MAX_AGE_MS = parseHours(process.env.GIFM_DATA_MAX_AGE_HOURS, 24) * 60 * 60 * 1000;
const MAX_CONCURRENT_JOBS = parsePositiveInteger(process.env.GIFM_MAX_CONCURRENT_JOBS, 1);
const MAX_TRIM_START_SEC = parsePositiveInteger(process.env.GIFM_MAX_TRIM_START_SEC, 24 * 60 * 60);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const outputDir = process.env.GIFM_OUTPUT_DIR ? path.resolve(process.env.GIFM_OUTPUT_DIR) : path.join(dataDir, 'output');
const workDir = path.join(dataDir, 'work');
const overlayDir = path.join(dataDir, 'overlays');
const distDir = path.join(rootDir, 'dist');
const fontPath = path.join(rootDir, 'assets', 'fonts', 'Anton-Regular.ttf');
const ffprobePath = ffprobeStatic.path;
const jobs = new Map();
const sources = new Map();
let pendingImport = null;
const jobQueue = [];
let runningJobs = 0;
let manifestWritePending = false;
let manifestWriteQueued = false;
const supportedExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif']);
const manifestPath = path.join(dataDir, 'manifest.json');

await Promise.all([uploadDir, outputDir, workDir, overlayDir].map((dir) => fs.mkdir(dir, { recursive: true })));
assertLocalBinding();

if (!ffmpegPath || !ffprobePath) {
  throw new Error('Bundled FFmpeg or FFprobe binary was not found.');
}

const runtimeInfo = await getRuntimeInfo();

// Populate the shared context so encoder functions can access module-scope state.
ctx.ffmpegPath = ffmpegPath;
ctx.ffprobePath = ffprobePath;
ctx.fontPath = fontPath;
ctx.overlayDir = overlayDir;
ctx.workDir = workDir;
ctx.runtimeInfo = runtimeInfo;

await loadManifest();
await enforceDataRetention();

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDir),
  filename: (_request, file, callback) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    callback(null, `${Date.now()}-${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 1,
    parts: 4,
    fieldNestingDepth: 1,
    fieldNameSize: 200,
    fieldSize: 8192
  },
  fileFilter: (_request, file, callback) => {
    if (isAllowedUploadDescriptor(file)) {
      callback(null, true);
      return;
    }

    callback(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a GIF or common video file such as MP4, MOV, WebM, MKV, or AVI.'));
  }
});
const uploadMedia = upload.single('media');

const overlayUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, overlayDir),
    filename: (_request, file, callback) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      callback(null, `${randomUUID()}${['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png'}`);
    }
  }),
  limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 2, fieldNestingDepth: 1, fieldNameSize: 200, fieldSize: 8192 },
  fileFilter: (_request, file, callback) => {
    if (String(file.mimetype || '').startsWith('image/')) {
      callback(null, true);
      return;
    }
    callback(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload an image (PNG, JPG, WebP, or GIF) for the overlay.'));
  }
}).single('overlay');

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(rejectCrossSiteWrites);
if (ALLOW_REMOTE) {
  const RATE_LIMIT_MAX = parsePositiveInteger(process.env.GIFM_RATE_LIMIT_MAX, 60);
  app.use(rateLimit({ windowMs: 60_000, max: RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false }));
}
app.use(express.json({ limit: '128kb' }));

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    version: VERSION,
    ffmpeg: runtimeInfo.ffmpeg,
    ffprobe: runtimeInfo.ffprobe,
    gifski: runtimeInfo.gifski,
    gifsicle: runtimeInfo.gifsicle,
    font: runtimeInfo.font,
    platform: runtimeInfo.platform,
    host: HOST,
    remoteAllowed: ALLOW_REMOTE,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    dataMaxBytes: DATA_MAX_BYTES,
    dataMaxAgeHours: Math.round(DATA_MAX_AGE_MS / 60 / 60 / 1000),
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxTrimStartSec: MAX_TRIM_START_SEC,
    preparedSources: sources.size
  });
});

app.get('/api/sources', (_request, response) => {
  const list = [];
  for (const source of sources.values()) {
    if (source.inputPath && existsSync(source.inputPath)) {
      list.push(publicSource(source));
    }
  }
  response.json(list);
});

app.get('/api/jobs/history', (_request, response) => {
  const list = [];
  for (const job of jobs.values()) {
    if (job.status === 'complete' && job.outputPath && existsSync(job.outputPath)) {
      list.push(publicJob(job));
    }
  }
  response.json(list);
});

app.get('/api/sources/:id/thumbnails', async (request, response, next) => {
  try {
    const source = sources.get(request.params.id);
    if (!source || !source.inputPath || !existsSync(source.inputPath)) {
      sendApiError(response, new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.'));
      return;
    }
    const duration = source.metadata?.durationSec ?? 0;
    if (duration < 0.5) {
      response.json({ thumbnails: [] });
      return;
    }

    const count = Math.min(12, Math.max(4, Math.floor(duration / 2)));
    const thumbDir = path.join(workDir, `thumb-${randomUUID()}`);
    await fs.mkdir(thumbDir, { recursive: true });

    try {
      const thumbnails = [];
      for (let i = 0; i < count; i++) {
        const t = (i / count) * duration;
        const thumbPath = path.join(thumbDir, `t${i}.jpg`);
        try {
          await runFfmpegSimple(['-ss', String(t), '-i', source.inputPath, '-frames:v', '1', '-vf', 'scale=120:-2', '-q:v', '8', '-y', thumbPath]);
          const data = await fs.readFile(thumbPath);
          thumbnails.push({ timeSec: Number(t.toFixed(2)), dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` });
        } catch {
          // Skip frames that fail to extract.
        }
      }
      response.json({ thumbnails });
    } finally {
      await fs.rm(thumbDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/sources/:id/loops', async (request, response, next) => {
  try {
    const source = sources.get(request.params.id);
    if (!source || !source.inputPath || !existsSync(source.inputPath)) {
      sendApiError(response, new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.'));
      return;
    }
    const duration = source.metadata?.durationSec ?? 0;
    if (duration < 1) {
      response.json({ loops: [] });
      return;
    }

    const sampleCount = Math.min(Math.floor(duration), 30);
    const loopDir = path.join(workDir, `loop-${randomUUID()}`);
    await fs.mkdir(loopDir, { recursive: true });

    try {
      const refPath = path.join(loopDir, 'ref.png');
      await runFfmpegSimple(['-ss', '0', '-i', source.inputPath, '-frames:v', '1', '-vf', 'scale=160:-2', '-y', refPath]);

      const candidates = [];
      for (let i = 1; i <= sampleCount; i++) {
        const t = (i / sampleCount) * duration;
        const framePath = path.join(loopDir, `f${i}.png`);
        try {
          await runFfmpegSimple(['-ss', String(t), '-i', source.inputPath, '-frames:v', '1', '-vf', 'scale=160:-2', '-y', framePath]);
          const ssim = await computeSsimSimple(refPath, framePath);
          if (ssim !== null && ssim > 0.6) {
            candidates.push({ timeSec: Number(t.toFixed(2)), ssim: Number(ssim.toFixed(4)) });
          }
        } catch {
          // Skip frames that fail to extract.
        }
      }

      candidates.sort((a, b) => b.ssim - a.ssim);
      response.json({ loops: candidates.slice(0, 5) });
    } finally {
      await fs.rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/sources/:id/frames', async (request, response, next) => {
  try {
    const source = sources.get(request.params.id);
    if (!source || !source.inputPath || !existsSync(source.inputPath)) {
      sendApiError(response, new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.'));
      return;
    }
    const duration = source.metadata?.durationSec ?? 0;
    const fps = source.metadata?.fps ?? 15;
    if (duration < 0.1) {
      response.json({ frames: [] });
      return;
    }

    const frameId = randomUUID();
    const frameDir = path.join(workDir, `frames-${frameId}`);
    await fs.mkdir(frameDir, { recursive: true });

    const targetFps = Math.min(fps, 15);
    const maxFrames = Math.min(Math.ceil(duration * targetFps), 300);
    await runFfmpegSimple([
      '-i', source.inputPath,
      '-vf', `fps=${targetFps},scale=160:-2`,
      '-frames:v', String(maxFrames),
      '-y', path.join(frameDir, 'frame-%04d.png')
    ]);

    const files = (await fs.readdir(frameDir)).filter((f) => f.startsWith('frame-') && f.endsWith('.png')).sort();
    const frames = files.map((f, i) => ({
      index: i,
      file: f,
      url: `/api/frames/${frameId}/${f}`,
      delayCentiseconds: Math.round(100 / targetFps)
    }));

    response.json({ frameId, fps: targetFps, frameCount: frames.length, frames });
  } catch (error) {
    next(error);
  }
});

app.get('/api/frames/:frameId/:file', (request, response) => {
  const { frameId, file } = request.params;
  if (!/^[a-f0-9-]+$/.test(frameId) || !/^frame-\d{4}\.png$/.test(file)) {
    sendApiError(response, new ApiError(400, 'INVALID_FRAME_PATH', 'Invalid frame path.'));
    return;
  }
  const framePath = path.join(workDir, `frames-${frameId}`, file);
  if (!existsSync(framePath)) {
    sendApiError(response, new ApiError(404, 'FRAME_NOT_FOUND', 'Frame not found.'));
    return;
  }
  response.setHeader('Content-Type', 'image/png');
  response.setHeader('Cache-Control', 'public, max-age=3600');
  createReadStream(framePath).pipe(response);
});

app.post('/api/frames/encode', express.json({ limit: '512kb' }), async (request, response, next) => {
  try {
    const { sourceId, frameId, frames: frameSpec, settings: rawSettings } = request.body ?? {};
    const source = sources.get(sourceId);
    if (!source || !source.inputPath || !existsSync(source.inputPath)) {
      sendApiError(response, new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.'));
      return;
    }
    if (!frameId || !/^[a-f0-9-]+$/.test(frameId)) {
      sendApiError(response, new ApiError(400, 'INVALID_FRAME_ID', 'Invalid frame ID.'));
      return;
    }
    if (!Array.isArray(frameSpec) || frameSpec.length < 2 || frameSpec.length > 300) {
      sendApiError(response, new ApiError(400, 'INVALID_FRAME_SPEC', 'Provide 2-300 frames.'));
      return;
    }

    const frameDir = path.join(workDir, `frames-${frameId}`);
    if (!existsSync(frameDir)) {
      sendApiError(response, new ApiError(404, 'FRAMES_NOT_FOUND', 'Extracted frames not found. Re-extract from the source.'));
      return;
    }

    const settings = parseSettings(rawSettings);
    const outputExt = settings.format === 'apng' ? 'png' : settings.format === 'webp' ? 'webp' : 'gif';
    const outputPath = path.join(outputDir, `frame-edit-${randomUUID().slice(0, 8)}.${outputExt}`);

    const concatDir = path.join(workDir, `concat-${randomUUID()}`);
    await fs.mkdir(concatDir, { recursive: true });

    const concatLines = [];
    for (let i = 0; i < frameSpec.length; i++) {
      const spec = frameSpec[i];
      const idx = Number(spec.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 9999) continue;
      const srcFile = `frame-${String(idx + 1).padStart(4, '0')}.png`;
      const srcPath = path.join(frameDir, srcFile);
      if (!existsSync(srcPath)) continue;
      const destFile = `f${String(i).padStart(4, '0')}.png`;
      const destPath = path.join(concatDir, destFile);
      await fs.copyFile(srcPath, destPath);
      const rawDelay = Number(spec.delayCentiseconds);
      const delay = Math.max(1, Math.min(1000, Number.isFinite(rawDelay) ? Math.round(rawDelay) : 10)) / 100;
      concatLines.push(`file '${destFile}'`);
      concatLines.push(`duration ${delay}`);
    }
    if (concatLines.length < 4) {
      await fs.rm(concatDir, { recursive: true, force: true }).catch(() => {});
      sendApiError(response, new ApiError(400, 'NO_VALID_FRAMES', 'None of the specified frames could be resolved.'));
      return;
    }
    concatLines.push(`file '${concatLines[concatLines.length - 2].split("'")[1]}'`);

    const concatFile = path.join(concatDir, 'list.txt');
    await fs.writeFile(concatFile, concatLines.join('\n'));

    try {
      await runFfmpegSimple([
        '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-vf', `scale=${even(clamp(settings.width, 120, 1280))}:-2:flags=lanczos`,
        '-loop', String(settings.loopCount),
        '-y', outputPath
      ]);
    } catch (encodeError) {
      await fs.rm(concatDir, { recursive: true, force: true }).catch(() => {});
      throw encodeError;
    }

    await fs.rm(concatDir, { recursive: true, force: true }).catch(() => {});

    if (!existsSync(outputPath)) {
      throw new ApiError(500, 'ENCODE_FAILED', 'Frame encode produced no output.');
    }

    const stat = await fs.stat(outputPath);
    const job = createJob({ inputPath: source.inputPath, inputName: source.inputName, inputSize: source.inputSize, sourceKind: source.sourceKind, settings, sourceId });
    job.status = 'complete';
    job.outputPath = outputPath;
    job.outputBytes = stat.size;
    job.downloadUrl = `/api/jobs/${job.id}/download`;
    job.completedAt = new Date().toISOString();
    job.progress = 100;
    job.stage = 'Complete';
    job.attempts = [{ attempt: 1, width: settings.width, fps: 0, colors: 256, durationSec: 0, strategy: `${frameSpec.length} edited frames` }];
    jobs.set(job.id, job);
    saveManifest();

    response.status(201).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post('/api/sources', runUpload, async (request, response, next) => {
  try {
    if (!request.file) {
      sendApiError(response, new ApiError(400, 'NO_MEDIA_FILE', 'No media file was uploaded.'));
      return;
    }

    const mediaCheck = await inspectUploadedMedia(request.file.path);
    if (!mediaCheck.ok) {
      await removeFile(request.file.path);
      sendApiError(response, new ApiError(415, 'UNSUPPORTED_MEDIA_CONTENT', 'The uploaded file does not look like a supported GIF or video container.'));
      return;
    }

    const metadata = await ffprobe(request.file.path);
    const source = sourceMetadata(metadata);
    if (!source.video) {
      await removeFile(request.file.path);
      sendApiError(response, new ApiError(422, 'NO_VIDEO_STREAM', 'No video stream was found in the selected file.'));
      return;
    }

    const id = randomUUID();
    const prepared = {
      id,
      inputPath: request.file.path,
      inputName: request.file.originalname,
      inputSize: request.file.size,
      sourceKind: mediaCheck.kind,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      metadata: {
        durationSec: source.durationSec,
        width: source.width,
        height: source.height,
        fps: source.fps,
        codec: source.codec,
        rotation: source.rotation
      }
    };

    sources.set(id, prepared);
    await enforceDataRetention(new Set([prepared.inputPath]));
    saveManifest();
    response.status(201).json(publicSource(prepared));
  } catch (error) {
    if (request.file?.path) await removeFile(request.file.path);
    next(error);
  }
});

app.post('/api/import-url', async (request, response, next) => {
  let downloadedPath = '';
  try {
    const url = typeof request.body?.url === 'string' ? request.body.url.trim() : '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      sendApiError(response, new ApiError(400, 'INVALID_URL', 'Enter a valid http(s) video URL.'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      sendApiError(response, new ApiError(400, 'INVALID_URL', 'Only http and https URLs can be imported.'));
      return;
    }
    if (isPrivateHost(parsed.hostname)) {
      sendApiError(response, new ApiError(400, 'INVALID_URL', 'URLs pointing to private or loopback addresses are not allowed.'));
      return;
    }

    downloadedPath = await downloadWithYtDlp(url);
    const prepared = await registerPreparedSource({ filePath: downloadedPath, inputName: path.basename(downloadedPath) });
    downloadedPath = '';
    response.status(201).json(publicSource(prepared));
  } catch (error) {
    if (downloadedPath) await removeFile(downloadedPath);
    next(error);
  }
});

app.post('/api/import-local', async (request, response, next) => {
  // Used by the desktop "Make GIF with GIFM" shell verb to stage a local file the user explicitly chose.
  let copyPath = '';
  try {
    const sourcePath = typeof request.body?.path === 'string' ? request.body.path : '';
    if (!sourcePath || !path.isAbsolute(sourcePath) || !existsSync(sourcePath)) {
      sendApiError(response, new ApiError(400, 'INVALID_PATH', 'A valid absolute file path is required.'));
      return;
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (!supportedExtensions.has(ext)) {
      sendApiError(response, new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'That file type is not a supported video or GIF.'));
      return;
    }
    const lstat = await fs.lstat(sourcePath);
    if (lstat.isSymbolicLink()) {
      sendApiError(response, new ApiError(400, 'INVALID_PATH', 'Symbolic links are not allowed.'));
      return;
    }
    const stat = lstat;
    if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) {
      sendApiError(response, new ApiError(413, 'UPLOAD_TOO_LARGE', `The file is not a regular file or exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`));
      return;
    }

    copyPath = path.join(uploadDir, `local-${Date.now()}-${randomUUID()}${ext}`);
    await fs.copyFile(sourcePath, copyPath);
    const prepared = await registerPreparedSource({ filePath: copyPath, inputName: path.basename(sourcePath) });
    copyPath = '';
    pendingImport = publicSource(prepared);
    response.status(201).json(pendingImport);
  } catch (error) {
    if (copyPath) await removeFile(copyPath);
    next(error);
  }
});

app.get('/api/pending-import', (_request, response) => {
  const pending = pendingImport;
  pendingImport = null;
  response.json({ source: pending });
});

app.post('/api/overlay', (request, response, next) => {
  overlayUpload(request, response, async (error) => {
    if (error) {
      next(error);
      return;
    }
    if (!request.file) {
      sendApiError(response, new ApiError(400, 'NO_MEDIA_FILE', 'No overlay image was uploaded.'));
      return;
    }
    await enforceOverlayRetention(request.file.filename);
    response.status(201).json({ id: request.file.filename });
  });
});

const subtitleUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, workDir),
    filename: (_request, file, callback) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      callback(null, `sub-${randomUUID()}${['.srt', '.ass', '.ssa', '.vtt'].includes(ext) ? ext : '.srt'}`);
    }
  }),
  limits: { fileSize: 1 * 1024 * 1024, files: 1, fields: 0, parts: 2, fieldNestingDepth: 1 },
  fileFilter: (_request, file, callback) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.srt', '.ass', '.ssa', '.vtt'].includes(ext)) {
      callback(null, true);
      return;
    }
    callback(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload an SRT, ASS, SSA, or VTT subtitle file.'));
  }
}).single('subtitle');

app.post('/api/subtitle', (request, response, next) => {
  subtitleUpload(request, response, async (error) => {
    if (error) {
      next(error);
      return;
    }
    if (!request.file) {
      sendApiError(response, new ApiError(400, 'NO_SUBTITLE_FILE', 'No subtitle file was uploaded.'));
      return;
    }
    response.status(201).json({ id: request.file.filename });
  });
});

app.post('/api/sources/:id/jobs', async (request, response, next) => {
  try {
    const source = sources.get(request.params.id);
    if (!source || !existsSync(source.inputPath)) {
      if (source) sources.delete(source.id);
      sendApiError(response, new ApiError(404, 'SOURCE_NOT_FOUND', 'Prepared source not found. Prepare the video again, then retry the clip export.'));
      return;
    }

    let settings;
    try {
      settings = parseSettings(request.body.settings ?? request.body);
    } catch (error) {
      sendApiError(response, normalizeError(error));
      return;
    }

    source.lastUsedAt = new Date().toISOString();
    const clipName = typeof request.body.clipName === 'string' ? request.body.clipName.trim() : '';
    const job = createJob({
      inputPath: source.inputPath,
      inputName: clipName ? displayClipName(source.inputName, clipName) : source.inputName,
      inputSize: source.inputSize,
      sourceKind: source.sourceKind,
      settings,
      sourceId: source.id
    });

    jobs.set(job.id, job);
    enqueueJob(job);
    response.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs', runUpload, async (request, response, next) => {
  try {
    if (!request.file) {
      sendApiError(response, new ApiError(400, 'NO_MEDIA_FILE', 'No media file was uploaded.'));
      return;
    }

    let settings;
    try {
      settings = parseSettings(request.body.settings);
    } catch (error) {
      await removeFile(request.file.path);
      sendApiError(response, normalizeError(error));
      return;
    }

    const mediaCheck = await inspectUploadedMedia(request.file.path);
    if (!mediaCheck.ok) {
      await removeFile(request.file.path);
      sendApiError(response, new ApiError(415, 'UNSUPPORTED_MEDIA_CONTENT', 'The uploaded file does not look like a supported GIF or video container.'));
      return;
    }

    await enforceDataRetention(new Set([request.file.path]));

    const job = createJob({
      inputPath: request.file.path,
      inputName: request.file.originalname,
      inputSize: request.file.size,
      sourceKind: mediaCheck.kind,
      settings
    });

    jobs.set(job.id, job);
    enqueueJob(job);
    response.status(202).json(publicJob(job));
  } catch (error) {
    if (request.file?.path) await removeFile(request.file.path);
    next(error);
  }
});

app.post('/api/probe', runUpload, async (request, response, next) => {
  try {
    if (!request.file) {
      sendApiError(response, new ApiError(400, 'NO_MEDIA_FILE', 'No media file was uploaded.'));
      return;
    }

    const mediaCheck = await inspectUploadedMedia(request.file.path);
    if (!mediaCheck.ok) {
      await removeFile(request.file.path);
      sendApiError(response, new ApiError(415, 'UNSUPPORTED_MEDIA_CONTENT', 'The uploaded file does not look like a supported GIF or video container.'));
      return;
    }

    const metadata = await ffprobe(request.file.path);
    const source = sourceMetadata(metadata);
    if (!source.video) {
      sendApiError(response, new ApiError(422, 'NO_VIDEO_STREAM', 'No video stream was found in the selected file.'));
      return;
    }

    response.json({
      ok: true,
      kind: mediaCheck.kind,
      durationSec: source.durationSec,
      width: source.width,
      height: source.height,
      fps: source.fps,
      codec: source.codec,
      rotation: source.rotation
    });
  } catch (error) {
    next(error);
  } finally {
    if (request.file?.path) await removeFile(request.file.path);
  }
});

app.get('/api/jobs/zip', async (request, response, next) => {
  try {
    const ids = String(request.query.ids ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const entries = [];
    const usedNames = new Set();

    for (const id of ids) {
      const job = jobs.get(id);
      if (!job || job.status !== 'complete' || !job.outputPath || !existsSync(job.outputPath)) continue;
      const outExt = path.extname(job.outputPath).toLowerCase();
      const format = outExt === '.png' ? 'apng' : outExt === '.webp' ? 'webp' : outExt === '.mp4' ? 'mp4' : outExt === '.avif' ? 'avif' : 'gif';
      const ext = format === 'apng' ? 'png' : ['webp', 'mp4', 'avif'].includes(format) ? format : 'gif';
      let name = downloadName(job.inputName, format);
      let suffix = 1;
      while (usedNames.has(name)) {
        name = downloadName(job.inputName, format).replace(new RegExp(`\\.${ext}$`, 'i'), `-${suffix}.${ext}`);
        suffix += 1;
      }
      usedNames.add(name);
      entries.push({ name, data: await fs.readFile(job.outputPath) });
    }

    if (entries.length === 0) {
      sendApiError(response, new ApiError(404, 'NO_OUTPUTS', 'No completed outputs were available to download.'));
      return;
    }

    const zip = buildStoreZip(entries);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="gifm-batch-${entries.length}.zip"`);
    response.setHeader('Content-Length', zip.length);
    response.end(zip);
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    sendApiError(response, new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.'));
    return;
  }
  response.json(publicJob(job));
});

app.post('/api/jobs/:id/cancel', async (request, response, next) => {
  try {
    const job = jobs.get(request.params.id);
    if (!job) {
      sendApiError(response, new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.'));
      return;
    }

    await cancelJob(job);
    response.json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:id/download', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== 'complete' || !job.outputPath || !existsSync(job.outputPath)) {
    sendApiError(response, new ApiError(404, 'OUTPUT_NOT_FOUND', 'Output GIF not found.'));
    return;
  }

  const ext = path.extname(job.outputPath).toLowerCase();
  const format = ext === '.png' ? 'apng' : ext === '.webp' ? 'webp' : ext === '.mp4' ? 'mp4' : ext === '.avif' ? 'avif' : 'gif';
  const mime = format === 'apng' ? 'image/apng' : format === 'webp' ? 'image/webp' : format === 'mp4' ? 'video/mp4' : format === 'avif' ? 'image/avif' : 'image/gif';
  response.setHeader('Content-Type', mime);
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName(job.inputName, format)}"`);
  createReadStream(job.outputPath).pipe(response);
});

app.post('/api/jobs/:id/reveal', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== 'complete' || !job.outputPath) {
    sendApiError(response, new ApiError(404, 'OUTPUT_NOT_FOUND', 'Output GIF not found.'));
    return;
  }

  revealPath(job.outputPath);
  response.json({ ok: true });
});

const DISCORD_WEBHOOK_MAX_BYTES = 10 * 1024 * 1024;

app.post('/api/jobs/:id/webhook', async (request, response, next) => {
  try {
    const job = jobs.get(request.params.id);
    if (!job || job.status !== 'complete' || !job.outputPath || !existsSync(job.outputPath)) {
      sendApiError(response, new ApiError(404, 'OUTPUT_NOT_FOUND', 'Output not found.'));
      return;
    }

    const webhookUrl = typeof request.body?.webhookUrl === 'string' ? request.body.webhookUrl.trim() : '';
    if (!isDiscordWebhookUrl(webhookUrl)) {
      sendApiError(response, new ApiError(400, 'INVALID_WEBHOOK', 'Enter a valid Discord webhook URL (https://discord.com/api/webhooks/...).'));
      return;
    }

    const stat = await fs.stat(job.outputPath);
    if (stat.size > DISCORD_WEBHOOK_MAX_BYTES) {
      sendApiError(response, new ApiError(413, 'WEBHOOK_TOO_LARGE', `Discord webhooks accept up to ${formatBytes(DISCORD_WEBHOOK_MAX_BYTES)}; this output is ${formatBytes(stat.size)}.`));
      return;
    }

    const ext = path.extname(job.outputPath).toLowerCase();
    const format = ext === '.png' ? 'apng' : ext === '.webp' ? 'webp' : ext === '.mp4' ? 'mp4' : 'gif';
    const mime = format === 'apng' ? 'image/apng' : format === 'webp' ? 'image/webp' : format === 'mp4' ? 'video/mp4' : 'image/gif';
    const fileBytes = await fs.readFile(job.outputPath);
    const form = new FormData();
    form.set('files[0]', new Blob([fileBytes], { type: mime }), downloadName(job.inputName, format));

    const discordResponse = await fetch(webhookUrl, { method: 'POST', body: form });
    if (!discordResponse.ok) {
      const detail = (await discordResponse.text().catch(() => '')).slice(0, 200);
      sendApiError(response, new ApiError(502, 'WEBHOOK_REJECTED', `Discord rejected the upload (${discordResponse.status}). ${detail}`.trim()));
      return;
    }

    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const sseClients = new Set();

app.get('/api/jobs/events', (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write(':ok\n\n');

  const rawIds = String(request.query.ids || '').slice(0, 4000);
  const client = { response, ids: new Set(rawIds.split(',').filter(Boolean).slice(0, 50)), connectedAt: Date.now() };
  sseClients.add(client);
  const cleanup = () => sseClients.delete(client);
  request.on('close', cleanup);
  request.on('error', cleanup);
});

function notifyJobUpdate(job) {
  const data = JSON.stringify(publicJob(job));
  for (const client of sseClients) {
    if (client.ids.has(job.id) || client.ids.has('*')) {
      try {
        client.response.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }
}

ctx.notifyJobUpdate = notifyJobUpdate;

const SSE_MAX_AGE_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const client of sseClients) {
    if (now - client.connectedAt > SSE_MAX_AGE_MS) {
      try { client.response.end(); } catch { /* already closed */ }
      sseClients.delete(client);
    }
  }
}, 60_000).unref();

function isDiscordWebhookUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const allowedHosts = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
  return parsed.protocol === 'https:' && allowedHosts.has(parsed.host) && parsed.pathname.startsWith('/api/webhooks/');
}

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((request, response, next) => {
    if (request.method === 'GET' && !request.path.startsWith('/api')) {
      response.sendFile(path.join(distDir, 'index.html'));
      return;
    }
    next();
  });
}

app.use((error, _request, response, _next) => {
  sendApiError(response, normalizeError(error));
});

app.listen(PORT, HOST, () => {
  console.log(`GIFM v${VERSION} running at http://${HOST}:${PORT}`);
});

function createJob({ inputPath, inputName, inputSize, sourceKind, settings, sourceId = '' }) {
  const id = randomUUID();
  return {
    id,
    status: 'queued',
    progress: 0,
    stage: 'Queued',
    queuePosition: 0,
    inputPath,
    inputName,
    inputSize,
    sourceKind,
    sourceId,
    outputPath: '',
    outputBytes: undefined,
    targetBytes: Math.round(settings.targetMb * 1024 * 1024),
    downloadUrl: undefined,
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
    errorCode: undefined,
    warnings: [],
    logs: [],
    commands: [],
    attempts: [],
    settings,
    outputCandidates: new Set()
  };
}

async function processJob(job) {
  checkCancelled(job);
  job.status = 'running';
  job.stage = 'Probing media';
  job.queuePosition = 0;
  job.startedAt = new Date().toISOString();
  job.progress = 2;
  log(job, `Input: ${job.inputName} (${formatBytes(job.inputSize)})`);

  const metadata = await ffprobe(job.inputPath, job);
  checkCancelled(job);
  const source = sourceMetadata(metadata);
  const sourceDuration = source.durationSec;
  const videoStream = source.video;

  if (!videoStream) {
    throw new ApiError(422, 'NO_VIDEO_STREAM', 'No video stream was found in the selected file.');
  }

  let startSec = Math.max(0, job.settings.startSec);
  let durationSec = Math.max(0.5, job.settings.durationSec);
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    if (startSec >= sourceDuration) {
      const adjustedStart = Math.max(0, sourceDuration - 0.5);
      job.warnings.push(`Trim start was beyond the source duration and was adjusted to ${adjustedStart.toFixed(2)} sec.`);
      log(job, `Adjusted trim start from ${startSec.toFixed(2)} sec to ${adjustedStart.toFixed(2)} sec.`);
      startSec = Number(adjustedStart.toFixed(2));
    }
    durationSec = Math.min(durationSec, Math.max(0.5, sourceDuration - startSec));
  }

  log(job, `Source: ${source.width ?? '?'}x${source.height ?? '?'} ${source.codec ?? 'video'} at ${source.fps ? `${source.fps.toFixed(2)} fps` : '? fps'} for ${durationSec.toFixed(2)} sec`);

  const budgetCheck = exceedsFrameBudget({
    width: source.width ?? job.settings.width,
    height: source.height ?? Math.round((source.width ?? job.settings.width) * 9 / 16),
    fps: source.fps ?? job.settings.fps,
    durationSec,
    playback: job.settings.playback
  });
  if (budgetCheck.exceeds) {
    throw new ApiError(422, 'FRAME_BUDGET_EXCEEDED', budgetCheck.message);
  }

  const dimensionLock = dimensionLockForPreset(job.settings.targetPreset);
  let width = dimensionLock.fixedWidth
    ? dimensionLock.fixedWidth
    : even(clamp(job.settings.width, dimensionLock.minWidth, 1280));
  let fps = Math.round(clamp(job.settings.fps, 5, dimensionLock.fpsMax));
  let colors = Math.round(clamp(job.settings.colors, 16, 256));
  let dedupeFrames = false;
  let frameDropModulo = 0;
  let gifsicleLossy = 0;
  const isApng = job.settings.format === 'apng';
  const isWebp = job.settings.format === 'webp';
  const isMp4 = job.settings.format === 'mp4';
  const isAvif = job.settings.format === 'avif';
  const outputExt = isApng ? 'png' : isWebp ? 'webp' : isMp4 ? 'mp4' : isAvif ? 'avif' : 'gif';
  // gifsicle only optimizes GIFs, so it is skipped for the non-GIF formats.
  const optimizeEnabled = !isApng && !isWebp && !isMp4 && !isAvif && job.settings.optimize && runtimeInfo.gifsicle.available;
  // WebP/MP4/AVIF have a built-in lossy quality knob, so let the auto-fit loop drive it via the lossy lever.
  const allowLossy = optimizeEnabled || isWebp || isMp4 || isAvif;
  const maxAttempts = job.settings.autoFit ? 10 : 1;
  let lastOutputPath = '';
  let bestOutputPath = '';
  let bestOutputBytes = Number.POSITIVE_INFINITY;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    checkCancelled(job);
    const attemptWorkDir = path.join(workDir, job.id);
    job.workPath = attemptWorkDir;
    await fs.mkdir(attemptWorkDir, { recursive: true });
    const palettePath = path.join(attemptWorkDir, `palette-${attempt}-001.png`);
    const palettePattern = path.join(attemptWorkDir, `palette-${attempt}-%03d.png`);
    const outputPath = path.join(outputDir, `${safeBaseName(job.inputName)}-${job.id.slice(0, 8)}-a${attempt}.${outputExt}`);
    trackOutputCandidate(job, outputPath);
    const strategy = strategyLabel({ width, fps, colors, dedupeFrames, frameDropModulo, gifsicleLossy, optimizeEnabled, square: dimensionLock.square });

    const attemptRecord = { attempt, width, fps, colors, durationSec, strategy, dedupeFrames, frameDropModulo, gifsicleLossy };
    job.attempts.push(attemptRecord);
    job.stage = isApng ? `Attempt ${attempt}: apng` : isWebp ? `Attempt ${attempt}: webp` : isMp4 ? `Attempt ${attempt}: mp4` : isAvif ? `Attempt ${attempt}: avif` : job.settings.encoderBackend === 'gifski' ? `Attempt ${attempt}: gifski` : `Attempt ${attempt}: palette`;
    log(job, `Attempt ${attempt}: ${width}px, ${fps} fps, ${colors} colors, ${durationSec.toFixed(2)} sec, ${strategy}`);

    if (isApng) {
      await encodeWithApng({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square });
    } else if (isWebp) {
      await encodeWithWebp({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square, gifsicleLossy });
    } else if (isMp4) {
      await encodeWithMp4({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square, gifsicleLossy });
    } else if (isAvif) {
      await encodeWithAvif({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square, gifsicleLossy });
    } else if (job.settings.encoderBackend === 'gifski') {
      await encodeWithGifski({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square });
    } else {
      await encodeWithFfmpeg({ job, attempt, palettePattern, palettePath, outputPath, startSec, durationSec, width, fps, colors, dedupeFrames, frameDropModulo, square: dimensionLock.square });
    }
    checkCancelled(job);

    if (optimizeEnabled) {
      await optimizeOutput({ job, attempt, outputPath, lossy: gifsicleLossy });
      checkCancelled(job);
    }

    const stat = await fs.stat(outputPath);
    attemptRecord.outputBytes = stat.size;
    lastOutputPath = outputPath;
    log(job, `Attempt ${attempt} output: ${formatBytes(stat.size)}`);
    const rejectedLargerGif = !isApng && !isWebp && !isMp4 && !isAvif && job.sourceKind === 'gif' && stat.size >= job.inputSize;
    attemptRecord.rejected = rejectedLargerGif;

    if (rejectedLargerGif) {
      log(job, `Attempt ${attempt} rejected: output is not smaller than the source GIF.`);
    } else if (stat.size < bestOutputBytes) {
      bestOutputBytes = stat.size;
      bestOutputPath = outputPath;
    }

    if (!rejectedLargerGif && stat.size <= job.targetBytes) {
      job.outputPath = outputPath;
      job.outputBytes = stat.size;
      job.downloadUrl = `/api/jobs/${job.id}/download`;
      job.progress = 100;
      job.stage = 'Complete';
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      await cleanupOutputCandidates(job, outputPath);
      await cleanupWork(job.id);
      await cleanupInput(job);
      await enforceDataRetention(new Set([job.outputPath]));
      await probeOutputMetadata(job);
      saveManifest();
      notifyJobUpdate(job);
      log(job, `Complete: ${formatBytes(stat.size)} fits ${formatBytes(job.targetBytes)} target`);
      return;
    }

    if (!job.settings.autoFit) {
      break;
    }

    const next = nextAttempt({
      width,
      fps,
      colors,
      dedupeFrames,
      frameDropModulo,
      gifsicleLossy,
      allowLossy,
      durationSec,
      outputBytes: stat.size,
      targetBytes: job.targetBytes,
      allowTrim: job.settings.allowTrim,
      minWidth: dimensionLock.minWidth
    });

    if (!next) {
      job.warnings.push('Could not reach the target without going below minimum quality controls.');
      break;
    }

    width = next.width;
    fps = next.fps;
    colors = next.colors;
    dedupeFrames = next.dedupeFrames;
    frameDropModulo = next.frameDropModulo;
    gifsicleLossy = next.gifsicleLossy;
    durationSec = next.durationSec;
  }

  const finalOutputPath = bestOutputPath || lastOutputPath;
  if (!finalOutputPath) {
    throw new ApiError(422, 'NO_OUTPUT', 'No GIF output was produced.');
  }

  if (!isApng && !isWebp && !isMp4 && !isAvif && job.sourceKind === 'gif' && !bestOutputPath) {
    throw new ApiError(422, 'OUTPUT_NOT_SMALLER', 'The generated GIF was larger than the source GIF, so GIFM kept the source unchanged.');
  }

  const finalStat = await fs.stat(finalOutputPath);
  checkCancelled(job);
  job.outputPath = finalOutputPath;
  job.outputBytes = finalStat.size;
  job.downloadUrl = `/api/jobs/${job.id}/download`;
  job.progress = 100;
  job.stage = 'Complete with warning';
  job.status = 'complete';
  job.completedAt = new Date().toISOString();
  job.warnings.push(`Final GIF is ${formatBytes(finalStat.size)}, which is above the ${formatBytes(job.targetBytes)} target.`);
  await cleanupOutputCandidates(job, finalOutputPath);
  await cleanupWork(job.id);
  await cleanupInput(job);
  await enforceDataRetention(new Set([job.outputPath]));
  await probeOutputMetadata(job);
  saveManifest();
  notifyJobUpdate(job);
  log(job, `Complete with warning: ${formatBytes(finalStat.size)} exceeds target`);
}

async function probeOutputMetadata(job) {
  try {
    const metadata = await ffprobe(job.outputPath);
    const source = sourceMetadata(metadata);
    const videoStream = source.video;
    const frameCount = finiteNumber(videoStream?.nb_frames) ?? finiteNumber(videoStream?.nb_read_frames);
    job.outputMeta = {
      width: source.width,
      height: source.height,
      durationSec: source.durationSec,
      fps: source.fps,
      format: job.settings.format,
      frameCount: frameCount ? Math.round(frameCount) : null
    };
    job.discordChecks = discordTargetChecks({
      preset: job.settings.targetPreset,
      outputBytes: job.outputBytes,
      width: source.width ?? 0,
      height: source.height ?? 0,
      durationSec: source.durationSec,
      format: job.settings.format
    });
  } catch {
    job.outputMeta = null;
    job.discordChecks = [];
  }

  if (['gif', 'apng'].includes(job.settings.format) && job.inputPath && existsSync(job.inputPath)) {
    try {
      job.ssim = await computeSsim(job.inputPath, job.outputPath, job);
    } catch {
      job.ssim = null;
    }
  }
}

function computeSsim(sourcePath, outputPath, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-protocol_whitelist', 'file,pipe',
      '-i', sourcePath,
      '-i', outputPath,
      '-lavfi', 'ssim',
      '-f', 'null', '-'
    ], { windowsHide: true, timeout: 30000 });
    trackChild(job, child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTrackedChild(job, child); reject(error); });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      const match = stderr.match(/All:([0-9.]+)/);
      if (match) {
        resolve(Number(match[1]));
      } else {
        resolve(null);
      }
    });
  });
}

function runUpload(request, response, next) {
  uploadMedia(request, response, (error) => {
    if (error) {
      next(error);
      return;
    }
    next();
  });
}

async function registerPreparedSource({ filePath, inputName }) {
  const mediaCheck = await inspectUploadedMedia(filePath);
  if (!mediaCheck.ok) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_CONTENT', 'The downloaded file does not look like a supported GIF or video container.');
  }

  const metadata = await ffprobe(filePath);
  const source = sourceMetadata(metadata);
  if (!source.video) {
    throw new ApiError(422, 'NO_VIDEO_STREAM', 'No video stream was found in the downloaded file.');
  }

  const stat = await fs.stat(filePath);
  const id = randomUUID();
  const prepared = {
    id,
    inputPath: filePath,
    inputName,
    inputSize: stat.size,
    sourceKind: mediaCheck.kind,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    metadata: {
      durationSec: source.durationSec,
      width: source.width,
      height: source.height,
      fps: source.fps,
      codec: source.codec,
      rotation: source.rotation
    }
  };

  sources.set(id, prepared);
  await enforceDataRetention(new Set([prepared.inputPath]));
  saveManifest();
  return prepared;
}

function downloadWithYtDlp(url) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const outputTemplate = path.join(uploadDir, `url-${id}.%(ext)s`);
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-f',
      'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
      '--max-filesize',
      String(MAX_UPLOAD_BYTES),
      '-o',
      outputTemplate,
      url
    ];
    const child = spawn(YTDLP_PATH, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new ApiError(400, 'YTDLP_UNAVAILABLE', 'yt-dlp was not found. Install yt-dlp on PATH or set GIFM_YTDLP_PATH to enable URL import.'));
        return;
      }
      reject(error);
    });
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new ApiError(422, 'URL_DOWNLOAD_FAILED', stderr.trim().split(/\r?\n/).slice(-3).join(' ') || 'Could not download the video from that URL.'));
        return;
      }
      const names = await fs.readdir(uploadDir).catch(() => []);
      const match = names.find((name) => name.startsWith(`url-${id}.`));
      if (!match) {
        reject(new ApiError(422, 'URL_DOWNLOAD_FAILED', 'The download produced no file.'));
        return;
      }
      resolve(path.join(uploadDir, match));
    });
  });
}

function enqueueJob(job) {
  jobQueue.push(job.id);
  updateQueuePositions();
  log(job, `Queued at position ${job.queuePosition}`);
  notifyJobUpdate(job);
  pumpJobQueue();
}

function pumpJobQueue() {
  while (runningJobs < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const id = jobQueue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;

    runningJobs += 1;
    updateQueuePositions();
    void runQueuedJob(job);
  }
}

async function runQueuedJob(job) {
  try {
    await processJob(job);
  } catch (error) {
    if (!isTerminalStatus(job.status)) {
      if (isCancellationError(error) || job.cancelRequested) {
        await finalizeCancelled(job);
      } else {
        await failJob(job, error);
      }
    }
  } finally {
    if (job.status === 'cancelled') {
      await cleanupOutputCandidates(job);
      await cleanupInput(job);
      await cleanupWork(job.id);
      await enforceDataRetention();
    }
    runningJobs = Math.max(0, runningJobs - 1);
    job.activeChild = undefined;
    job.activeChildren?.clear();
    updateQueuePositions();
    pumpJobQueue();
  }
}

function updateQueuePositions() {
  jobQueue.forEach((id, index) => {
    const job = jobs.get(id);
    if (job?.status === 'queued') {
      job.queuePosition = index + 1;
      job.stage = `Queued #${job.queuePosition}`;
    }
  });
}

async function cancelJob(job) {
  if (isTerminalStatus(job.status)) return;

  job.cancelRequested = true;
  if (job.status === 'queued') {
    removeQueuedJob(job.id);
    updateQueuePositions();
    await finalizeCancelled(job);
    return;
  }

  job.stage = 'Cancelling';
  killActiveChild(job);
  await finalizeCancelled(job);
}

function removeQueuedJob(id) {
  const index = jobQueue.indexOf(id);
  if (index >= 0) jobQueue.splice(index, 1);
}

async function finalizeCancelled(job) {
  if (job.status === 'cancelled') return;

  job.status = 'cancelled';
  job.stage = 'Cancelled';
  job.queuePosition = 0;
  job.error = undefined;
  job.errorCode = 'JOB_CANCELLED';
  job.completedAt = new Date().toISOString();
  log(job, 'Cancelled by user.');
  notifyJobUpdate(job);
  await cleanupOutputCandidates(job);
  await cleanupWork(job.id);
  await cleanupInput(job);
  await enforceDataRetention();
}

function isTerminalStatus(status) {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}


function rejectCrossSiteWrites(request, response, next) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    next();
    return;
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendApiError(response, new ApiError(403, 'CROSS_SITE_BLOCKED', 'Cross-site requests are not allowed.'));
    return;
  }

  const origin = request.headers['origin'];
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      sendApiError(response, new ApiError(403, 'CROSS_SITE_BLOCKED', 'Cross-site requests are not allowed.'));
      return;
    }
    const expectedHosts = new Set([`${HOST}:${PORT}`, HOST, `localhost:${PORT}`, 'localhost']);
    if (!expectedHosts.has(parsed.host)) {
      sendApiError(response, new ApiError(403, 'CROSS_SITE_BLOCKED', 'Cross-site requests are not allowed.'));
      return;
    }
  }

  next();
}

function securityHeaders(_request, response, next) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Defense-in-depth for the local UI. Inline script (pre-paint theme) and React inline styles
  // require 'unsafe-inline'; everything else is locked to same-origin with no external connections.
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
}

function sendApiError(response, error) {
  if (response.headersSent) return;
  response.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    }
  });
}

function normalizeError(error) {
  if (error instanceof ApiError) return error;

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new ApiError(413, 'UPLOAD_TOO_LARGE', `Upload exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`);
    }

    return new ApiError(400, error.code, error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/multipart/i.test(message) || /boundary/i.test(message)) {
    return new ApiError(400, 'MALFORMED_MULTIPART', 'The upload request was not valid multipart form data.');
  }

  if (error instanceof SyntaxError && /JSON/i.test(message)) {
    return new ApiError(400, 'INVALID_JSON', 'Request JSON is invalid.');
  }

  return new ApiError(500, 'INTERNAL_ERROR', message || 'Unexpected server error.');
}

function isAllowedUploadDescriptor(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return supportedExtensions.has(ext) || mime === 'image/gif' || mime.startsWith('video/');
}

async function inspectUploadedMedia(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const ascii = header.toString('ascii');

    if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
      return { ok: true, kind: 'gif' };
    }

    if (header.length >= 12 && ascii.slice(4, 8) === 'ftyp') {
      return { ok: true, kind: 'iso-bmff' };
    }

    if (header.length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') {
      return { ok: true, kind: 'avi' };
    }

    if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
      return { ok: true, kind: 'matroska' };
    }

    return { ok: false, kind: 'unknown' };
  } finally {
    await handle.close();
  }
}

function sourceMetadata(metadata) {
  const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
  return {
    video,
    durationSec: finiteNumber(metadata.format?.duration),
    width: finiteNumber(video?.width),
    height: finiteNumber(video?.height),
    fps: parseFrameRate(video?.avg_frame_rate || video?.r_frame_rate),
    codec: video?.codec_name || video?.codec_long_name || '',
    rotation: readRotation(video)
  };
}

function readRotation(stream) {
  const tagged = Number(stream?.tags?.rotate);
  if (Number.isFinite(tagged)) return tagged;

  const sideDataRotation = stream?.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)));
  if (sideDataRotation) return Number(sideDataRotation.rotation);

  return 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadManifest() {
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== 1) return;
    for (const entry of data.sources ?? []) {
      if (entry.inputPath && existsSync(entry.inputPath)) {
        sources.set(entry.id, { ...entry, outputCandidates: new Set() });
      }
    }
    for (const entry of data.jobs ?? []) {
      if (entry.outputPath && existsSync(entry.outputPath) && entry.status === 'complete') {
        jobs.set(entry.id, { ...entry, outputCandidates: new Set(), logs: entry.logs ?? [], commands: entry.commands ?? [], warnings: entry.warnings ?? [], attempts: entry.attempts ?? [] });
      }
    }
  } catch {
    // No manifest or corrupt — start fresh.
  }
}

function saveManifest() {
  if (manifestWritePending) {
    manifestWriteQueued = true;
    return;
  }
  manifestWritePending = true;
  void flushManifest();
}

async function flushManifest() {
  try {
    const persistedSources = [];
    for (const source of sources.values()) {
      if (source.inputPath && existsSync(source.inputPath)) {
        persistedSources.push({ id: source.id, inputPath: source.inputPath, inputName: source.inputName, inputSize: source.inputSize, sourceKind: source.sourceKind, createdAt: source.createdAt, lastUsedAt: source.lastUsedAt, metadata: source.metadata });
      }
    }
    const persistedJobs = [];
    for (const job of jobs.values()) {
      if (job.status === 'complete' && job.outputPath && existsSync(job.outputPath)) {
        persistedJobs.push({ id: job.id, status: job.status, inputName: job.inputName, inputSize: job.inputSize, outputPath: job.outputPath, outputBytes: job.outputBytes, targetBytes: job.targetBytes, downloadUrl: job.downloadUrl, startedAt: job.startedAt, completedAt: job.completedAt, warnings: job.warnings, attempts: job.attempts, settings: job.settings, outputMeta: job.outputMeta, discordChecks: job.discordChecks });
      }
    }
    const tempPath = `${manifestPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify({ version: 1, sources: persistedSources, jobs: persistedJobs }, null, 2));
    await fs.rename(tempPath, manifestPath);
  } catch {
    // Non-fatal — manifest is a convenience, not a hard requirement.
  } finally {
    manifestWritePending = false;
    if (manifestWriteQueued) {
      manifestWriteQueued = false;
      saveManifest();
    }
  }
}

function runFfmpegSimple(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-protocol_whitelist', 'file,pipe', ...args], { windowsHide: true, timeout: 15000 });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim().split(/\r?\n/).slice(-4).join('\n') || `ffmpeg exited with code ${code}`));
      else resolve();
    });
  });
}

function computeSsimSimple(refPath, comparePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-protocol_whitelist', 'file,pipe',
      '-i', refPath, '-i', comparePath,
      '-lavfi', 'ssim', '-f', 'null', '-'
    ], { windowsHide: true, timeout: 10000 });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const match = stderr.match(/All:([0-9.]+)/);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

function assertLocalBinding() {
  if (isLoopbackHost(HOST)) return;

  const message = `Refusing to bind GIFM to ${HOST}. Use GIFM_ALLOW_REMOTE=1 only on a trusted network.`;
  if (!ALLOW_REMOTE) {
    throw new Error(message);
  }

  console.warn(`WARNING: ${message}`);
}

function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isPrivateHost(hostname) {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h) || h === '0.0.0.0') return true;
  if (/^fc|^fd|^fe80/i.test(h)) return true;
  return false;
}

async function failJob(job, error) {
  const apiError = normalizeError(error);
  job.status = 'failed';
  job.stage = 'Failed';
  job.queuePosition = 0;
  job.error = apiError.message;
  job.errorCode = apiError.code;
  job.completedAt = new Date().toISOString();
  log(job, `ERROR ${apiError.code}: ${apiError.message}`);
  notifyJobUpdate(job);
  await cleanupOutputCandidates(job);
  await cleanupWork(job.id);
  await cleanupInput(job);
  await enforceDataRetention();
}

function trackOutputCandidate(job, outputPath) {
  if (!job.outputCandidates) job.outputCandidates = new Set();
  job.outputCandidates.add(path.resolve(outputPath));
}

async function cleanupOutputCandidates(job, keepPath = '') {
  const candidates = [...(job.outputCandidates ?? [])];
  const keep = keepPath ? path.resolve(keepPath) : '';
  const kept = new Set();

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (keep && resolved === keep) {
      kept.add(resolved);
      continue;
    }

    const removed = await removeFile(resolved);
    if (!removed) kept.add(resolved);
  }

  job.outputCandidates = kept;
}

async function cleanupInput(job) {
  if (!job.inputPath) return;
  if (job.sourceId) return;
  const removed = await removeFile(job.inputPath);
  if (removed) job.inputPath = '';
}

async function removeFile(filePath) {
  if (!filePath) return true;

  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
    throw error;
  }
}

async function enforceOverlayRetention(keepName = '') {
  // Overlay images are small and session-scoped; keep the newest 30 and drop anything older than the data age.
  const names = await fs.readdir(overlayDir).catch(() => []);
  const now = Date.now();
  const entries = [];
  for (const name of names) {
    const entryPath = path.join(overlayDir, name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (stat?.isFile()) entries.push({ name, path: entryPath, mtimeMs: stat.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  for (const entry of entries) {
    kept += 1;
    if (entry.name === keepName) continue;
    if (kept > 30 || now - entry.mtimeMs > DATA_MAX_AGE_MS) {
      await fs.rm(entry.path, { force: true });
    }
  }
}

async function enforceDataRetention(extraProtected = new Set()) {
  pruneOldJobs();
  const protectedPaths = protectedJobPaths(extraProtected);
  await Promise.all([
    enforceDirectoryPolicy(uploadDir, protectedPaths),
    enforceDirectoryPolicy(outputDir, protectedPaths),
    enforceDirectoryPolicy(workDir, protectedPaths)
  ]);
}

function pruneOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const completedAt = job.completedAt ? Date.parse(job.completedAt) : null;
    if (completedAt && now - completedAt > DATA_MAX_AGE_MS) {
      jobs.delete(id);
    }
  }
  for (const [id, source] of sources) {
    const lastUsedAt = Date.parse(source.lastUsedAt || source.createdAt);
    if (Number.isFinite(lastUsedAt) && now - lastUsedAt > DATA_MAX_AGE_MS) {
      sources.delete(id);
    }
  }
}

function protectedJobPaths(extraProtected) {
  const paths = new Set([...extraProtected].filter(Boolean).map((item) => path.resolve(item)));
  for (const source of sources.values()) {
    if (source.inputPath) paths.add(path.resolve(source.inputPath));
  }
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') {
      if (job.inputPath) paths.add(path.resolve(job.inputPath));
      if (job.outputPath) paths.add(path.resolve(job.outputPath));
      if (job.workPath) paths.add(path.resolve(job.workPath));
      for (const candidate of job.outputCandidates ?? []) {
        paths.add(path.resolve(candidate));
      }
    } else if (job.status === 'complete' && job.outputPath) {
      paths.add(path.resolve(job.outputPath));
    }
  }
  return paths;
}

async function enforceDirectoryPolicy(dir, protectedPaths) {
  const entries = await listManagedEntries(dir, protectedPaths);
  const now = Date.now();
  const keptEntries = [];

  for (const entry of entries) {
    if (!entry.protected && now - entry.mtimeMs > DATA_MAX_AGE_MS) {
      await fs.rm(entry.path, { recursive: true, force: true });
      continue;
    }
    keptEntries.push(entry);
  }

  let totalBytes = keptEntries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of keptEntries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= DATA_MAX_BYTES) break;
    if (entry.protected) continue;
    await fs.rm(entry.path, { recursive: true, force: true });
    totalBytes -= entry.size;
  }
}

async function listManagedEntries(dir, protectedPaths) {
  const names = await fs.readdir(dir).catch(() => []);
  const entries = [];

  for (const name of names) {
    const entryPath = path.join(dir, name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (!stat) continue;

    entries.push({
      path: entryPath,
      size: stat.isDirectory() ? await directorySize(entryPath) : stat.size,
      mtimeMs: stat.mtimeMs,
      protected: isProtectedPath(entryPath, protectedPaths)
    });
  }

  return entries;
}

async function directorySize(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  let total = 0;
  for (const name of names) {
    const entryPath = path.join(dir, name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (!stat) continue;
    total += stat.isDirectory() ? await directorySize(entryPath) : stat.size;
  }
  return total;
}

function parseSettings(raw) {
  return parseSettingsRaw(raw, MAX_TRIM_START_SEC);
}




function ffprobe(inputPath, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath], {
      windowsHide: true
    });
    trackChild(job, child);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTrackedChild(job, child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      if (job?.cancelRequested || job?.status === 'cancelled') {
        reject(cancelError());
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}


function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    queuePosition: job.queuePosition,
    inputName: job.inputName,
    inputSize: job.inputSize,
    outputBytes: job.outputBytes,
    targetBytes: job.targetBytes,
    downloadUrl: job.downloadUrl,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    errorCode: job.errorCode,
    warnings: job.warnings,
    logs: job.logs.slice(-120),
    commands: job.commands?.slice(-20) ?? [],
    attempts: job.attempts,
    settings: job.settings,
    outputMeta: job.outputMeta ?? null,
    discordChecks: job.discordChecks ?? [],
    ssim: job.ssim ?? null
  };
}

function publicSource(source) {
  return {
    id: source.id,
    inputName: source.inputName,
    inputSize: source.inputSize,
    sourceKind: source.sourceKind,
    createdAt: source.createdAt,
    lastUsedAt: source.lastUsedAt,
    ...source.metadata
  };
}


function safeBaseName(name) {
  const base = path.basename(name, path.extname(name));
  return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gifm-output';
}

function downloadName(inputName, format = 'gif') {
  const ext = format === 'apng' ? 'png' : ['webp', 'mp4', 'avif'].includes(format) ? format : 'gif';
  return `${safeBaseName(inputName)}-gifm.${ext}`;
}

function displayClipName(inputName, clipName) {
  const ext = path.extname(inputName);
  const base = path.basename(inputName, ext);
  const safeClip = clipName.replace(/[\r\n\t]+/g, ' ').replace(/[<>:"/\\|?*]+/g, '-').trim().slice(0, 60);
  return safeClip ? `${base} - ${safeClip}${ext}` : inputName;
}

function revealPath(filePath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', ['/select,', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' }).unref();
}

async function cleanupWork(jobId) {
  await removeDirectory(path.join(workDir, jobId));
}

async function removeDirectory(dirPath) {
  if (!dirPath) return true;

  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
    throw error;
  }
}

async function getRuntimeInfo() {
  const gifskiConfigured = Boolean(GIFSKI_PATH);
  const gifskiAvailable = gifskiConfigured && existsSync(GIFSKI_PATH);
  // gifsicle may be a bare PATH lookup, so probe its version directly rather than checking existsSync.
  const gifsicleReachable = GIFSICLE_CONFIGURED ? existsSync(GIFSICLE_PATH) : true;
  const [ffmpegVersion, ffprobeVersion, gifskiVersion, gifsicleVersion] = await Promise.all([
    toolVersion(ffmpegPath),
    toolVersion(ffprobePath),
    gifskiAvailable ? toolVersion(GIFSKI_PATH) : Promise.resolve(gifskiConfigured ? 'missing' : 'not configured'),
    gifsicleReachable ? toolVersion(GIFSICLE_PATH, '--version') : Promise.resolve('missing')
  ]);
  const gifsicleAvailable = gifsicleReachable && gifsicleVersion !== 'unavailable' && gifsicleVersion !== 'missing';

  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version
    },
    ffmpeg: {
      available: Boolean(ffmpegPath),
      path: ffmpegPath,
      version: ffmpegVersion
    },
    ffprobe: {
      available: Boolean(ffprobePath),
      path: ffprobePath,
      version: ffprobeVersion
    },
    gifski: {
      available: gifskiAvailable,
      path: GIFSKI_PATH,
      version: gifskiVersion,
      license: 'gifski is AGPL-licensed unless you use a commercial license; GIFM does not bundle it.'
    },
    gifsicle: {
      available: gifsicleAvailable,
      configured: GIFSICLE_CONFIGURED,
      path: gifsicleAvailable ? GIFSICLE_PATH : '',
      version: gifsicleVersion,
      license: 'gifsicle is GPL-2.0-licensed; GIFM does not bundle it and runs it as a separate process when present.'
    },
    font: {
      available: existsSync(fontPath),
      path: fontPath,
      license: 'Anton font is bundled under the SIL Open Font License 1.1 (assets/fonts/Anton-OFL.txt).'
    }
  };
}

function toolVersion(toolPath, versionArg = '-version') {
  return new Promise((resolve) => {
    const child = spawn(toolPath, [versionArg], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve('unavailable'));
    child.on('close', () => {
      resolve(stdout.trim().split(/\r?\n/)[0] || 'unknown');
    });
  });
}

function parseByteLimit(byteValue, mbValue, fallback) {
  const bytes = Number(byteValue);
  if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes);

  const mb = Number(mbValue);
  if (Number.isFinite(mb) && mb > 0) return Math.round(mb * 1024 * 1024);

  return fallback;
}

function parseHours(value, fallback) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours : fallback;
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}
