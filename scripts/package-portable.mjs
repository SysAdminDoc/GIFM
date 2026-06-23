import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
const releaseRoot = path.join(rootDir, 'release');
const packageName = `GIFM-v${packageJson.version}-win-x64`;
const portableDir = path.join(releaseRoot, packageName);
const zipPath = `${portableDir}.zip`;
const launcherProject = path.join(rootDir, 'launcher', 'GIFM.Launcher.csproj');
const launcherPublishDir = path.join(releaseRoot, 'launcher-publish');

if (process.platform !== 'win32') {
  throw new Error('The portable package currently targets Windows because it includes a start-gifm.cmd launcher.');
}

await fs.rm(portableDir, { recursive: true, force: true });
await fs.rm(zipPath, { force: true });
await fs.rm(launcherPublishDir, { recursive: true, force: true });
await fs.mkdir(path.join(portableDir, 'node'), { recursive: true });

await Promise.all([
  fs.cp(path.join(rootDir, 'dist'), path.join(portableDir, 'dist'), { recursive: true }),
  fs.cp(path.join(rootDir, 'server'), path.join(portableDir, 'server'), {
    recursive: true,
    // Test files are dev-only and must not ship in the released app.
    filter: (source) => !source.endsWith('.test.js')
  }),
  fs.cp(path.join(rootDir, 'assets'), path.join(portableDir, 'assets'), { recursive: true }),
  fs.copyFile(path.join(rootDir, 'package.json'), path.join(portableDir, 'package.json')),
  fs.copyFile(path.join(rootDir, 'package-lock.json'), path.join(portableDir, 'package-lock.json')),
  fs.copyFile(process.execPath, path.join(portableDir, 'node', 'node.exe'))
]);

await copyProductionModules(rootDir, portableDir);

await run('dotnet', [
  'publish',
  launcherProject,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-o',
  launcherPublishDir,
  '/p:PublishSingleFile=true',
  '/p:IncludeNativeLibrariesForSelfExtract=true',
  '/p:DebugType=none',
  '/p:DebugSymbols=false'
]);
await copyDirectoryContents(launcherPublishDir, portableDir);
await fs.rm(launcherPublishDir, { recursive: true, force: true });

// Bundle the Microsoft Edge WebView2 Evergreen bootstrapper so a clean machine can install the
// runtime on first launch instead of failing. The bootstrapper is a small (~2 MB) online installer.
await downloadWebView2Bootstrapper(path.join(portableDir, 'MicrosoftEdgeWebview2Setup.exe'));

await fs.writeFile(
  path.join(portableDir, 'start-gifm.cmd'),
  [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    '".\\GIFM.exe"',
    'pause'
  ].join('\r\n')
);

await run('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${portableDir}' -DestinationPath '${zipPath}' -Force`
]);

console.log(`Portable package: ${portableDir}`);
console.log(`Portable ZIP: ${zipPath}`);

async function copyProductionModules(sourceRoot, targetRoot) {
  // Copy only the resolved production dependency closure (network-free), excluding devDependencies
  // such as playwright/typescript/vite that bloat the released package by ~150 MB.
  const output = execSync('npm ls --omit=dev --all --parseable', { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sourceModules = path.join(sourceRoot, 'node_modules');
  const targetModules = path.join(targetRoot, 'node_modules');
  const seen = new Set();

  for (const line of output.split(/\r?\n/)) {
    const depPath = line.trim();
    if (!depPath || !depPath.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const relative = path.relative(sourceModules, depPath);
    if (relative.startsWith('..') || seen.has(relative)) continue;
    seen.add(relative);
    // Copy the package's own files but skip any nested node_modules (each nested prod dep is listed
    // separately by `npm ls`, so this avoids dragging in dev-only nested trees).
    await fs.cp(depPath, path.join(targetModules, relative), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(depPath, src);
        return !rel.split(path.sep).includes('node_modules');
      }
    });
  }

  // The portable package targets Windows only, so drop ffprobe-static's macOS/Linux binaries (~230 MB).
  for (const platform of ['darwin', 'linux']) {
    await fs.rm(path.join(targetModules, 'ffprobe-static', 'bin', platform), { recursive: true, force: true });
  }
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

async function downloadWebView2Bootstrapper(targetPath) {
  const url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100000) throw new Error(`Unexpectedly small download (${buffer.length} bytes)`);
    await fs.writeFile(targetPath, buffer);
    console.log(`Bundled WebView2 bootstrapper: ${targetPath} (${buffer.length} bytes)`);
  } catch (error) {
    // Non-fatal: the launcher still shows guidance if the runtime is missing and the bootstrapper is absent.
    console.warn(`Warning: could not bundle WebView2 bootstrapper (${error.message}). The package will rely on the user installing WebView2 manually.`);
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await Promise.all(entries.map((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    return fs.cp(sourcePath, targetPath, { recursive: true });
  }));
}
