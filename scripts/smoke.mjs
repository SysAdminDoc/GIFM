import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const smokeDir = path.join(rootDir, 'data', 'smoke');
const samplePath = path.join(smokeDir, 'sample.mp4');
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

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: rootDir,
  env: { ...process.env, GIFM_PORT: String(port) },
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
  const fileBytes = await fs.readFile(samplePath);
  const form = new FormData();
  form.set('media', new File([fileBytes], 'sample.mp4', { type: 'video/mp4' }));
  form.set(
    'settings',
    JSON.stringify({
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
    })
  );

  const started = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  if (!started.ok) {
    throw new Error(`Failed to start smoke job: ${started.status} ${await started.text()}`);
  }

  let job = await started.json();
  const deadline = Date.now() + 45000;
  while (!['complete', 'error'].includes(job.status) && Date.now() < deadline) {
    await delay(800);
    const response = await fetch(`${baseUrl}/api/jobs/${job.id}`);
    job = await response.json();
  }

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
