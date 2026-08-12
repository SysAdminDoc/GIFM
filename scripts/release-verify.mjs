import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
const releaseRoot = path.join(rootDir, 'release');
const packageName = `GIFM-v${packageJson.version}-win-x64`;
const portableDir = path.join(releaseRoot, packageName);
const zipPath = `${portableDir}.zip`;
const bootstrapperPath = path.join(portableDir, 'MicrosoftEdgeWebview2Setup.exe');
const manifestPath = path.join(releaseRoot, `GIFM-v${packageJson.version}-release-manifest.json`);
const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
const vitePath = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

const steps = [
  { name: 'production audit', ...npmStep(['audit', '--omit=dev']) },
  { name: 'production dependency freshness', task: assertProductionFreshness },
  { name: 'typecheck', task: typecheck },
  { name: 'build', task: build },
  { name: 'unit tests', task: unitTests },
  { name: 'translation fallback audit', command: process.execPath, args: [path.join(rootDir, 'scripts', 'check-translations.mjs')] },
  { name: 'API smoke tests', command: process.execPath, args: [path.join(rootDir, 'scripts', 'smoke.mjs')] },
  { name: 'UI smoke tests', task: uiSmoke },
  { name: 'portable package', task: portablePackage },
  { name: 'portable package smoke', command: process.execPath, args: [path.join(rootDir, 'scripts', 'package-smoke.mjs')] }
];

const completedSteps = [];

await fs.rm(manifestPath, { force: true });

for (const step of steps) {
  const startedAt = new Date().toISOString();
  console.log(`\n==> ${step.name}`);
  if (step.task) {
    await step.task();
  } else {
    await run(step.command, step.args, step.shell);
  }
  completedSteps.push({ name: step.name, startedAt, completedAt: new Date().toISOString() });
}

await writeReleaseManifest();
console.log(`\nRelease verification passed. Manifest: ${manifestPath}`);

async function assertProductionFreshness() {
  const { code, stdout, stderr } = await capture(...captureNpmArgs(['outdated', '--omit=dev', '--json']));
  if (![0, 1].includes(code)) {
    throw new Error(stderr || `npm outdated exited with ${code}`);
  }

  const report = stdout.trim() ? JSON.parse(stdout) : {};
  const stale = Object.entries(report)
    .filter(([, info]) => info.current && info.wanted && info.current !== info.wanted)
    .map(([name, info]) => `${name} ${info.current} -> ${info.wanted}`);

  if (stale.length > 0) {
    throw new Error(`Production dependencies are behind declared ranges:\n${stale.join('\n')}`);
  }

  console.log('Production dependencies match declared semver ranges.');
}

async function typecheck() {
  await run(process.execPath, [tscPath, '--noEmit', '-p', 'tsconfig.json']);
  await run(process.execPath, [tscPath, '--noEmit', '-p', 'tsconfig.node.json']);
}

async function build() {
  await typecheck();
  await run(process.execPath, [vitePath, 'build']);
}

async function unitTests() {
  const serverDir = path.join(rootDir, 'server');
  const entries = await fs.readdir(serverDir);
  const tests = entries
    .filter((entry) => entry.endsWith('.test.js'))
    .sort()
    .map((entry) => path.join(serverDir, entry));
  await run(process.execPath, ['--test', ...tests]);
}

async function uiSmoke() {
  await build();
  await run(process.execPath, [path.join(rootDir, 'scripts', 'ui-smoke.mjs')]);
}

async function portablePackage() {
  await build();
  await run(process.execPath, [path.join(rootDir, 'scripts', 'package-portable.mjs')]);
}

async function writeReleaseManifest() {
  const files = [
    { role: 'portable-zip', filePath: zipPath },
    { role: 'webview2-bootstrapper', filePath: bootstrapperPath }
  ];

  const manifestFiles = [];
  for (const file of files) {
    const stat = await fs.stat(file.filePath);
    manifestFiles.push({
      role: file.role,
      path: toManifestPath(file.filePath),
      bytes: stat.size,
      sha256: await sha256File(file.filePath)
    });
  }

  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      name: 'GIFM',
      version: packageJson.version,
      packageName,
      generatedAt: new Date().toISOString(),
      command: 'npm run release:verify',
      steps: completedSteps,
      files: manifestFiles
    }, null, 2)}\n`
  );
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const file = await fs.open(filePath, 'r');
  try {
    for await (const chunk of file.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

function toManifestPath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function npmStep(args) {
  if (process.platform !== 'win32') return { command: 'npm', args };
  return { command: ['npm', ...args].map(quoteCmdArg).join(' '), args: [], shell: true };
}

function captureNpmArgs(args) {
  const step = npmStep(args);
  return [step.command, step.args, step.shell];
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replace(/(["^&|<>%])/g, '^$1')}"`;
}

function run(command, args, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', shell, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function capture(command, args, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, shell, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
