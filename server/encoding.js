// Pure encoding-strategy, settings, and path helpers shared by the server and unit tests.
// Nothing here touches process state, the filesystem, or child processes, so it is safe to import in tests.
import path from 'node:path';

export const DEFAULT_MAX_TRIM_START_SEC = 24 * 60 * 60;

export const targetProfiles = {
  free: 10,
  'nitro-basic': 50,
  boosted: 100,
  nitro: 500,
  emoji: 256 / 1024,
  sticker: 512 / 1024,
  avatar: 10,
  custom: 10
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
}

export function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function parseFrameRate(raw) {
  if (!raw || raw === '0/0') return null;
  const [numerator, denominator] = String(raw).split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return numerator / denominator;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseLoopCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  if (number <= -1) return -1;
  return clamp(number, 0, 1000);
}

export function normalizeTargetPreset(value) {
  if (value === '10') return 'free';
  if (value === '50') return 'nitro-basic';
  return Object.hasOwn(targetProfiles, value) ? value : 'free';
}

export function dimensionLockForPreset(preset) {
  if (preset === 'emoji') return { square: true, fixedWidth: 128, minWidth: 128, fpsMax: 30 };
  if (preset === 'sticker') return { square: true, fixedWidth: 320, minWidth: 320, fpsMax: 30 };
  if (preset === 'avatar') return { square: true, fixedWidth: 0, minWidth: 128, fpsMax: 30 };
  return { square: false, fixedWidth: 0, minWidth: 120, fpsMax: 30 };
}

// Discord stickers must be APNG, so the sticker preset forces the APNG output format.
export function resolveFormat(rawFormat, preset) {
  if (preset === 'sticker') return 'apng';
  if (rawFormat === 'apng' || rawFormat === 'webp' || rawFormat === 'mp4') return rawFormat;
  return 'gif';
}

export function parseSettings(raw, maxTrimStartSec = DEFAULT_MAX_TRIM_START_SEC) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw && typeof raw === 'object' ? raw : {};
  } catch {
    throw new ApiError(400, 'INVALID_SETTINGS', 'Settings must be valid JSON.');
  }

  const preset = normalizeTargetPreset(parsed.targetPreset);
  const profileTargetMb = targetProfiles[preset] ?? targetProfiles.free;
  const targetMb = preset === 'custom' ? clamp(Number(parsed.targetMb ?? profileTargetMb), 0.05, 500) : profileTargetMb;

  return {
    targetPreset: preset,
    targetMb,
    width: even(clamp(Number(parsed.width ?? 480), 120, 1280)),
    fps: clamp(Number(parsed.fps ?? 15), 5, 30),
    startSec: clamp(Number(parsed.startSec ?? 0), 0, maxTrimStartSec),
    durationSec: clamp(Number(parsed.durationSec ?? 6), 0.5, 60),
    colors: clamp(Number(parsed.colors ?? 96), 16, 256),
    dither: ['sierra2_4a', 'bayer', 'floyd_steinberg', 'none'].includes(parsed.dither) ? parsed.dither : 'sierra2_4a',
    bayerScale: Math.round(clamp(Number(parsed.bayerScale ?? 5), 0, 5)),
    paletteMode: ['diff', 'full', 'single'].includes(parsed.paletteMode) ? parsed.paletteMode : 'diff',
    encoderBackend: parsed.encoderBackend === 'gifski' ? 'gifski' : 'ffmpeg',
    autoFit: Boolean(parsed.autoFit ?? true),
    allowTrim: Boolean(parsed.allowTrim ?? false),
    optimize: Boolean(parsed.optimize ?? true),
    gifskiQuality: Math.round(clamp(Number(parsed.gifskiQuality ?? 90), 1, 100)),
    loopCount: parseLoopCount(parsed.loopCount),
    speed: clamp(Number(parsed.speed ?? 1), 0.25, 8),
    playback: ['normal', 'reverse', 'boomerang'].includes(parsed.playback) ? parsed.playback : 'normal',
    crop: parseCrop(parsed.crop),
    format: resolveFormat(parsed.format, preset),
    caption: parseCaption(parsed.caption),
    overlay: parseOverlay(parsed.overlay),
    rotate: [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0,
    flipH: Boolean(parsed.flipH),
    flipV: Boolean(parsed.flipV),
    colorFilter: ['none', 'grayscale', 'invert', 'sepia'].includes(parsed.colorFilter) ? parsed.colorFilter : 'none',
    saturation: clamp(Number(parsed.saturation ?? 1), 0, 3)
  };
}

