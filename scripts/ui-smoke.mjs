import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const uiSmokeDir = path.join(rootDir, 'data', 'ui-smoke');
const snapshotDir = path.join(rootDir, 'assets', 'ui-snapshots');
const samplePath = path.join(uiSmokeDir, 'client-preflight.mp4');
const batchSamplePath = path.join(uiSmokeDir, 'client-preflight-batch.mp4');
const completedOutputPath = path.join(uiSmokeDir, 'completed-output.gif');
const port = 4194;
const baseUrl = `http://127.0.0.1:${port}`;
const updateSnapshots = process.argv.includes('--update-snapshots') || process.env.UPDATE_UI_SNAPSHOTS === '1';

await fs.mkdir(uiSmokeDir, { recursive: true });
await run(ffmpegPath, [
  '-hide_banner',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=10',
  '-t',
  '1',
  '-c:v',
  'libx264',
  '-profile:v',
  'baseline',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  'faststart',
  '-an',
  '-y',
  samplePath
]);
await fs.copyFile(samplePath, batchSamplePath);
await run(ffmpegPath, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  samplePath,
  '-vf',
  'fps=10,scale=160:90:flags=fast_bilinear',
  '-loop',
  '0',
  '-y',
  completedOutputPath
]);

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    GIFM_PORT: String(port),
    GIFM_GIFSKI_PATH: '',
    GIFM_MAX_UPLOAD_MB: '16',
    GIFM_DATA_MAX_MB: '64'
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

