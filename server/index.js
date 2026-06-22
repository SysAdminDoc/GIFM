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

const VERSION = '0.1.0';
const PORT = Number(process.env.GIFM_PORT ?? process.env.PORT ?? 4174);
const HOST = process.env.GIFM_HOST ?? '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const outputDir = path.join(dataDir, 'output');
const workDir = path.join(dataDir, 'work');
const distDir = path.join(rootDir, 'dist');
const ffprobePath = ffprobeStatic.path;
const jobs = new Map();

await Promise.all([uploadDir, outputDir, workDir].map((dir) => fs.mkdir(dir, { recursive: true })));

if (!ffmpegPath || !ffprobePath) {
  throw new Error('Bundled FFmpeg or FFprobe binary was not found.');
}

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
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, version: VERSION, ffmpeg: Boolean(ffmpegPath), ffprobe: Boolean(ffprobePath) });
});

app.post('/api/jobs', upload.single('media'), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: 'No media file was uploaded.' });
    return;
  }

  let settings;
  try {
    settings = parseSettings(request.body.settings);
  } catch (error) {
    await fs.rm(request.file.path, { force: true });
    response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings.' });
    return;
  }

  const id = randomUUID();
  const job = {
    id,
    status: 'queued',
    progress: 0,
    stage: 'Queued',
    inputPath: request.file.path,
    inputName: request.file.originalname,
    inputSize: request.file.size,
    outputPath: '',
    outputBytes: undefined,
    targetBytes: Math.round(settings.targetMb * 1024 * 1024),
    downloadUrl: undefined,
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
    warnings: [],
    logs: [],
    attempts: [],
    settings
  };

  jobs.set(id, job);
  response.status(202).json(publicJob(job));

  processJob(job).catch((error) => {
    job.status = 'error';
    job.stage = 'Failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.completedAt = new Date().toISOString();
    log(job, `ERROR: ${job.error}`);
  });
});

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: 'Job not found.' });
    return;
  }
  response.json(publicJob(job));
});

app.get('/api/jobs/:id/download', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== 'complete' || !job.outputPath || !existsSync(job.outputPath)) {
    response.status(404).json({ error: 'Output GIF not found.' });
    return;
  }

  response.setHeader('Content-Type', 'image/gif');
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName(job.inputName)}"`);
  createReadStream(job.outputPath).pipe(response);
});

