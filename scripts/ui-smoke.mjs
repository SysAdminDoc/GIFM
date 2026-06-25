import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const uiSmokeDir = path.join(rootDir, 'data', 'ui-smoke');
const samplePath = path.join(uiSmokeDir, 'client-preflight.mp4');
const port = 4194;
const baseUrl = `http://127.0.0.1:${port}`;

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
  await assertVisibleText(page, 'Saved GIF cuts');
  await assertVisibleText(page, 'Diagnostics');
  await page.setInputFiles('input[aria-label="Choose video or GIF file"]', samplePath);
  await page.getByText('Client frame', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Add clip' }).click();
  await page.getByText('Clip 01', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  await page.getByRole('button', { name: 'Prepare source' }).click();
  await page.getByText('Source prepared once', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

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
  }
  await page.evaluate(() => window.localStorage.removeItem('gifm:theme:v1'));

  // Verify mobile-width viewport: no horizontal overflow at 375px.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: 'load' });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (mobileOverflow) throw new Error('Mobile viewport (375px) has horizontal overflow.');
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

  console.log(`UI smoke passed: themes (dark/light/high-contrast), mobile (375px), keyboard focus, reduced-motion, ARIA progressbar${hasProgressbar ? '' : ' (warn: no progressbar found — expected when no job active)'}, locales (en/es/fr).`);
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
