#!/usr/bin/env node
// Headless GIFM CLI: drives the same local encode pipeline as the UI by starting the server,
// submitting jobs over its API, and writing the result to disk. Supports single files and a watch folder.
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

let presetOverrides = {};
if (args.preset) {
  const presetPath = path.resolve(args.preset);
  if (!existsSync(presetPath)) {
    console.error(`gifm: preset file not found: ${presetPath}`);
    process.exit(1);
  }
  try {
    presetOverrides = JSON.parse(await fs.readFile(presetPath, 'utf-8'));
  } catch {
    console.error(`gifm: preset file is not valid JSON: ${presetPath}`);
    process.exit(1);
  }
}

const settings = {
  targetPreset: args.target ?? 'free',
  targetMb: Number(args.targetMb ?? 10),
  width: Number(args.width ?? 480),
  fps: Number(args.fps ?? 15),
  durationSec: Number(args.duration ?? 6),
  startSec: Number(args.start ?? 0),
  format: args.format ?? 'gif',
  autoFit: args.noAutoFit ? false : true,
  colors: Number(args.colors ?? 96),
  dither: args.dither ?? 'sierra2_4a',
  bayerScale: Number(args.bayerScale ?? 5),
  paletteMode: args.paletteMode ?? 'diff',
  perFramePalette: Boolean(args.perFramePalette),
  loopCount: args.loop !== undefined ? Number(args.loop) : 0,
  speed: Number(args.speed ?? 1),
  playback: args.playback ?? 'normal',
  optimize: args.noOptimize ? false : true,
  gifskiQuality: Number(args.gifskiQuality ?? 90),
  encoderBackend: args.encoder ?? 'ffmpeg',
  rotate: Number(args.rotate ?? 0),
  flipH: Boolean(args.flipH),
  flipV: Boolean(args.flipV),
  colorFilter: args.colorFilter ?? 'none',
  saturation: Number(args.saturation ?? 1),
  allowTrim: Boolean(args.allowTrim),
  crop: args.cropX !== undefined ? {
    enabled: true,
    x: Number(args.cropX ?? 0),
    y: Number(args.cropY ?? 0),
    w: Number(args.cropW ?? 1),
    h: Number(args.cropH ?? 1)
  } : undefined,
  caption: args.captionTop || args.captionBottom ? {
    top: args.captionTop ?? '',
    bottom: args.captionBottom ?? ''
  } : undefined,
  overlay: args.overlayId ? {
    enabled: true,
    id: args.overlayId,
    position: args.overlayPosition ?? 'bottom-right',
    scale: Number(args.overlayScale ?? 0.25),
    opacity: Number(args.overlayOpacity ?? 1)
  } : undefined,
  ...presetOverrides
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
process.on('SIGTERM', () => { stop(); process.exit(143); });
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { stop(); process.exit(149); });
}

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
      try {
        const stat = await fs.stat(full);
        if (Date.now() - stat.mtimeMs < 2000) continue;
        const before = stat.size;
        await delay(1500);
        const after = (await fs.stat(full).catch(() => null))?.size;
        if (after === undefined || after !== before) continue;
      } catch {
        continue;
      }
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
      const key = toCamelCase(arg.slice(2));
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

function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printUsage() {
  console.log(`GIFM CLI
  node scripts/gifm-cli.mjs <input> [options]
  node scripts/gifm-cli.mjs --watch <folder> [options]

Options:
  --target <preset>       free | nitro-basic | boosted | nitro | emoji | sticker | avatar | custom (default free)
  --target-mb <n>         custom target in MB (default 10)
  --format <fmt>          gif | apng | webp | mp4 | avif (default gif)
  --width <px>            output width (default 480)
  --fps <n>               frames per second (default 15)
  --duration <sec>        clip duration (default 6)
  --start <sec>           trim start (default 0)
  --colors <n>            palette colors 16-256 (default 96)
  --dither <mode>         sierra2_4a | bayer | floyd_steinberg | none (default sierra2_4a)
  --bayer-scale <0-5>     bayer dithering scale (default 5)
  --palette-mode <mode>   diff | full | single (default diff)
  --per-frame-palette     enable per-frame palette generation
  --loop <n>              loop count: 0=infinite, -1=once, n=repeat n times (default 0)
  --speed <n>             playback speed 0.25-8 (default 1)
  --playback <mode>       normal | reverse | boomerang (default normal)
  --no-optimize           disable gifsicle optimization
  --no-auto-fit           disable iterative size fitting
  --allow-trim            allow duration trimming as an auto-fit lever
  --encoder <backend>     ffmpeg | gifski (default ffmpeg)
  --gifski-quality <n>    gifski quality 1-100 (default 90)
  --rotate <deg>          0 | 90 | 180 | 270 (default 0)
  --flip-h                horizontal flip
  --flip-v                vertical flip
  --color-filter <name>   none | grayscale | invert | sepia (default none)
  --saturation <n>        saturation 0-3 (default 1)
  --crop-x <0-1>          crop region left (fractional)
  --crop-y <0-1>          crop region top (fractional)
  --crop-w <0-1>          crop region width (fractional)
  --crop-h <0-1>          crop region height (fractional)
  --caption-top <text>    top caption text
  --caption-bottom <text> bottom caption text
  --overlay-id <id>       overlay image id (from /api/overlay upload)
  --preset <file>         JSON file with settings overrides
  --out <dir>             output directory (default current directory)
  --watch <folder>        auto-convert new files in folder`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