app.post('/api/jobs/:id/reveal', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== 'complete' || !job.outputPath) {
    response.status(404).json({ error: 'Output GIF not found.' });
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

app.listen(PORT, HOST, () => {
  console.log(`GIFM v${VERSION} running at http://${HOST}:${PORT}`);
});

async function processJob(job) {
  job.status = 'running';
  job.stage = 'Probing media';
  job.progress = 2;
  log(job, `Input: ${job.inputName} (${formatBytes(job.inputSize)})`);

  const metadata = await ffprobe(job.inputPath);
  const sourceDuration = Number(metadata.format?.duration);
  const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');

  if (!videoStream) {
    throw new Error('No video stream was found in the selected file.');
  }

  const startSec = Math.max(0, job.settings.startSec);
  let durationSec = Math.max(0.5, job.settings.durationSec);
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    durationSec = Math.min(durationSec, Math.max(0.5, sourceDuration - startSec));
  }

  log(job, `Source: ${videoStream.width ?? '?'}x${videoStream.height ?? '?'} for ${durationSec.toFixed(2)} sec`);

  let width = even(clamp(job.settings.width, 120, 1280));
  let fps = Math.round(clamp(job.settings.fps, 5, 30));
  let colors = Math.round(clamp(job.settings.colors, 16, 256));
  const maxAttempts = job.settings.autoFit ? 9 : 1;
  let lastOutputPath = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptWorkDir = path.join(workDir, job.id);
    await fs.mkdir(attemptWorkDir, { recursive: true });
    const palettePath = path.join(attemptWorkDir, `palette-${attempt}-001.png`);
    const palettePattern = path.join(attemptWorkDir, `palette-${attempt}-%03d.png`);
    const outputPath = path.join(outputDir, `${safeBaseName(job.inputName)}-${job.id.slice(0, 8)}-a${attempt}.gif`);

    const attemptRecord = { attempt, width, fps, colors, durationSec };
    job.attempts.push(attemptRecord);
    job.stage = `Attempt ${attempt}: palette`;
    log(job, `Attempt ${attempt}: ${width}px, ${fps} fps, ${colors} colors, ${durationSec.toFixed(2)} sec`);

    await runFfmpeg(
      [
        ...trimArgs(startSec, durationSec),
        '-i',
        job.inputPath,
        '-vf',
        `fps=${fps},scale=${width}:-2:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=${job.settings.paletteMode}`,
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
        `fps=${fps},scale=${width}:-2:flags=lanczos[x];[x][1:v]paletteuse=${dither}:diff_mode=rectangle`,
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

    const stat = await fs.stat(outputPath);
    attemptRecord.outputBytes = stat.size;
    lastOutputPath = outputPath;
    log(job, `Attempt ${attempt} output: ${formatBytes(stat.size)}`);

    if (stat.size <= job.targetBytes) {
      job.outputPath = outputPath;
      job.outputBytes = stat.size;
      job.downloadUrl = `/api/jobs/${job.id}/download`;
      job.progress = 100;
      job.stage = 'Complete';
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      await cleanupWork(job.id);
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
    durationSec = next.durationSec;
  }

  const finalStat = await fs.stat(lastOutputPath);
  job.outputPath = lastOutputPath;
  job.outputBytes = finalStat.size;
  job.downloadUrl = `/api/jobs/${job.id}/download`;
  job.progress = 100;
  job.stage = 'Complete with warning';
  job.status = 'complete';
  job.completedAt = new Date().toISOString();
  job.warnings.push(`Final GIF is ${formatBytes(finalStat.size)}, which is above the ${formatBytes(job.targetBytes)} target.`);
  await cleanupWork(job.id);
  log(job, `Complete with warning: ${formatBytes(finalStat.size)} exceeds target`);
}

function parseSettings(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : {};
  const preset = ['10', '50', 'custom'].includes(parsed.targetPreset) ? parsed.targetPreset : '10';
  const targetMb = clamp(Number(parsed.targetMb ?? (preset === '50' ? 50 : 10)), 1, 500);

  return {
    targetPreset: preset,
    targetMb,
    width: even(clamp(Number(parsed.width ?? 480), 120, 1280)),
    fps: clamp(Number(parsed.fps ?? 15), 5, 30),
    startSec: clamp(Number(parsed.startSec ?? 0), 0, 7200),
    durationSec: clamp(Number(parsed.durationSec ?? 6), 0.5, 60),
    colors: clamp(Number(parsed.colors ?? 96), 16, 256),
    dither: ['sierra2_4a', 'bayer', 'floyd_steinberg', 'none'].includes(parsed.dither) ? parsed.dither : 'sierra2_4a',
    paletteMode: ['diff', 'full', 'single'].includes(parsed.paletteMode) ? parsed.paletteMode : 'diff',
    autoFit: Boolean(parsed.autoFit ?? true),
    allowTrim: Boolean(parsed.allowTrim ?? false)
  };
}

function nextAttempt({ width, fps, colors, durationSec, outputBytes, targetBytes, allowTrim }) {
  const overRatio = outputBytes / targetBytes;
  const scale = clamp(Math.sqrt(targetBytes / outputBytes) * 0.94, 0.68, 0.9);
  let nextWidth = even(Math.max(120, width * scale));
  let nextFps = fps;
  let nextColors = colors;
  let nextDuration = durationSec;

  if (nextWidth >= width - 8) {
    nextWidth = width;
    if (nextFps > 6) {
      nextFps = Math.max(6, nextFps - (overRatio > 1.6 ? 3 : 2));
    } else if (nextColors > 32) {
      nextColors = Math.max(32, nextColors - (overRatio > 1.6 ? 32 : 16));
    } else if (allowTrim && nextDuration > 1) {
      nextDuration = Math.max(1, nextDuration * scale);
    } else {
      return null;
    }
  } else if (overRatio > 1.25 && nextColors > 64) {
    nextColors = Math.max(64, nextColors - 16);
  }

  if (nextWidth === width && nextFps === fps && nextColors === colors && Math.abs(nextDuration - durationSec) < 0.05) {
    return null;
  }

  return {
    width: nextWidth,
    fps: Math.round(nextFps),
    colors: Math.round(nextColors),
    durationSec: Number(nextDuration.toFixed(2))
  };
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

function ffprobe(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath], {
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function runFfmpeg(args, job, stage, progressStart, progressEnd, durationSec) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', ...args], { windowsHide: true });
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

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `ffmpeg exited with code ${code}`));
        return;
      }
      job.progress = Math.max(job.progress, progressEnd);
      resolve();
    });
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
    inputName: job.inputName,
    inputSize: job.inputSize,
    outputBytes: job.outputBytes,
    targetBytes: job.targetBytes,
    downloadUrl: job.downloadUrl,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    warnings: job.warnings,
    logs: job.logs.slice(-120),
    attempts: job.attempts,
    settings: job.settings
  };
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
  await fs.rm(path.join(workDir, jobId), { recursive: true, force: true });
}

function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
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
