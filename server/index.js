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

const VERSION = '0.2.0';
const PORT = parsePositiveInteger(process.env.GIFM_PORT ?? process.env.PORT, 4174);
const HOST = (process.env.GIFM_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const ALLOW_REMOTE = process.env.GIFM_ALLOW_REMOTE === '1';
const GIFSKI_PATH = process.env.GIFM_GIFSKI_PATH ? path.resolve(process.env.GIFM_GIFSKI_PATH) : '';
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
const ffprobePath = ffprobeStatic.path;
const jobs = new Map();
const sources = new Map();
const jobQueue = [];
let runningJobs = 0;
const supportedExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif']);
const targetProfiles = {
  free: 10,
  'nitro-basic': 50,
  nitro: 500,
  emoji: 256 / 1024,
  avatar: 10,
  custom: 10
};

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

  response.setHeader('Content-Type', 'image/gif');
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName(job.inputName)}"`);
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

  let width = even(clamp(job.settings.width, 120, 1280));
  let fps = Math.round(clamp(job.settings.fps, 5, 30));
  let colors = Math.round(clamp(job.settings.colors, 16, 256));
  let dedupeFrames = false;
  let frameDropModulo = 0;
  const maxAttempts = job.settings.autoFit ? 9 : 1;
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
    const outputPath = path.join(outputDir, `${safeBaseName(job.inputName)}-${job.id.slice(0, 8)}-a${attempt}.gif`);
    trackOutputCandidate(job, outputPath);
    const strategy = strategyLabel({ width, fps, colors, dedupeFrames, frameDropModulo });

    const attemptRecord = { attempt, width, fps, colors, durationSec, strategy, dedupeFrames, frameDropModulo };
    job.attempts.push(attemptRecord);
    job.stage = job.settings.encoderBackend === 'gifski' ? `Attempt ${attempt}: gifski` : `Attempt ${attempt}: palette`;
    log(job, `Attempt ${attempt}: ${width}px, ${fps} fps, ${colors} colors, ${durationSec.toFixed(2)} sec, ${strategy}`);

    if (job.settings.encoderBackend === 'gifski') {
      await encodeWithGifski({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo });
    } else {
      await encodeWithFfmpeg({ job, attempt, palettePattern, palettePath, outputPath, startSec, durationSec, width, fps, colors, dedupeFrames, frameDropModulo });
    }
    checkCancelled(job);

    const stat = await fs.stat(outputPath);
    attemptRecord.outputBytes = stat.size;
    lastOutputPath = outputPath;
    log(job, `Attempt ${attempt} output: ${formatBytes(stat.size)}`);
    const rejectedLargerGif = job.sourceKind === 'gif' && stat.size >= job.inputSize;
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
      durationSec,
      outputBytes: stat.size,
      targetBytes: job.targetBytes,
      allowTrim: job.settings.allowTrim
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
    durationSec = next.durationSec;
  }

  const finalOutputPath = bestOutputPath || lastOutputPath;
  if (!finalOutputPath) {
    throw new ApiError(422, 'NO_OUTPUT', 'No GIF output was produced.');
  }

  if (job.sourceKind === 'gif' && !bestOutputPath) {
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

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
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

function parseFrameRate(raw) {
  if (!raw || raw === '0/0') return null;
  const [numerator, denominator] = String(raw).split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return numerator / denominator;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
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

function isProtectedPath(entryPath, protectedPaths) {
  const resolved = path.resolve(entryPath);
  for (const protectedPath of protectedPaths) {
    if (resolved === protectedPath) return true;
    if (protectedPath.startsWith(`${resolved}${path.sep}`)) return true;
    if (resolved.startsWith(`${protectedPath}${path.sep}`)) return true;
  }
  return false;
}

function parseSettings(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw && typeof raw === 'object' ? raw : {};
  } catch {
    throw new ApiError(400, 'INVALID_SETTINGS', 'Settings must be valid JSON.');
  }

  const preset = normalizeTargetPreset(parsed.targetPreset);
  const profileTargetMb = targetProfiles[preset] ?? targetProfiles.free;
  const targetMb = preset === 'custom' ? clamp(Number(parsed.targetMb ?? profileTargetMb), 0.05, 500) : profileTargetMb;

  return {
    targetPreset: preset,
    targetMb,
    width: even(clamp(Number(parsed.width ?? 480), 120, 1280)),
    fps: clamp(Number(parsed.fps ?? 15), 5, 30),
    startSec: clamp(Number(parsed.startSec ?? 0), 0, MAX_TRIM_START_SEC),
    durationSec: clamp(Number(parsed.durationSec ?? 6), 0.5, 60),
    colors: clamp(Number(parsed.colors ?? 96), 16, 256),
    dither: ['sierra2_4a', 'bayer', 'floyd_steinberg', 'none'].includes(parsed.dither) ? parsed.dither : 'sierra2_4a',
    paletteMode: ['diff', 'full', 'single'].includes(parsed.paletteMode) ? parsed.paletteMode : 'diff',
    encoderBackend: parsed.encoderBackend === 'gifski' ? 'gifski' : 'ffmpeg',
    autoFit: Boolean(parsed.autoFit ?? true),
    allowTrim: Boolean(parsed.allowTrim ?? false)
  };
}

function normalizeTargetPreset(value) {
  if (value === '10') return 'free';
  if (value === '50') return 'nitro-basic';
  return Object.hasOwn(targetProfiles, value) ? value : 'free';
}

function nextAttempt({ width, fps, colors, dedupeFrames, frameDropModulo, durationSec, outputBytes, targetBytes, allowTrim }) {
  const overRatio = outputBytes / targetBytes;
  const scale = clamp(Math.sqrt(targetBytes / outputBytes) * 0.94, 0.68, 0.9);
  let nextWidth = even(Math.max(120, width * scale));
  let nextFps = fps;
  let nextColors = colors;
  let nextDedupeFrames = dedupeFrames;
  let nextFrameDropModulo = frameDropModulo;
  let nextDuration = durationSec;

  if (nextWidth >= width - 8) {
    nextWidth = width;
    if (nextFps > 6) {
      nextFps = Math.max(6, nextFps - (overRatio > 1.6 ? 3 : 2));
    } else if (nextColors > 32) {
      nextColors = Math.max(32, nextColors - (overRatio > 1.6 ? 32 : 16));
    } else if (!nextDedupeFrames) {
      nextDedupeFrames = true;
    } else if (nextFrameDropModulo === 0) {
      nextFrameDropModulo = 5;
    } else if (nextFrameDropModulo > 3) {
      nextFrameDropModulo -= 1;
    } else if (allowTrim && nextDuration > 1) {
      nextDuration = Math.max(1, nextDuration * scale);
    } else {
      return null;
    }
  } else if (overRatio > 1.25 && nextColors > 64) {
    nextColors = Math.max(64, nextColors - 16);
  }

  if (
    nextWidth === width &&
    nextFps === fps &&
    nextColors === colors &&
    nextDedupeFrames === dedupeFrames &&
    nextFrameDropModulo === frameDropModulo &&
    Math.abs(nextDuration - durationSec) < 0.05
  ) {
    return null;
  }

  return {
    width: nextWidth,
    fps: Math.round(nextFps),
    colors: Math.round(nextColors),
    dedupeFrames: nextDedupeFrames,
    frameDropModulo: nextFrameDropModulo,
    durationSec: Number(nextDuration.toFixed(2))
  };
}

function videoFilterChain({ width, fps, dedupeFrames, frameDropModulo }) {
  const filters = [];
  if (dedupeFrames) {
    filters.push('mpdecimate', 'setpts=N/FRAME_RATE/TB');
  }
  if (frameDropModulo > 0) {
    filters.push(`select='not(eq(mod(n\\,${frameDropModulo})\\,0))'`, 'setpts=N/FRAME_RATE/TB');
  }
  filters.push(`fps=${fps}`, `scale=${width}:-2:flags=lanczos`);
  return filters.join(',');
}

function strategyLabel({ width, fps, colors, dedupeFrames, frameDropModulo }) {
  const parts = [`${width}px`, `${fps}fps`, `${colors} colors`];
  if (dedupeFrames) parts.push('dedupe frames');
  if (frameDropModulo > 0) parts.push(`drop every ${frameDropModulo}th frame`);
  parts.push('transparency rectangles');
  return parts.join(' / ');
}

function trimArgs(startSec, durationSec) {
  const args = [];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-t', String(durationSec));
  return args;
}

function ditherFilter(mode) {
  if (mode === 'bayer') return 'dither=bayer:bayer_scale=5';
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

async function encodeWithFfmpeg({ job, attempt, palettePattern, palettePath, outputPath, startSec, durationSec, width, fps, colors, dedupeFrames, frameDropModulo }) {
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      `${videoFilterChain({ width, fps, dedupeFrames, frameDropModulo })},palettegen=max_colors=${colors}:stats_mode=${job.settings.paletteMode}`,
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
  const dither = ditherFilter(job.settings.dither);
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-i',
      palettePath,
      '-lavfi',
      `${videoFilterChain({ width, fps, dedupeFrames, frameDropModulo })}[x];[x][1:v]paletteuse=${dither}:diff_mode=rectangle`,
      '-loop',
      '0',
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

async function encodeWithGifski({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo }) {
  if (!runtimeInfo.gifski.available) {
    throw new ApiError(400, 'GIFSKI_UNAVAILABLE', 'Set GIFM_GIFSKI_PATH to use the gifski encoder backend.');
  }

  await runFfmpegToGifski(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain({ width, fps, dedupeFrames, frameDropModulo }),
      '-pix_fmt',
      'yuv420p',
      '-f',
      'yuv4mpegpipe',
      '-'
    ],
    ['--quality', '90', '--output', outputPath, '-'],
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

function downloadName(inputName) {
  return `${safeBaseName(inputName)}-gifm.gif`;
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
  const [ffmpegVersion, ffprobeVersion, gifskiVersion] = await Promise.all([
    toolVersion(ffmpegPath),
    toolVersion(ffprobePath),
    gifskiAvailable ? toolVersion(GIFSKI_PATH) : Promise.resolve(gifskiConfigured ? 'missing' : 'not configured')
  ]);

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
    }
  };
}

function toolVersion(toolPath) {
  return new Promise((resolve) => {
    const child = spawn(toolPath, ['-version'], { windowsHide: true });
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

function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
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

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