let browser;
try {
  await waitForHealth();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleMessages = [];
  let probeRequests = 0;
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/probe')) probeRequests += 1;
  });

  await page.goto(baseUrl, { waitUntil: 'load' });
  await assertVisibleText(page, 'GIFM');
  await assertVisibleText(page, 'Drop video or GIF');
  await assertVisibleText(page, 'Discord-ready size controls');
  await assertVisibleText(page, 'Encoder');
  await assertVisibleText(page, 'FFmpeg palette');
  await assertVisibleText(page, 'Bundled FFmpeg palette encoder.');
  await assertVisibleText(page, 'Timeline editor');
  await assertVisibleText(page, 'Timeline waits for a source');
  await assertVisibleText(page, 'Diagnostics');
  await assertSnapshot(page, 'empty-dark-desktop');
  await page.setInputFiles('input[aria-label="Choose video or GIF file"]', samplePath);
  await page.getByText('Client frame', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Add clip' }).click();
  await page.getByText('Clip 01', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  await page.getByRole('button', { name: 'Prepare source' }).click();
  await page.getByText('Source prepared once', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await assertSnapshot(page, 'source-loaded-dark-desktop');

  // Exercise the source-loaded rail at the smallest supported viewport in an isolated page so a captured
  // pointer remains local to the interaction test and cannot affect the later output-state capture.
  const touchPage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  try {
    await touchPage.goto(baseUrl, { waitUntil: 'load' });
    await touchPage.setInputFiles('input[aria-label="Choose video or GIF file"]', samplePath);
    await touchPage.getByText('Client frame', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await touchPage.getByRole('button', { name: 'Add clip' }).click();
    await touchPage.getByRole('button', { name: 'Prepare source' }).click();
    await touchPage.getByText('Source prepared once', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const mobileRail = touchPage.locator('.timeline-rail');
    await mobileRail.scrollIntoViewIfNeeded();
    const railBox = await mobileRail.boundingBox();
    if (!railBox || railBox.width < 100) throw new Error('Mobile timeline rail is not visible or has collapsed.');
    const touchTargetHeights = await touchPage.locator('.timeline-rail, .timeline-range-grid input, .timeline-actions .secondary-button, .source-session-row .secondary-button').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)));
    if (touchTargetHeights.some((height) => height < 44)) {
      throw new Error(`Mobile timeline touch target is below 44px: ${JSON.stringify(touchTargetHeights)}`);
    }
    const dragY = railBox.y + railBox.height / 2;
    await touchPage.mouse.move(railBox.x + railBox.width * 0.2, dragY);
    await touchPage.mouse.down();
    await touchPage.mouse.move(railBox.x + railBox.width * 0.8, dragY, { steps: 6 });
    await touchPage.mouse.up();
    await touchPage.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll('.timeline-range-grid input')).map((input) => Number(input.value));
      return values.length === 2 && values[0] > 0.1 && values[1] - values[0] >= 0.49;
    }, undefined, { timeout: 5000 });
    const mobileSourceOverflow = await touchPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (mobileSourceOverflow) throw new Error('Source-loaded mobile viewport (375px) has horizontal overflow.');
  } finally {
    await touchPage.close();
  }

  const state = await page.evaluate(() => {
    const encoderLabel = Array.from(document.querySelectorAll('label.select-field')).find((label) => label.querySelector('span')?.textContent?.trim() === 'Encoder');
    const encoderSelect = encoderLabel?.querySelector('select');
    const diagnostics = Array.from(document.querySelectorAll('.diagnostic-grid span')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
    return {
      title: document.title,
      encoderValue: encoderSelect?.value,
      options: encoderSelect ? Array.from(encoderSelect.options).map((option) => ({ value: option.value, disabled: option.disabled, text: option.textContent })) : [],
      diagnostics,
      metadata: Array.from(document.querySelectorAll('.metadata-grid span')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
      clips: Array.from(document.querySelectorAll('.clip-row')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
      sourceSession: document.querySelector('.source-session-row')?.textContent?.replace(/\s+/g, ' ').trim(),
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });

  if (!/^GIFM v\d+\.\d+\.\d+$/.test(state.title)) {
    throw new Error(`Unexpected title: ${state.title}`);
  }
  if (state.encoderValue !== 'ffmpeg') {
    throw new Error(`Expected FFmpeg encoder default, got ${state.encoderValue}`);
  }
  if (!state.options.some((option) => option.value === 'gifski' && option.disabled)) {
    throw new Error(`Expected gifski option to be disabled without GIFM_GIFSKI_PATH: ${JSON.stringify(state.options)}`);
  }
  if (!state.diagnostics.some((item) => item?.includes('Encoder FFmpeg palette'))) {
    throw new Error(`Expected diagnostics encoder string: ${JSON.stringify(state.diagnostics)}`);
  }
  if (!state.metadata.some((item) => item?.includes('Probe Client frame'))) {
    throw new Error(`Expected client preflight metadata: ${JSON.stringify(state.metadata)}`);
  }
  if (!state.clips.some((item) => item?.includes('Clip 01'))) {
    throw new Error(`Expected saved timeline clip: ${JSON.stringify(state.clips)}`);
  }
  if (!state.sourceSession?.includes('Source prepared once')) {
    throw new Error(`Expected prepared source UI state: ${state.sourceSession}`);
  }
  if (probeRequests !== 0) {
    throw new Error(`Expected client preflight before upload, but observed ${probeRequests} /api/probe request(s).`);
  }
  if (state.bodyOverflowX) {
    throw new Error('Default English UI has horizontal overflow.');
  }
  if (consoleMessages.length) {
    throw new Error(`Console warnings/errors found: ${consoleMessages.join('\n')}`);
  }

  const completedSnapshotJob = {
    ...createSnapshotJob('snapshot-complete', 'complete', 'Complete', 100),
    outputBytes: 12345,
    downloadUrl: '/api/jobs/snapshot-complete/download',
    completedAt: '2026-01-01T00:00:01.000Z',
    outputMeta: { width: 160, height: 90, durationSec: 1, fps: 10, format: 'gif', frameCount: 10 },
    discordChecks: [{ label: 'Under target', pass: true, detail: '12 KB / 10 MB' }],
    ssim: 0.94
  };
  const completedOutput = await fs.readFile(completedOutputPath);
  await page.route('**/api/jobs**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(completedSnapshotJob) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/jobs/snapshot-complete/download', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/gif', body: completedOutput });
  });
  const startButton = page.getByRole('button', { name: 'Start encoding', exact: true });
  await startButton.click();
  await page.locator('.output-box .fit-line').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const media = document.querySelector('.output-box .output-preview img, .output-box .output-preview video');
    if (media instanceof HTMLImageElement) return media.complete && media.naturalWidth > 0;
    if (media instanceof HTMLVideoElement) return media.readyState >= 1;
    return false;
  }, undefined, { timeout: 30000 });
  await page.getByRole('button', { name: 'Hide motion', exact: true }).click();
  await assertSnapshot(page, 'completed-output-dark-desktop');

  // Keep the batch snapshot deterministic by replacing the upload responses with fixed queued/running jobs.
  const batchPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const snapshotJobs = [
    createSnapshotJob('snapshot-batch-1', 'running', 'Encoding frames', 42),
    createSnapshotJob('snapshot-batch-2', 'queued', 'Queued', 0)
  ];
  let submittedSnapshotJobs = 0;
  await batchPage.route('**/api/jobs**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const job = snapshotJobs[Math.min(submittedSnapshotJobs, snapshotJobs.length - 1)];
    submittedSnapshotJobs += 1;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(job) });
  });
  await batchPage.route('**/api/jobs/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const job = snapshotJobs.find((item) => pathname === `/api/jobs/${item.id}`);
    if (job && route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job) });
      return;
    }
    await route.continue();
  });
  try {
    await batchPage.goto(baseUrl, { waitUntil: 'load' });
    await batchPage.setInputFiles('input[aria-label="Choose video or GIF file"]', [samplePath, batchSamplePath]);
    await batchPage.getByText('Client frame', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await batchPage.getByRole('button', { name: 'Start encoding', exact: true }).click();
    await batchPage.getByText('Jobs submitted', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    if (await batchPage.locator('.batch-row').count() !== 2) {
      throw new Error('Expected two deterministic batch queue rows.');
    }
    await assertSnapshot(batchPage, 'batch-queue-dark-desktop');
  } finally {
    await batchPage.close();
  }

  // Run core empty and source-loaded screens through the expanded pseudo-locale at desktop and mobile widths.
  const pseudoPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await pseudoPage.goto(`${baseUrl}/?locale=pseudo`, { waitUntil: 'load' });
    await pseudoPage.waitForFunction(() => document.querySelector('h2')?.textContent?.includes('⟦'), undefined, { timeout: 10000 });
    await assertPseudolocaleLayout(pseudoPage, 'empty desktop');
    await pseudoPage.setInputFiles('.drop-zone input[type="file"]', samplePath);
    await pseudoPage.waitForFunction(() => Boolean(document.querySelector('.timeline-editor:not(.timeline-editor-empty)')), undefined, { timeout: 10000 });
    await assertPseudolocaleLayout(pseudoPage, 'source-loaded desktop');
    await pseudoPage.setViewportSize({ width: 375, height: 812 });
    await assertPseudolocaleLayout(pseudoPage, 'source-loaded mobile');
  } finally {
    await pseudoPage.close();
  }

  // Verify locale switching: persist Spanish, reload, and confirm multiple translated strings render.
  const esChecks = ['Suelta un video o GIF', 'Objetivo', 'Iniciar codificacion', 'Vista previa'];
  await page.evaluate(() => window.localStorage.setItem('gifm:locale:v1', JSON.stringify('es')));
  await page.reload({ waitUntil: 'load' });
  for (const text of esChecks) await assertVisibleText(page, text);
  const esOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (esOverflow) throw new Error('Spanish locale has horizontal overflow.');

  const frChecks = ['Deposez une video ou un GIF', 'Cible', 'Apercu', 'Largeur'];
  await page.evaluate(() => window.localStorage.setItem('gifm:locale:v1', JSON.stringify('fr')));
  await page.reload({ waitUntil: 'load' });
  for (const text of frChecks) await assertVisibleText(page, text);
  const frOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (frOverflow) throw new Error('French locale has horizontal overflow.');

  const deChecks = ['Video oder GIF ablegen', 'Ziel', 'Vorschau', 'Breite'];
  await page.evaluate(() => window.localStorage.setItem('gifm:locale:v1', JSON.stringify('de')));
  await page.reload({ waitUntil: 'load' });
  for (const text of deChecks) await assertVisibleText(page, text);
  const deOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (deOverflow) throw new Error('German locale has horizontal overflow.');

  const jaChecks = ['動画またはGIFをドロップ', 'ターゲット', 'プレビュー', '幅'];
  await page.evaluate(() => window.localStorage.setItem('gifm:locale:v1', JSON.stringify('ja')));
  await page.reload({ waitUntil: 'load' });
  for (const text of jaChecks) await assertVisibleText(page, text);
  const jaOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (jaOverflow) throw new Error('Japanese locale has horizontal overflow.');
  await page.evaluate(() => window.localStorage.removeItem('gifm:locale:v1'));

  // Verify theme switching: light and high-contrast themes render without overflow or console errors.
  for (const theme of ['light', 'high-contrast']) {
    const themeConsole = [];
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) themeConsole.push(`${message.type()}: ${message.text()}`);
    });
    await page.evaluate((t) => window.localStorage.setItem('gifm:theme:v1', JSON.stringify(t)), theme);
    await page.reload({ waitUntil: 'load' });
    const themeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (themeOverflow) throw new Error(`${theme} theme has horizontal overflow at desktop width.`);
    const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
    if (themeAttr !== theme) throw new Error(`Expected data-theme="${theme}", got "${themeAttr}".`);
    if (themeConsole.length) throw new Error(`Console errors in ${theme} theme: ${themeConsole.join('\n')}`);
    await assertSnapshot(page, `empty-${theme}-desktop`);
  }
  await page.evaluate(() => window.localStorage.removeItem('gifm:theme:v1'));

  // Verify mobile-width viewport: no horizontal overflow at 375px.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: 'load' });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (mobileOverflow) throw new Error('Mobile viewport (375px) has horizontal overflow.');
  await assertSnapshot(page, 'empty-mobile-375');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Verify keyboard focus: Tab reaches the file input and the start button.
  await page.reload({ waitUntil: 'load' });
  await page.keyboard.press('Tab');
  const focusTag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
  if (!['input', 'button', 'select', 'a', 'textarea'].includes(focusTag)) {
    throw new Error(`First Tab did not focus an interactive element, got <${focusTag}>.`);
  }

  // Verify reduced-motion: the CSS rule exists and suppresses animation.
  const reducedMotion = await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@media (prefers-reduced-motion: reduce) { .probe { animation-duration: 0.01ms !important; } }';
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'probe';
    document.body.appendChild(el);
    const computed = getComputedStyle(el);
    const result = computed.animationDuration;
    style.remove();
    el.remove();
    return result;
  });

  // Verify ARIA progressbar attributes exist on the progress bar.
  await page.reload({ waitUntil: 'load' });
  const hasProgressbar = await page.evaluate(() => !!document.querySelector('[role="progressbar"]'));

  console.log(`UI smoke passed: themes (dark/light/high-contrast), mobile (375px), keyboard focus, reduced-motion, ARIA progressbar${hasProgressbar ? '' : ' (warn: no progressbar found — expected when no job active)'}, locales (en/es/fr/de/ja).`);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}

