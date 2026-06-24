#!/usr/bin/env node
// Headless GIFM CLI: drives the same local encode pipeline as the UI by starting the server,
// submitting jobs over its API, and writing the result to disk. Supports single files and a watch folder.
//
// Usage:
//   node scripts/gifm-cli.mjs <input> [--target free] [--format gif] [--width 480] [--fps 15] [--out <dir>]
//   node scripts/gifm-cli.mjs --watch <folder> [--target free] [--out <dir>]
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.watch && !args.input)) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const port = 4100 + Math.floor((Date.now() % 800));
const baseUrl = `http://127.0.0.1:${port}`;
const outDir = path.resolve(args.out ?? process.cwd());
await fs.mkdir(outDir, { recursive: true });

const settings = {
  targetPreset: args.target ?? 'free',
  targetMb: Number(args.targetMb ?? 10),
  width: Number(args.width ?? 480),
  fps: Number(args.fps ?? 15),
  durationSec: Number(args.duration ?? 6),
  startSec: Number(args.start ?? 0),
  format: args.format ?? 'gif',
  autoFit: true
};

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: rootDir,
  env: { ...process.env, GIFM_PORT: String(port) },
  stdio: ['ignore', 'ignore', 'inherit']
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.kill();
};
process.on('SIGINT', () => { stop(); process.exit(130); });

try {
  await waitForHealth();
  if (args.watch) {
    await runWatch(path.resolve(args.watch));
  } else {
    const output = await convert(path.resolve(args.input));
    console.log(output);
  }
} catch (error) {
  console.error(`gifm: ${error instanceof Error ? error.message : String(error)}`);
  stop();
  process.exit(1);
}

if (!args.watch) stop();

async function convert(inputPath) {
  if (!existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const bytes = await fs.readFile(inputPath);
  const form = new FormData();
  form.set('media', new File([bytes], path.basename(inputPath)));
  form.set('settings', JSON.stringify(settings));

  const started = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  if (!started.ok) throw new Error(`Submit failed: ${started.status} ${await started.text()}`);
  let job = await started.json();
  process.stderr.write(`Encoding ${path.basename(inputPath)} -> ${settings.format} (target ${settings.targetPreset})\n`);

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await delay(700);
    job = await (await fetch(`${baseUrl}/api/jobs/${job.id}`)).json();
    if (job.status === 'complete') break;
    if (job.status === 'failed') throw new Error(`Encode failed: ${job.error}`);
    if (job.status === 'cancelled') throw new Error('Encode cancelled');
  }
  if (job.status !== 'complete') throw new Error('Encode timed out');

  const download = await fetch(`${baseUrl}${job.downloadUrl}`);
  const outName = download.headers.get('content-disposition')?.match(/filename="(.+?)"/)?.[1]
    ?? `${path.parse(inputPath).name}-gifm.${settings.format === 'apng' ? 'png' : settings.format}`;
  const outPath = path.join(outDir, outName);
  await fs.writeFile(outPath, Buffer.from(await download.arrayBuffer()));
  return outPath;
}

async function runWatch(folder) {
  if (!existsSync(folder)) throw new Error(`Watch folder not found: ${folder}`);
  const supported = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif']);
  const seen = new Set();
  console.error(`Watching ${folder} (Ctrl+C to stop)...`);
  const scan = async () => {
    const names = await fs.readdir(folder).catch(() => []);
    for (const name of names) {
      const full = path.join(folder, name);
      if (seen.has(full) || !supported.has(path.extname(name).toLowerCase())) continue;
      seen.add(full);
      try {
        const output = await convert(full);
        console.log(`${name} -> ${output}`);
      } catch (error) {
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await scan();
  setInterval(scan, 2000);
  await new Promise(() => {});
}

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = async () => {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return resolve();
      } catch {
        // starting
      }
      if (Date.now() > deadline) return reject(new Error('Server did not start'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function parseArgs(argv) {
  const out = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
      out[key] = value === 'true' ? true : value;
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length && !out.input) out.input = positionals[0];
  if (typeof out.watch === 'string') { /* folder provided */ }
  else if (out.watch === true && positionals.length) out.watch = positionals[0];
  return out;
}

function printUsage() {
  console.log(`GIFM CLI
  node scripts/gifm-cli.mjs <input> [options]
  node scripts/gifm-cli.mjs --watch <folder> [options]

Options:
  --target <preset>   free | nitro-basic | boosted | nitro | emoji | sticker | avatar | custom (default free)
  --format <fmt>      gif | apng | webp | mp4 | avif (default gif)
  --width <px>        output width (default 480)
  --fps <n>           frames per second (default 15)
  --duration <sec>    clip duration (default 6)
  --start <sec>       trim start (default 0)
  --out <dir>         output directory (default current directory)`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
