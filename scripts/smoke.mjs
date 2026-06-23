import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const smokeDir = path.join(rootDir, 'data', 'smoke');
const smokeOutputDir = path.join(rootDir, 'data', 'smoke-output');
const samplePath = path.join(smokeDir, 'sample.mp4');
const longSamplePath = path.join(smokeDir, 'long-sample.mp4');
const audioOnlyPath = path.join(smokeDir, 'audio-only.mp4');
const port = 4184;
const baseUrl = `http://127.0.0.1:${port}`;

await fs.mkdir(smokeDir, { recursive: true });
await fs.rm(smokeOutputDir, { recursive: true, force: true });
await fs.mkdir(smokeOutputDir, { recursive: true });
await run(ffmpegPath, [
  '-hide_banner',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=15',
  '-t',
  '2',
  '-pix_fmt',
  'yuv420p',
  '-y',
  samplePath
]);
await run(ffmpegPath, [
  '-hide_banner',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=30',
  '-t',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-y',
  longSamplePath
]);
await run(ffmpegPath, [
  '-hide_banner',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:sample_rate=44100',
  '-t',
  '1',
  '-vn',
  '-c:a',
  'aac',
  '-y',
  audioOnlyPath
]);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: rootDir,
  env: {
    ...process.env,
    GIFM_PORT: String(port),
    GIFM_MAX_UPLOAD_MB: '16',
    GIFM_DATA_MAX_MB: '64',
    GIFM_MAX_CONCURRENT_JOBS: 'invalid',
    GIFM_GIFSKI_PATH: '',
    GIFM_OUTPUT_DIR: smokeOutputDir
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

try {
  await waitForHealth();
  await assertHealthDiagnostics();
  await assertMalformedMultipart();
  await assertTooLargeUpload();
  await assertUnsupportedContent();
  await assertProbeMetadata();
  await assertPreparedSourceClipJobs();
  await assertNoVideoJob();
  await assertQueueAndCancel();
  await assertAttemptOutputCleanup();
  await assertTrimStartAdjustment();
  await assertEncodeFeatureMatrix();

  const fileBytes = await fs.readFile(samplePath);
  const form = new FormData();
  form.set('media', new File([fileBytes], 'sample.mp4', { type: 'video/mp4' }));
  form.set('settings', JSON.stringify(validSettings()));

  const started = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  if (!started.ok) {
    throw new Error(`Failed to start smoke job: ${started.status} ${await started.text()}`);
  }

  let job = await started.json();
  job = await waitForJob(job.id, 45000);

  if (job.status !== 'complete') {
    throw new Error(`Smoke job did not complete: ${JSON.stringify(job, null, 2)}\n${serverLog}`);
  }

  const download = await fetch(`${baseUrl}${job.downloadUrl}`);
  const gifBytes = Buffer.from(await download.arrayBuffer());
  if (gifBytes.length < 16 || gifBytes.slice(0, 3).toString('ascii') !== 'GIF') {
    throw new Error('Downloaded output is not a GIF file.');
  }
  if (gifBytes.length > job.targetBytes) {
    throw new Error(`Smoke GIF exceeded target: ${gifBytes.length} > ${job.targetBytes}`);
  }
  if (!job.attempts.every((attempt) => typeof attempt.strategy === 'string' && attempt.strategy.includes('transparency'))) {
    throw new Error(`Attempt strategy metadata missing: ${JSON.stringify(job.attempts, null, 2)}`);
  }
  const outputFiles = await fs.readdir(smokeOutputDir);
  if (!outputFiles.some((name) => name.endsWith('.gif'))) {
    throw new Error(`Expected smoke GIF in custom output directory, found ${JSON.stringify(outputFiles)}`);
  }

  await assertWebhookValidation(job.id);

  console.log(`Smoke passed: ${gifBytes.length} bytes, ${job.attempts.length} attempt(s).`);
} finally {
  server.kill();
}

async function assertMalformedMultipart() {
  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: 'broken'
  });
  await expectApiError(response, 400, 'MALFORMED_MULTIPART');
}