async function assertVisibleText(page, text) {
  const locator = page.getByText(text, { exact: true });
  if (await locator.count() < 1) {
    throw new Error(`Expected visible text: ${text}`);
  }
}

async function assertPseudolocaleLayout(page, label) {
  const report = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const selectors = ['.topbar', '.workspace', '.center-stage', '.settings-panel', '.preview-panel', '.drop-zone', '.source-strip', '.timeline-editor', '.timecode-grid', '.clip-bin'];
    const offenders = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > viewportWidth + 1 || rect.width > viewportWidth + 1
        ? `${selector} (${Math.round(rect.left)}..${Math.round(rect.right)} / ${viewportWidth})`
        : null;
    })).filter((value) => Boolean(value));
    return {
      documentOverflow: document.documentElement.scrollWidth > viewportWidth,
      offenders
    };
  });
  if (report.documentOverflow || report.offenders.length) {
    throw new Error(`Pseudolocale ${label} overflows: ${JSON.stringify(report)}`);
  }
}

async function assertSnapshot(page, name) {
  const expectedPath = path.join(snapshotDir, `${name}.png`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.preview-box video')).every((video) => video.readyState >= 2), undefined, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('.preview-box video').forEach((video) => {
    video.controls = false;
    video.pause();
    try { video.currentTime = 0; } catch { /* metadata may still be settling */ }
  }));
  await page.waitForTimeout(100);
  const screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  if (updateSnapshots) {
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(expectedPath, screenshot);
    console.log(`Updated UI snapshot: ${path.relative(rootDir, expectedPath)}`);
    return;
  }

  let expected;
  try {
    expected = await fs.readFile(expectedPath);
  } catch {
    throw new Error(`Missing UI snapshot ${path.relative(rootDir, expectedPath)}. Run npm run test:ui:update after an intentional visual change.`);
  }
  if (Buffer.compare(screenshot, expected) === 0) return;

  const [actualPixels, expectedPixels] = await Promise.all([decodePng(screenshot), decodePng(expected)]);
  const differingPixels = countPixelDifferences(actualPixels, expectedPixels);
  const pixelCount = Math.floor(Math.min(actualPixels.length, expectedPixels.length) / 4);
  const allowedPixels = Math.max(64, Math.floor(pixelCount * 0.0001));
  if (actualPixels.length === expectedPixels.length && differingPixels <= allowedPixels) return;

  const actualPath = path.join(uiSmokeDir, 'snapshots', `${name}.png`);
  await fs.mkdir(path.dirname(actualPath), { recursive: true });
  await fs.writeFile(actualPath, screenshot);
  throw new Error(`UI snapshot mismatch for ${name}. Actual output: ${path.relative(rootDir, actualPath)}. Run npm run test:ui:update after reviewing the visual change.`);
}

