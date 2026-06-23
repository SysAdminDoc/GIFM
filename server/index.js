import express from 'express';
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
  isProtectedPath
} from './encoding.js';
import { buildStoreZip } from './zip.js';

const VERSION = '0.3.0';
const PORT = parsePositiveInteger(process.env.GIFM_PORT ?? process.env.PORT, 4174);
const HOST = (process.env.GIFM_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const ALLOW_REMOTE = process.env.GIFM_ALLOW_REMOTE === '1';
const GIFSKI_PATH = process.env.GIFM_GIFSKI_PATH ? path.resolve(process.env.GIFM_GIFSKI_PATH) : '';
const GIFSICLE_CONFIGURED = Boolean(process.env.GIFM_GIFSICLE_PATH);
const GIFSICLE_PATH = GIFSICLE_CONFIGURED ? path.resolve(process.env.GIFM_GIFSICLE_PATH) : 'gifsicle';
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
const distDir = path.join(rootDir, 'dist');
const fontPath = path.join(rootDir, 'assets', 'fonts', 'Anton-Regular.ttf');
const ffprobePath = ffprobeStatic.path;
const jobs = new Map();
const sources = new Map();
const jobQueue = [];
let runningJobs = 0;
const supportedExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif']);

await Promise.all([uploadDir, outputDir, workDir].map((dir) => fs.mkdir(dir, { recursive: true })));
assertLocalBinding();

if (!ffmpegPath || !ffprobePath) {
  throw new Error('Bundled FFmpeg or FFprobe binary was not found.');
}

const runtimeInfo = await getRuntimeInfo();
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
    parts: 4
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

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
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
    response.status(201).json(publicSource(prepared));
  } catch (error) {
    if (request.file?.path) await removeFile(request.file.path);
    next(error);
  }
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
      const format = outExt === '.png' ? 'apng' : outExt === '.webp' ? 'webp' : outExt === '.mp4' ? 'mp4' : 'gif';
      const ext = format === 'apng' ? 'png' : format === 'webp' ? 'webp' : format === 'mp4' ? 'mp4' : 'gif';
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
  const format = ext === '.png' ? 'apng' : ext === '.webp' ? 'webp' : ext === '.mp4' ? 'mp4' : 'gif';
  const mime = format === 'apng' ? 'image/apng' : format === 'webp' ? 'image/webp' : format === 'mp4' ? 'video/mp4' : 'image/gif';
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
  const outputExt = isApng ? 'png' : isWebp ? 'webp' : isMp4 ? 'mp4' : 'gif';
  // gifsicle only optimizes GIFs, so it is skipped for the APNG, WebP, and MP4 formats.
  const optimizeEnabled = !isApng && !isWebp && !isMp4 && job.settings.optimize && runtimeInfo.gifsicle.available;
  // WebP and MP4 have a built-in lossy quality knob, so let the auto-fit loop drive it via the lossy lever.
  const allowLossy = optimizeEnabled || isWebp || isMp4;
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
    job.stage = isApng ? `Attempt ${attempt}: apng` : isWebp ? `Attempt ${attempt}: webp` : isMp4 ? `Attempt ${attempt}: mp4` : job.settings.encoderBackend === 'gifski' ? `Attempt ${attempt}: gifski` : `Attempt ${attempt}: palette`;
    log(job, `Attempt ${attempt}: ${width}px, ${fps} fps, ${colors} colors, ${durationSec.toFixed(2)} sec, ${strategy}`);

    if (isApng) {
      await encodeWithApng({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square });
    } else if (isWebp) {
      await encodeWithWebp({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square, gifsicleLossy });
    } else if (isMp4) {
      await encodeWithMp4({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square: dimensionLock.square, gifsicleLossy });
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
    const rejectedLargerGif = !isApng && !isWebp && !isMp4 && job.sourceKind === 'gif' && stat.size >= job.inputSize;
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

  if (!isApng && !isWebp && !isMp4 && job.sourceKind === 'gif' && !bestOutputPath) {
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
  log(job, `Complete with warning: ${formatBytes(finalStat.size)} exceeds target`);
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

function enqueueJob(job) {
  jobQueue.push(job.id);
  updateQueuePositions();
  log(job, `Queued at position ${job.queuePosition}`);
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
  await cleanupOutputCandidates(job);
  await cleanupWork(job.id);
  await cleanupInput(job);
  await enforceDataRetention();
}

function isTerminalStatus(status) {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function checkCancelled(job) {
  if (job.cancelRequested || job.status === 'cancelled') {
    throw cancelError();
  }
}

function cancelError() {
  return new ApiError(499, 'JOB_CANCELLED', 'Job was cancelled.');
}

function isCancellationError(error) {
  return error instanceof ApiError && error.code === 'JOB_CANCELLED';
}

function trackChild(job, child) {
  if (!job) return;
  if (!job.activeChildren) job.activeChildren = new Set();
  job.activeChildren.add(child);
  job.activeChild = child;
}

function clearTrackedChild(job, child) {
  if (!job) return;
  job.activeChildren?.delete(child);
  if (job.activeChild === child) {
    job.activeChild = job.activeChildren?.values().next().value;
  }
}

function killActiveChild(job) {
  const children = job.activeChildren?.size ? [...job.activeChildren] : job.activeChild ? [job.activeChild] : [];
  for (const child of children) {
    killChild(child);
  }
}

function killChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2500);
  killTimer.unref?.();
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

async function failJob(job, error) {
  const apiError = normalizeError(error);
  job.status = 'failed';
  job.stage = 'Failed';
  job.queuePosition = 0;
  job.error = apiError.message;
  job.errorCode = apiError.code;
  job.completedAt = new Date().toISOString();
  log(job, `ERROR ${apiError.code}: ${apiError.message}`);
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

function videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square = false, speed = 1, playback = 'normal', crop = null, caption = null, fontFile = '' }) {
  const filters = [];
  if (crop?.enabled) {
    // Crop the source region first so every downstream filter works on the selected rectangle.
    filters.push(`crop='iw*${crop.w}':'ih*${crop.h}':'iw*${crop.x}':'ih*${crop.y}'`);
  }
  if (dedupeFrames) {
    filters.push('mpdecimate', 'setpts=N/FRAME_RATE/TB');
  }
  if (frameDropModulo > 0) {
    filters.push(`select='not(eq(mod(n\\,${frameDropModulo})\\,0))'`, 'setpts=N/FRAME_RATE/TB');
  }
  if (speed && speed !== 1) {
    // Rescale presentation timestamps before resampling so fps sampling sees the new playback rate.
    filters.push(`setpts=PTS/${speed}`);
  }
  filters.push(`fps=${fps}`);
  if (square) {
    // Center-crop to a square, then scale to the locked dimension (Discord emoji/avatar are square).
    filters.push("crop='min(iw,ih)':'min(iw,ih)'", `scale=${width}:${width}:flags=lanczos`);
  } else {
    filters.push(`scale=${width}:-2:flags=lanczos`);
  }
  let chain = filters.join(',');
  const captionChain = captionFilters({ caption, fontFile, width });
  if (captionChain) chain += `,${captionChain}`;
  if (playback === 'reverse') {
    chain += ',reverse';
  } else if (playback === 'boomerang') {
    // Play forward, then the reversed clip, as a seamless bounce. Doubles the frame count, so auto-fit compensates.
    chain += ',split[fwd][bwd];[bwd]reverse[rev];[fwd][rev]concat=n=2';
  }
  return chain;
}

function captionFilters({ caption, fontFile, width }) {
  if (!fontFile || !caption || (!caption.top && !caption.bottom)) return '';
  const borderw = Math.max(2, Math.round(width / 120));
  const base = `fontfile=${fontFile}:expansion=none:fontcolor=white:bordercolor=black:borderw=${borderw}:fontsize=h/9:x=(w-text_w)/2`;
  const parts = [];
  if (caption.top) parts.push(`drawtext=${base}:text='${escapeDrawtextText(caption.top)}':y=h*0.05`);
  if (caption.bottom) parts.push(`drawtext=${base}:text='${escapeDrawtextText(caption.bottom)}':y=h*0.95-text_h`);
  return parts.join(',');
}

function escapeDrawtextPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function escapeDrawtextText(text) {
  // Single-quoted drawtext value with expansion=none: escape backslashes, then close/reopen quotes around apostrophes.
  return text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
}

function strategyLabel({ width, fps, colors, dedupeFrames, frameDropModulo, gifsicleLossy = 0, optimizeEnabled = false, square = false }) {
  const parts = [square ? `${width}x${width} square` : `${width}px`, `${fps}fps`, `${colors} colors`];
  if (dedupeFrames) parts.push('dedupe frames');
  if (frameDropModulo > 0) parts.push(`drop every ${frameDropModulo}th frame`);
  parts.push('transparency rectangles');
  if (optimizeEnabled) parts.push(gifsicleLossy > 0 ? `gifsicle -O3 --lossy=${gifsicleLossy}` : 'gifsicle -O3');
  return parts.join(' / ');
}

async function optimizeOutput({ job, attempt, outputPath, lossy }) {
  const stage = `Attempt ${attempt}: optimize`;
  job.stage = stage;
  const tempPath = `${outputPath}.opt.gif`;
  try {
    await runGifsicle(outputPath, tempPath, lossy, job, stage);
    const optimized = await fs.stat(tempPath).catch(() => null);
    if (optimized && optimized.size > 0) {
      await fs.rm(outputPath, { force: true });
      await fs.rename(tempPath, outputPath);
      log(job, `Attempt ${attempt}: gifsicle -O3${lossy > 0 ? ` --lossy=${lossy}` : ''} -> ${formatBytes(optimized.size)}`);
      return;
    }
    await removeFile(tempPath);
  } catch (error) {
    if (isCancellationError(error)) {
      await removeFile(tempPath);
      throw error;
    }
    // A failed optimization must never fail the encode; keep the unoptimized GIF.
    await removeFile(tempPath);
    log(job, `Attempt ${attempt}: gifsicle optimization skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

function runGifsicle(inputPath, outputPath, lossy, job, stage) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const args = ['-O3'];
    if (lossy > 0) args.push(`--lossy=${Math.round(lossy)}`);
    args.push(inputPath, '-o', outputPath);
    const child = spawn(runtimeInfo.gifsicle.path, args, { windowsHide: true });
    recordCommand(job, stage, args, runtimeInfo.gifsicle.path);
    trackChild(job, child);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTrackedChild(job, child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      if (job.cancelRequested || job.status === 'cancelled') {
        reject(cancelError());
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-4).join('\n') || `gifsicle exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function trimArgs(startSec, durationSec) {
  const args = [];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-t', String(durationSec));
  return args;
}

function ditherFilter(mode, bayerScale = 5) {
  if (mode === 'bayer') return `dither=bayer:bayer_scale=${bayerScale}`;
  if (mode === 'floyd_steinberg') return 'dither=floyd_steinberg';
  if (mode === 'none') return 'dither=none';
  return 'dither=sierra2_4a';
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

async function encodeWithFfmpeg({ job, attempt, palettePattern, palettePath, outputPath, startSec, durationSec, width, fps, colors, dedupeFrames, frameDropModulo, square = false }) {
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      `${videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' })},palettegen=max_colors=${colors}:stats_mode=${job.settings.paletteMode}`,
      '-frames:v',
      '1',
      '-y',
      palettePattern
    ],
    job,
    `Attempt ${attempt}: palette`,
    5,
    26,
    durationSec
  );
  checkCancelled(job);

  job.stage = `Attempt ${attempt}: encode`;
  const dither = ditherFilter(job.settings.dither, job.settings.bayerScale);
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-i',
      palettePath,
      '-lavfi',
      `${videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' })}[x];[x][1:v]paletteuse=${dither}:diff_mode=rectangle`,
      '-loop',
      String(job.settings.loopCount),
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: encode`,
    26,
    95,
    durationSec
  );
}

async function encodeWithMp4({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false, gifsicleLossy = 0 }) {
  // Discord autoplays muted MP4 inline, so a silent faststart H.264 is the smallest "GIF-like" deliverable.
  // The auto-fit lossy lever maps to CRF (higher = smaller); loop count does not apply to MP4.
  const crf = Math.max(20, Math.min(40, Math.round(26 + gifsicleLossy * 0.1)));
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' }),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: mp4`,
    5,
    95,
    durationSec
  );
}

async function encodeWithWebp({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false, gifsicleLossy = 0 }) {
  // libwebp encodes animated WebP directly (no palette). The auto-fit lossy lever maps to -quality,
  // and the loop convention (0 = infinite, -1 = play once) maps to -loop.
  const quality = Math.max(15, Math.min(90, Math.round(80 - gifsicleLossy * 0.4)));
  const loops = job.settings.loopCount === 0 ? 0 : job.settings.loopCount === -1 ? 1 : job.settings.loopCount;
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' }),
      '-c:v',
      'libwebp',
      '-loop',
      String(loops),
      '-quality',
      String(quality),
      '-compression_level',
      '6',
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: webp`,
    5,
    95,
    durationSec
  );
}

async function encodeWithApng({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false }) {
  // APNG keeps full colour, so no palette pass is needed; -plays maps the loop convention (0 = infinite, 1 = once).
  const plays = job.settings.loopCount === 0 ? 0 : job.settings.loopCount === -1 ? 1 : job.settings.loopCount;
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' }),
      '-f',
      'apng',
      '-plays',
      String(plays),
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: apng`,
    5,
    95,
    durationSec
  );
}

async function encodeWithGifski({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false }) {
  if (!runtimeInfo.gifski.available) {
    throw new ApiError(400, 'GIFSKI_UNAVAILABLE', 'Set GIFM_GIFSKI_PATH to use the gifski encoder backend.');
  }

  const gifskiArgs = ['--quality', String(job.settings.gifskiQuality)];
  // gifski follows the same loop convention as the gif muxer (0 = infinite, -1 = play once);
  // infinite is the default, so only pass --repeat when the user asked for something else.
  if (job.settings.loopCount !== 0) gifskiArgs.push('--repeat', String(job.settings.loopCount));
  gifskiArgs.push('--output', outputPath, '-');

  await runFfmpegToGifski(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square, speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop, caption: job.settings.caption, fontFile: runtimeInfo.font.available ? escapeDrawtextPath(fontPath) : '' }),
      '-pix_fmt',
      'yuv420p',
      '-f',
      'yuv4mpegpipe',
      '-'
    ],
    gifskiArgs,
    job,
    `Attempt ${attempt}: gifski`,
    5,
    95,
    durationSec
  );
}

