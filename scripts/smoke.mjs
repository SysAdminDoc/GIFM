import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const smokeDir = path.join(rootDir, 'data', 'smoke');
const samplePath = path.join(smokeDir, 'sample.mp4');
const audioOnlyPath = path.join(smokeDir, 'audio-only.mp4');
const port = 4184;
const baseUrl = `http://127.0.0.1:${port}`;

await fs.mkdir(smokeDir, { recursive: true });
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
  env: { ...process.env, GIFM_PORT: String(port), GIFM_MAX_UPLOAD_MB: '1', GIFM_DATA_MAX_MB: '32' },
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
  await assertMalformedMultipart();
  await assertTooLargeUpload();
  await assertUnsupportedContent();
  await assertNoVideoJob();

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

async function assertTooLargeUpload() {
  const form = new FormData();
  form.set('media', new File([Buffer.alloc(2 * 1024 * 1024)], 'large.mp4', { type: 'video/mp4' }));
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
  if (job.status !== 'error' || job.errorCode !== 'NO_VIDEO_STREAM') {
    throw new Error(`Expected no-video job error, got ${JSON.stringify(job, null, 2)}`);
  }
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
    if (['complete', 'error'].includes(job.status)) return job;
  }

  throw new Error(`Job did not finish before timeout: ${JSON.stringify(job, null, 2)}\n${serverLog}`);
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