async function assertHealthDiagnostics() {
  const response = await fetch(`${baseUrl}/api/health`);
  const health = await response.json();
  if (!health.ffmpeg?.path || !health.ffmpeg?.version || !health.ffprobe?.path || !health.platform?.node || !health.gifski?.version) {
    throw new Error(`Health diagnostics incomplete: ${JSON.stringify(health, null, 2)}`);
  }
  if (health.gifski.available) {
    throw new Error(`Smoke test should not enable gifski without GIFM_GIFSKI_PATH: ${JSON.stringify(health.gifski, null, 2)}`);
  }
  if (health.maxConcurrentJobs !== 1) {
    throw new Error(`Invalid GIFM_MAX_CONCURRENT_JOBS should fall back to 1: ${JSON.stringify(health, null, 2)}`);
  }
}

async function assertTooLargeUpload() {
  const form = new FormData();
  form.set('media', new File([Buffer.alloc(17 * 1024 * 1024)], 'large.mp4', { type: 'video/mp4' }));
  form.set('settings', JSON.stringify(validSettings()));
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  await expectApiError(response, 413, 'UPLOAD_TOO_LARGE');
}

async function assertUnsupportedContent() {
  const form = new FormData();
  form.set('media', new File([Buffer.from('not a video')], 'fake.mp4', { type: 'video/mp4' }));
  form.set('settings', JSON.stringify(validSettings()));
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  await expectApiError(response, 415, 'UNSUPPORTED_MEDIA_CONTENT');
}

async function assertProbeMetadata() {
  const fileBytes = await fs.readFile(samplePath);
  const form = new FormData();
  form.set('media', new File([fileBytes], 'sample.mp4', { type: 'video/mp4' }));

  const response = await fetch(`${baseUrl}/api/probe`, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`Probe failed: ${response.status} ${await response.text()}`);
  }

  const metadata = await response.json();
  if (!metadata.durationSec || !metadata.width || !metadata.height || !metadata.codec) {
    throw new Error(`Probe metadata incomplete: ${JSON.stringify(metadata, null, 2)}`);
  }
}

async function assertPreparedSourceClipJobs() {
  const fileBytes = await fs.readFile(samplePath);
  const form = new FormData();
  form.set('media', new File([fileBytes], 'prepared-source.mp4', { type: 'video/mp4' }));

  const preparedResponse = await fetch(`${baseUrl}/api/sources`, { method: 'POST', body: form });
  if (!preparedResponse.ok) {
    throw new Error(`Prepared source upload failed: ${preparedResponse.status} ${await preparedResponse.text()}`);
  }

  const source = await preparedResponse.json();
  if (!source.id || !source.durationSec || !source.width || !source.height) {
    throw new Error(`Prepared source metadata incomplete: ${JSON.stringify(source, null, 2)}`);
  }

  const first = await startPreparedSourceJob(source.id, 'Clip 01', { ...validSettings(), startSec: 0, durationSec: 0.7 });
  const firstJob = await waitForJob(first.id, 45000);
  if (firstJob.status !== 'complete' || !firstJob.inputName.includes('Clip 01')) {
    throw new Error(`Prepared source first clip failed: ${JSON.stringify(firstJob, null, 2)}`);
  }

  const second = await startPreparedSourceJob(source.id, 'Clip 02', { ...validSettings(), startSec: 0.8, durationSec: 0.7 });
  const secondJob = await waitForJob(second.id, 45000);
  if (secondJob.status !== 'complete' || !secondJob.inputName.includes('Clip 02')) {
    throw new Error(`Prepared source second clip failed: ${JSON.stringify(secondJob, null, 2)}`);
  }
}

async function assertNoVideoJob() {
  const audioBytes = await fs.readFile(audioOnlyPath);
  const form = new FormData();
  form.set('media', new File([audioBytes], 'audio-only.mp4', { type: 'video/mp4' }));
  form.set('settings', JSON.stringify(validSettings()));

  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`No-video job failed to start unexpectedly: ${response.status} ${await response.text()}`);
  }

  const started = await response.json();
  const job = await waitForJob(started.id, 20000);
  if (job.status !== 'failed' || job.errorCode !== 'NO_VIDEO_STREAM') {
    throw new Error(`Expected no-video job error, got ${JSON.stringify(job, null, 2)}`);
  }
}

