import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
const portableDir = path.join(rootDir, 'release', `GIFM-v${packageJson.version}-win-x64`);
const launcherPath = path.join(portableDir, 'GIFM.exe');
const nodePath = path.join(portableDir, 'node', 'node.exe');
const serverPath = path.join(portableDir, 'server', 'index.js');
const port = 4194;

await assertExists(launcherPath);
await assertExists(nodePath);
await assertExists(serverPath);
await assertExists(path.join(portableDir, 'dist', 'index.html'));
await assertExists(path.join(portableDir, 'node_modules', 'ffmpeg-static'));
await assertExists(`${portableDir}.zip`);

const server = spawn(launcherPath, [], {
  cwd: portableDir,
  env: {
    ...process.env,
    GIFM_PORT: String(port),
    GIFM_HOST: '127.0.0.1',
    GIFM_OPEN_BROWSER: '0',
    GIFM_LAUNCHER_SMOKE: '1'
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
  await waitForExit(server);
  console.log(`Portable smoke passed: ${portableDir}`);
} finally {
  if (!server.killed) server.kill();
}

async function assertExists(filePath) {
  await fs.stat(filePath);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Launcher did not exit before timeout.\n${serverLog}`));
    }, 20000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Launcher exited with ${code}.\n${serverLog}`));
        return;
      }
      resolve();
    });
  });
}