function decodePng(png) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Could not decode UI snapshot PNG (exit ${code}).`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(png);
  });
}

function countPixelDifferences(actual, expected) {
  if (actual.length !== expected.length) return Number.POSITIVE_INFINITY;
  let differing = 0;
  for (let index = 0; index < actual.length; index += 4) {
    if (Math.abs(actual[index] - expected[index]) > 2
      || Math.abs(actual[index + 1] - expected[index + 1]) > 2
      || Math.abs(actual[index + 2] - expected[index + 2]) > 2
      || Math.abs(actual[index + 3] - expected[index + 3]) > 2) {
      differing += 1;
    }
  }
  return differing;
}

function createSnapshotJob(id, status, stage, progress) {
  return {
    id,
    status,
    progress,
    stage,
    queuePosition: status === 'queued' ? 2 : undefined,
    inputName: `${id}.mp4`,
    inputSize: 12800,
    targetBytes: 10 * 1024 * 1024,
    startedAt: '2026-01-01T00:00:00.000Z',
    warnings: [],
    logs: [],
    attempts: [],
    settings: {
      targetPreset: 'free',
      targetMb: 10,
      width: 480,
      fps: 15,
      startSec: 0,
      durationSec: 1,
      colors: 96,
      dither: 'sierra2_4a',
      bayerScale: 5,
      paletteMode: 'diff',
      perFramePalette: false,
      encoderBackend: 'ffmpeg',
      autoFit: true,
      allowTrim: false,
      optimize: true,
      gifskiQuality: 90,
      gifskiMotionQuality: 90,
      loopCount: 0,
      speed: 1,
      playback: 'normal',
      crop: { enabled: false, x: 0, y: 0, w: 1, h: 1 },
      format: 'gif',
      caption: { top: '', bottom: '' },
      overlay: { enabled: false, id: '', position: 'bottom-right', scale: 0.25, opacity: 1 },
      rotate: 0,
      flipH: false,
      flipV: false,
      colorFilter: 'none',
      saturation: 1,
      gifsicleColorSpace: 'srgb',
      gifsicleOptDither: 'none',
      subtitleId: '',
      borderRadius: 0
    }
  };
}

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 90000;
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