async function assertQueueAndCancel() {
  const bytes = await fs.readFile(longSamplePath);
  const first = await startMediaJob(bytes, 'long-a.mp4', slowSettings());
  await waitForStatus(first.id, ['running'], 10000);

  const second = await startMediaJob(bytes, 'long-b.mp4', slowSettings());
  if (second.status !== 'queued' || second.queuePosition !== 1) {
    throw new Error(`Expected second job queued at #1, got ${JSON.stringify(second, null, 2)}`);
  }

  const cancelledQueued = await cancelJob(second.id);
  if (cancelledQueued.status !== 'cancelled') {
    throw new Error(`Expected queued job cancellation, got ${JSON.stringify(cancelledQueued, null, 2)}`);
  }

  const cancelledRunning = await cancelJob(first.id);
  if (cancelledRunning.status !== 'cancelled') {
    throw new Error(`Expected running job cancellation, got ${JSON.stringify(cancelledRunning, null, 2)}`);
  }

  await waitForStatus(first.id, ['cancelled'], 10000);
}

async function assertAttemptOutputCleanup() {
  const bytes = await fs.readFile(samplePath);
  const started = await startMediaJob(bytes, 'multi-attempt.mp4', cleanupSettings());
  const job = await waitForJob(started.id, 45000);
  if (job.status !== 'complete') {
    throw new Error(`Cleanup job did not complete: ${JSON.stringify(job, null, 2)}`);
  }
  if (job.attempts.length < 2) {
    throw new Error(`Cleanup job should force multiple attempts: ${JSON.stringify(job.attempts, null, 2)}`);
  }

  const outputFiles = await fs.readdir(smokeOutputDir);
  const jobOutputs = outputFiles.filter((name) => name.includes(job.id.slice(0, 8)) && name.endsWith('.gif'));
  if (jobOutputs.length !== 1) {
    throw new Error(`Expected only the selected final GIF to remain, found ${JSON.stringify(jobOutputs)}`);
  }
}

async function assertTrimStartAdjustment() {
  const bytes = await fs.readFile(samplePath);
  const started = await startMediaJob(bytes, 'trim-beyond-duration.mp4', {
    ...validSettings(),
    startSec: 999,
    durationSec: 4
  });
  const job = await waitForJob(started.id, 45000);
  if (job.status !== 'complete') {
    throw new Error(`Trim adjustment job did not complete: ${JSON.stringify(job, null, 2)}`);
  }
  if (!job.warnings.some((warning) => warning.includes('adjusted'))) {
    throw new Error(`Expected trim adjustment warning, got ${JSON.stringify(job.warnings, null, 2)}`);
  }
}

async function assertWebhookValidation(jobId) {
  // The webhook endpoint must reject non-Discord and non-https URLs (SSRF guard) before attempting any POST.
  const cases = [
    { url: 'https://evil.example.com/api/webhooks/1/abc', code: 'INVALID_WEBHOOK' },
    { url: 'http://discord.com/api/webhooks/1/abc', code: 'INVALID_WEBHOOK' },
    { url: 'https://discord.com/not-a-webhook', code: 'INVALID_WEBHOOK' }
  ];
  for (const testCase of cases) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: testCase.url })
    });
    await expectApiError(response, 400, testCase.code);
  }
}