function runFfmpeg(args, job, stage, progressStart, progressEnd, durationSec) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const child = spawn(ffmpegPath, ['-hide_banner', ...args], { windowsHide: true });
    recordCommand(job, stage, ['-hide_banner', ...args]);
    trackChild(job, child);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.trim();
      if (line) {
        const compact = line.split(/\r?\n/).slice(-2).join(' | ');
        if (/frame=|time=|speed=|palette|Output|Input/.test(compact)) {
          log(job, compact);
        }
      }

      const seconds = parseFfmpegTime(text);
      if (seconds !== null && durationSec > 0) {
        const percent = Math.min(1, seconds / durationSec);
        job.progress = Math.max(job.progress, progressStart + percent * (progressEnd - progressStart));
        job.stage = stage;
      }
    });

    child.on('error', (error) => {
      clearTrackedChild(job, child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      if (job.cancelRequested || job.status === 'cancelled') {
        reject(cancelError());
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `ffmpeg exited with code ${code}`));
        return;
      }
      job.progress = Math.max(job.progress, progressEnd);
      resolve();
    });
  });
}

function runFfmpegToGifski(ffmpegArgs, gifskiArgs, job, stage, progressStart, progressEnd, durationSec) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const ffmpeg = spawn(ffmpegPath, ['-hide_banner', ...ffmpegArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const gifski = spawn(runtimeInfo.gifski.path, gifskiArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });
    recordCommand(job, `${stage}: ffmpeg pipe`, ['-hide_banner', ...ffmpegArgs]);
    recordCommand(job, stage, gifskiArgs, runtimeInfo.gifski.path);
    trackChild(job, ffmpeg);
    trackChild(job, gifski);

    let ffmpegStderr = '';
    let gifskiStderr = '';
    let ffmpegDone = false;
    let gifskiDone = false;
    let ffmpegCode = 0;
    let gifskiCode = 0;
    let settled = false;

    ffmpeg.stdout.pipe(gifski.stdin);
    gifski.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') finish(error);
    });

    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      ffmpegStderr += text;
      const line = text.trim();
      if (line) {
        const compact = line.split(/\r?\n/).slice(-2).join(' | ');
        if (/frame=|time=|speed=|Output|Input/.test(compact)) {
          log(job, compact);
        }
      }

      const seconds = parseFfmpegTime(text);
      if (seconds !== null && durationSec > 0) {
        const percent = Math.min(1, seconds / durationSec);
        job.progress = Math.max(job.progress, progressStart + percent * (progressEnd - progressStart) * 0.65);
        job.stage = stage;
      }
    });

    gifski.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      gifskiStderr += text;
      const line = text.trim();
      if (line) log(job, line.split(/\r?\n/).slice(-2).join(' | '));
    });

    ffmpeg.on('error', finish);
    gifski.on('error', finish);
    ffmpeg.on('close', (code) => {
      clearTrackedChild(job, ffmpeg);
      ffmpegCode = code ?? 0;
      ffmpegDone = true;
      maybeResolve();
    });
    gifski.on('close', (code) => {
      clearTrackedChild(job, gifski);
      gifskiCode = code ?? 0;
      gifskiDone = true;
      maybeResolve();
    });

    function maybeResolve() {
      if (!ffmpegDone || !gifskiDone || settled) return;
      if (job.cancelRequested || job.status === 'cancelled') {
        finish(cancelError());
        return;
      }

      if (ffmpegCode !== 0) {
        finish(new Error(ffmpegStderr.trim().split(/\r?\n/).slice(-8).join('\n') || `ffmpeg exited with code ${ffmpegCode}`));
        return;
      }

      if (gifskiCode !== 0) {
        finish(new Error(gifskiStderr.trim().split(/\r?\n/).slice(-8).join('\n') || `gifski exited with code ${gifskiCode}`));
        return;
      }

      settled = true;
      job.progress = Math.max(job.progress, progressEnd);
      resolve();
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      ffmpeg.stdout.destroy();
      gifski.stdin.destroy();
      killChild(ffmpeg);
      killChild(gifski);
      clearTrackedChild(job, ffmpeg);
      clearTrackedChild(job, gifski);
      reject(error);
    }
  });
}

function parseFfmpegTime(text) {
  const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
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
    settings: job.settings
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

function recordCommand(job, stage, args, tool = ffmpegPath) {
  job.commands.push({
    stage,
    tool,
    args,
    command: [tool, ...args].map(commandToken).join(' ')
  });
  if (job.commands.length > 20) job.commands.shift();
}

function commandToken(value) {
  const text = String(value);
  if (!/[\s"']/g.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function log(job, message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 200) job.logs.shift();
}

function safeBaseName(name) {
  const base = path.basename(name, path.extname(name));
  return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gifm-output';
}

function downloadName(inputName, format = 'gif') {
  const ext = format === 'apng' ? 'png' : format === 'webp' ? 'webp' : format === 'mp4' ? 'mp4' : 'gif';
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