export function parseOverlay(value) {
  const raw = value && typeof value === 'object' ? value : {};
  // Only accept a safe id shape (uuid + image extension) to avoid path traversal when resolving the file.
  const id = typeof raw.id === 'string' && /^[a-f0-9-]+\.(png|jpe?g|webp|gif)$/i.test(raw.id) ? raw.id : '';
  const position = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].includes(raw.position) ? raw.position : 'bottom-right';
  return {
    enabled: Boolean(raw.enabled) && Boolean(id),
    id,
    position,
    scale: clamp(Number(raw.scale ?? 0.25), 0.05, 1),
    opacity: clamp(Number(raw.opacity ?? 1), 0.1, 1)
  };
}

export function parseCaption(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const clean = (text) => String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120);
  return { top: clean(raw.top), bottom: clean(raw.bottom) };
}

export function parseCrop(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const x = clamp(Number(raw.x ?? 0), 0, 0.95);
  const y = clamp(Number(raw.y ?? 0), 0, 0.95);
  const w = clamp(Number(raw.w ?? 1), 0.05, 1 - x);
  const h = clamp(Number(raw.h ?? 1), 0.05, 1 - y);
  const enabled = Boolean(raw.enabled) && (x > 0 || y > 0 || w < 1 || h < 1);
  return { enabled, x, y, w, h };
}

export function nextAttempt({ width, fps, colors, dedupeFrames, frameDropModulo, gifsicleLossy = 0, allowLossy = false, durationSec, outputBytes, targetBytes, allowTrim, minWidth = 120 }) {
  const overRatio = outputBytes / targetBytes;
  // GIF size scales ~quadratically with width, so a sqrt step lands near the target in one pass.
  // Allow a deeper cut when the output is far over target so far-over inputs converge in fewer encodes.
  const minScale = overRatio > 3 ? 0.5 : 0.68;
  const scale = clamp(Math.sqrt(targetBytes / outputBytes) * 0.94, minScale, 0.9);
  let nextWidth = even(Math.max(minWidth, width * scale));
  let nextFps = fps;
  let nextColors = colors;
  let nextDedupeFrames = dedupeFrames;
  let nextFrameDropModulo = frameDropModulo;
  let nextGifsicleLossy = gifsicleLossy;
  let nextDuration = durationSec;

  if (nextWidth >= width - 8) {
    nextWidth = width;
    if (nextFps > 6) {
      // Size scales roughly linearly with frame rate; predict the fps that lands near the target,
      // guaranteeing at least a one-step reduction so the loop always makes progress.
      const predicted = Math.round(nextFps * clamp(targetBytes / outputBytes, 0.45, 0.85));
      nextFps = Math.max(6, Math.min(nextFps - 1, predicted));
    } else if (nextColors > 32) {
      nextColors = Math.max(32, nextColors - (overRatio > 1.6 ? 32 : 16));
    } else if (allowLossy && nextGifsicleLossy < 160) {
      // Lossy LZW compression preserves motion, so prefer it over dropping or trimming frames.
      nextGifsicleLossy = nextGifsicleLossy === 0 ? 40 : Math.min(160, nextGifsicleLossy + 40);
    } else if (!nextDedupeFrames) {
      nextDedupeFrames = true;
    } else if (nextFrameDropModulo === 0) {
      nextFrameDropModulo = 5;
    } else if (nextFrameDropModulo > 3) {
      nextFrameDropModulo -= 1;
    } else if (allowTrim && nextDuration > 1) {
      nextDuration = Math.max(1, nextDuration * scale);
    } else {
      return null;
    }
  } else if (overRatio > 1.25 && nextColors > 64) {
    nextColors = Math.max(64, nextColors - 16);
  }

  if (
    nextWidth === width &&
    nextFps === fps &&
    nextColors === colors &&
    nextDedupeFrames === dedupeFrames &&
    nextFrameDropModulo === frameDropModulo &&
    nextGifsicleLossy === gifsicleLossy &&
    Math.abs(nextDuration - durationSec) < 0.05
  ) {
    return null;
  }

  return {
    width: nextWidth,
    fps: Math.round(nextFps),
    colors: Math.round(nextColors),
    dedupeFrames: nextDedupeFrames,
    frameDropModulo: nextFrameDropModulo,
    gifsicleLossy: nextGifsicleLossy,
    durationSec: Number(nextDuration.toFixed(2))
  };
}

export function isProtectedPath(entryPath, protectedPaths) {
  const resolved = path.resolve(entryPath);
  for (const protectedPath of protectedPaths) {
    if (resolved === protectedPath) return true;
    if (protectedPath.startsWith(`${resolved}${path.sep}`)) return true;
    if (resolved.startsWith(`${protectedPath}${path.sep}`)) return true;
  }
  return false;
}