async function assertEncodeFeatureMatrix() {
  const bytes = await fs.readFile(samplePath);

  // Each case drives a real encode and asserts the recorded ffmpeg command reflects the feature.
  const cases = [
    { label: 'crop', settings: featureSettings({ crop: { enabled: true, x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }), expect: "crop='iw*0.5'" },
    { label: 'speed', settings: featureSettings({ speed: 2 }), expect: 'setpts=PTS/2' },
    { label: 'reverse', settings: featureSettings({ playback: 'reverse' }), expect: ',reverse' },
    { label: 'boomerang', settings: featureSettings({ playback: 'boomerang' }), expect: 'concat=n=2' },
    { label: 'bayer', settings: featureSettings({ dither: 'bayer', bayerScale: 3 }), expect: 'dither=bayer:bayer_scale=3' },
    { label: 'loop-once', settings: featureSettings({ loopCount: -1 }), expect: '-loop -1' },
    { label: 'caption', settings: featureSettings({ caption: { top: 'TOP', bottom: 'BOTTOM' } }), expect: 'drawtext' },
    { label: 'rotate', settings: featureSettings({ rotate: 90 }), expect: 'transpose=1' },
    { label: 'flip', settings: featureSettings({ flipH: true, flipV: true }), expect: 'hflip,vflip' },
    { label: 'grayscale', settings: featureSettings({ colorFilter: 'grayscale' }), expect: 'hue=s=0' },
    { label: 'invert', settings: featureSettings({ colorFilter: 'invert' }), expect: 'negate' },
    { label: 'saturation', settings: featureSettings({ saturation: 1.8 }), expect: 'eq=saturation=1.8' }
  ];

  for (const testCase of cases) {
    const started = await startMediaJob(bytes, `feature-${testCase.label}.mp4`, testCase.settings);
    const job = await waitForJob(started.id, 45000);
    if (job.status !== 'complete') {
      throw new Error(`Feature '${testCase.label}' did not complete: ${JSON.stringify(job, null, 2)}\n${serverLog}`);
    }
    if (!job.commands?.some((command) => command.command.includes(testCase.expect))) {
      throw new Error(`Feature '${testCase.label}' missing '${testCase.expect}' in commands: ${JSON.stringify(job.commands, null, 2)}`);
    }
  }

  // Sticker preset forces a square 320x320 APNG; verify the real output format and dimensions.
  const sticker = await startMediaJob(bytes, 'feature-sticker.mp4', { ...featureSettings(), targetPreset: 'sticker' });
  const stickerJob = await waitForJob(sticker.id, 45000);
  if (stickerJob.status !== 'complete') {
    throw new Error(`Sticker job did not complete: ${JSON.stringify(stickerJob, null, 2)}\n${serverLog}`);
  }
  const stickerDownload = await fetch(`${baseUrl}${stickerJob.downloadUrl}`);
  if (stickerDownload.headers.get('content-type') !== 'image/apng') {
    throw new Error(`Sticker download should be image/apng, got ${stickerDownload.headers.get('content-type')}`);
  }
  const stickerBytes = Buffer.from(await stickerDownload.arrayBuffer());
  if (stickerBytes.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Sticker output is not a valid PNG/APNG file.');
  }
  const dims = await probeDimensions(stickerBytes, '.png');
  if (dims.width !== 320 || dims.height !== 320) {
    throw new Error(`Sticker output should be 320x320, got ${dims.width}x${dims.height}`);
  }

  // Animated WebP export: verify a valid RIFF/WEBP file served as image/webp and smaller than the GIF.
  const gifJob = await waitForJob((await startMediaJob(bytes, 'feature-gifbaseline.mp4', featureSettings({ format: 'gif' }))).id, 45000);
  const webpJob = await waitForJob((await startMediaJob(bytes, 'feature-webp.mp4', featureSettings({ format: 'webp' }))).id, 45000);
  if (webpJob.status !== 'complete') {
    throw new Error(`WebP job did not complete: ${JSON.stringify(webpJob, null, 2)}\n${serverLog}`);
  }
  const webpDownload = await fetch(`${baseUrl}${webpJob.downloadUrl}`);
  if (webpDownload.headers.get('content-type') !== 'image/webp') {
    throw new Error(`WebP download should be image/webp, got ${webpDownload.headers.get('content-type')}`);
  }
  const webpBytes = Buffer.from(await webpDownload.arrayBuffer());
  if (webpBytes.slice(0, 4).toString('ascii') !== 'RIFF' || webpBytes.slice(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('WebP output is not a valid RIFF/WEBP file.');
  }
  if (webpBytes.length >= gifJob.outputBytes) {
    throw new Error(`WebP (${webpBytes.length}) should be smaller than GIF (${gifJob.outputBytes}) for the same source.`);
  }

  // MP4 silent-loop export: verify a muted faststart H.264 served as video/mp4.
  const mp4Job = await waitForJob((await startMediaJob(bytes, 'feature-mp4.mp4', featureSettings({ format: 'mp4' }))).id, 45000);
  if (mp4Job.status !== 'complete') {
    throw new Error(`MP4 job did not complete: ${JSON.stringify(mp4Job, null, 2)}\n${serverLog}`);
  }
  const mp4Download = await fetch(`${baseUrl}${mp4Job.downloadUrl}`);
  if (mp4Download.headers.get('content-type') !== 'video/mp4') {
    throw new Error(`MP4 download should be video/mp4, got ${mp4Download.headers.get('content-type')}`);
  }
  const mp4Bytes = Buffer.from(await mp4Download.arrayBuffer());
  const mp4Path = path.join(smokeDir, 'probe-check.mp4');
  await fs.writeFile(mp4Path, mp4Bytes);
  try {
    const codec = (await captureStdout(ffprobeStatic.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mp4Path])).trim();
    const audioStreams = (await captureStdout(ffprobeStatic.path, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', mp4Path])).trim();
    if (codec !== 'h264') throw new Error(`MP4 should be H.264, got ${codec}`);
    if (audioStreams) throw new Error(`MP4 should have no audio, got streams: ${audioStreams}`);
  } finally {
    await fs.rm(mp4Path, { force: true });
  }
}

async function probeDimensions(bytes, ext) {
  const tempPath = path.join(smokeDir, `probe-${Date.now()}${ext}`);
  await fs.writeFile(tempPath, bytes);
  try {
    const output = await captureStdout(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', tempPath
    ]);
    const [width, height] = output.trim().split(',').map(Number);
    return { width, height };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function captureStdout(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} exited with ${code}`))));
  });
}

async function startMediaJob(bytes, name, settings) {
  const form = new FormData();
  form.set('media', new File([bytes], name, { type: 'video/mp4' }));
  form.set('settings', JSON.stringify(settings));

  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`Failed to start ${name}: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function startPreparedSourceJob(sourceId, clipName, settings) {
  const response = await fetch(`${baseUrl}/api/sources/${sourceId}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clipName, settings })
  });
  if (!response.ok) {
    throw new Error(`Failed to start prepared source clip ${clipName}: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function cancelJob(id) {
  const response = await fetch(`${baseUrl}/api/jobs/${id}/cancel`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to cancel ${id}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function expectApiError(response, status, code) {
  const payload = await response.json().catch(() => null);
  if (response.status !== status || payload?.error?.code !== code) {
    throw new Error(`Expected ${status}/${code}, got ${response.status} ${JSON.stringify(payload)}`);
  }
}

async function waitForJob(id, timeoutMs) {
  let job = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(800);
    const response = await fetch(`${baseUrl}/api/jobs/${id}`);
    job = await response.json();
    if (['complete', 'failed', 'cancelled'].includes(job.status)) return job;
  }

  throw new Error(`Job did not finish before timeout: ${JSON.stringify(job, null, 2)}\n${serverLog}`);
}

async function waitForStatus(id, statuses, timeoutMs) {
  let job = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(200);
    const response = await fetch(`${baseUrl}/api/jobs/${id}`);
    job = await response.json();
    if (statuses.includes(job.status)) return job;
    if (['complete', 'failed', 'cancelled'].includes(job.status) && !statuses.includes(job.status)) break;
  }

  throw new Error(`Job did not reach ${statuses.join('/')} before timeout: ${JSON.stringify(job, null, 2)}\n${serverLog}`);
}

function validSettings() {
  return {
    targetPreset: 'custom',
    targetMb: 1,
    width: 240,
    fps: 10,
    startSec: 0,
    durationSec: 1.5,
    colors: 64,
    dither: 'sierra2_4a',
    paletteMode: 'diff',
    encoderBackend: 'ffmpeg',
    autoFit: true,
    allowTrim: false
  };
}

function slowSettings() {
  return {
    targetPreset: 'custom',
    targetMb: 1,
    width: 640,
    fps: 30,
    startSec: 0,
    durationSec: 18,
    colors: 256,
    dither: 'sierra2_4a',
    paletteMode: 'full',
    encoderBackend: 'ffmpeg',
    autoFit: false,
    allowTrim: false
  };
}

function featureSettings(overrides = {}) {
  // Generous target + small dimensions so each encode completes in one attempt and the recorded
  // command reflects the requested feature settings rather than auto-fit fallbacks.
  return {
    ...validSettings(),
    targetPreset: 'custom',
    targetMb: 50,
    width: 200,
    fps: 8,
    durationSec: 1,
    optimize: false,
    ...overrides
  };
}

function cleanupSettings() {
  return {
    targetPreset: 'custom',
    targetMb: 0.05,
    width: 640,
    fps: 30,
    startSec: 0,
    durationSec: 2,
    colors: 256,
    dither: 'sierra2_4a',
    paletteMode: 'full',
    encoderBackend: 'ffmpeg',
    autoFit: true,
    allowTrim: false
  };
}

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Server is still starting.
      }

      if (Date.now() > deadline) {
        reject(new Error(`Server did not become healthy.\n${serverLog}`));
        return;
      }

      setTimeout(tick, 300);
    };
    tick();
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with ${code}`));
        return;
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
