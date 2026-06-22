import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
const portableDir = path.join(rootDir, 'release', `GIFM-v${packageJson.version}-win-x64`);
const nodePath = path.join(portableDir, 'node', 'node.exe');
const serverPath = path.join(portableDir, 'server', 'index.js');
const port = 4194;
const baseUrl = `http://127.0.0.1:${port}`;

await assertExists(nodePath);
await assertExists(serverPath);
await assertExists(path.join(portableDir, 'dist', 'index.html'));
await assertExists(path.join(portableDir, 'node_modules', 'ffmpeg-static'));
await assertExists(`${portableDir}.zip`);

const server = spawn(nodePath, [serverPath], {
  cwd: portableDir,
  env: { ...process.env, GIFM_PORT: String(port), GIFM_HOST: '127.0.0.1' },
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
  console.log(`Portable smoke passed: ${portableDir}`);
} finally {
  server.kill();
}

async function assertExists(filePath) {
  await fs.stat(filePath);
}

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          const health = await response.json();
          if (health.ffmpeg?.available && health.ffprobe?.available) {
            resolve();
            return;
          }
        }
      } catch {
        // Server is still starting.
      }

      if (Date.now() > deadline) {
        reject(new Error(`Portable server did not become healthy.\n${serverLog}`));
        return;
      }

      setTimeout(tick, 300);
    };
    tick();
  });
}
