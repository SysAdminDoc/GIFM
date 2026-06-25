import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ApiError,
  clamp,
  even,
  formatBytes,
  parseFrameRate,
  parseLoopCount,
  normalizeTargetPreset,
  dimensionLockForPreset,
  parseSettings,
  parseCrop,
  parseCaption,
  parseOverlay,
  resolveFormat,
  nextAttempt,
  isProtectedPath,
  exceedsFrameBudget,
  discordTargetChecks
} from './encoding.js';

test('clamp bounds values and coerces non-finite to min', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 4, 10), 4);
});

test('even rounds to the nearest even number with a floor of 2', () => {
  assert.equal(even(481), 482);
  assert.equal(even(480.4), 480);
  assert.equal(even(1), 2);
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
});

test('parseFrameRate handles fractions, zero, and plain numbers', () => {
  assert.equal(parseFrameRate('30/1'), 30);
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(parseFrameRate('25'), 25);
  assert.equal(parseFrameRate(undefined), null);
});

test('parseLoopCount maps to the canonical loop convention', () => {
  assert.equal(parseLoopCount(0), 0);
  assert.equal(parseLoopCount(-1), -1);
  assert.equal(parseLoopCount(-9), -1);
  assert.equal(parseLoopCount(5), 5);
  assert.equal(parseLoopCount(99999), 1000);
  assert.equal(parseLoopCount('not-a-number'), 0);
});

test('normalizeTargetPreset accepts legacy and known presets', () => {
  assert.equal(normalizeTargetPreset('10'), 'free');
  assert.equal(normalizeTargetPreset('50'), 'nitro-basic');
  assert.equal(normalizeTargetPreset('emoji'), 'emoji');
  assert.equal(normalizeTargetPreset('mystery'), 'free');
});

test('dimensionLockForPreset locks emoji, sticker, and avatar to square output', () => {
  assert.deepEqual(dimensionLockForPreset('emoji'), { square: true, fixedWidth: 128, minWidth: 128, fpsMax: 30 });
  assert.deepEqual(dimensionLockForPreset('sticker'), { square: true, fixedWidth: 320, minWidth: 320, fpsMax: 30 });
  assert.deepEqual(dimensionLockForPreset('avatar'), { square: true, fixedWidth: 0, minWidth: 128, fpsMax: 30 });
  assert.deepEqual(dimensionLockForPreset('free'), { square: false, fixedWidth: 0, minWidth: 120, fpsMax: 30 });
});

test('resolveFormat forces APNG for stickers and otherwise honours the requested format', () => {
  assert.equal(resolveFormat('gif', 'sticker'), 'apng');
  assert.equal(resolveFormat('apng', 'sticker'), 'apng');
  assert.equal(resolveFormat('apng', 'free'), 'apng');
  assert.equal(resolveFormat('gif', 'free'), 'gif');
  assert.equal(resolveFormat(undefined, 'free'), 'gif');
});

test('parseSettings derives the sticker format and target', () => {
  const sticker = parseSettings({ targetPreset: 'sticker' });
  assert.equal(sticker.format, 'apng');
  assert.equal(sticker.targetPreset, 'sticker');
  assert.ok(Math.abs(sticker.targetMb - 512 / 1024) < 1e-9);
});

test('parseSettings applies defaults', () => {
  const settings = parseSettings({});
  assert.equal(settings.targetPreset, 'free');
  assert.equal(settings.targetMb, 10);
  assert.equal(settings.width, 480);
  assert.equal(settings.fps, 15);
  assert.equal(settings.colors, 96);
  assert.equal(settings.loopCount, 0);
  assert.equal(settings.gifskiQuality, 90);
  assert.equal(settings.optimize, true);
  assert.equal(settings.autoFit, true);
});

test('parseSettings clamps the custom target and quality', () => {
  assert.equal(parseSettings({ targetPreset: 'custom', targetMb: 1000 }).targetMb, 500);
  assert.equal(parseSettings({ targetPreset: 'custom', targetMb: 0.001 }).targetMb, 0.05);
  assert.equal(parseSettings({ targetPreset: 'nitro' }).targetMb, 500);
  assert.equal(parseSettings({ gifskiQuality: 999 }).gifskiQuality, 100);
  assert.equal(parseSettings({ gifskiQuality: 0 }).gifskiQuality, 1);
});

test('parseSettings clamps the bayer scale', () => {
  assert.equal(parseSettings({ bayerScale: 9 }).bayerScale, 5);
  assert.equal(parseSettings({ bayerScale: -2 }).bayerScale, 0);
  assert.equal(parseSettings({}).bayerScale, 5);
});

test('parseOverlay accepts safe ids and rejects path traversal', () => {
  const ok = parseOverlay({ enabled: true, id: 'a1b2c3d4-0000.png', position: 'center', scale: 0.5, opacity: 0.4 });
  assert.equal(ok.enabled, true);
  assert.equal(ok.id, 'a1b2c3d4-0000.png');
  assert.equal(ok.position, 'center');
  // A traversal id is dropped, which also disables the overlay.
  const bad = parseOverlay({ enabled: true, id: '../../etc/passwd' });
  assert.equal(bad.id, '');
  assert.equal(bad.enabled, false);
  // Clamps and defaults.
  assert.equal(parseOverlay({ id: 'x.png', scale: 9 }).scale, 1);
  assert.equal(parseOverlay({}).position, 'bottom-right');
});

test('parseSettings validates orientation and color filters', () => {
  assert.equal(parseSettings({ rotate: 90 }).rotate, 90);
  assert.equal(parseSettings({ rotate: 45 }).rotate, 0);
  assert.equal(parseSettings({ flipH: true, flipV: 1 }).flipH, true);
  assert.equal(parseSettings({ flipV: 1 }).flipV, true);
  assert.equal(parseSettings({ colorFilter: 'sepia' }).colorFilter, 'sepia');
  assert.equal(parseSettings({ colorFilter: 'bogus' }).colorFilter, 'none');
  assert.equal(parseSettings({ saturation: 9 }).saturation, 3);
  assert.equal(parseSettings({}).saturation, 1);
});

test('parseSettings clamps speed and validates playback', () => {
  assert.equal(parseSettings({ speed: 99 }).speed, 8);
  assert.equal(parseSettings({ speed: 0 }).speed, 0.25);
  assert.equal(parseSettings({}).speed, 1);
  assert.equal(parseSettings({ playback: 'boomerang' }).playback, 'boomerang');
  assert.equal(parseSettings({ playback: 'nonsense' }).playback, 'normal');
});

test('parseSettings honours the maxTrimStartSec ceiling argument', () => {
  assert.equal(parseSettings({ startSec: 500 }, 100).startSec, 100);
});

test('parseSettings rejects malformed JSON with an ApiError', () => {
  assert.throws(() => parseSettings('{not json'), (error) => error instanceof ApiError && error.code === 'INVALID_SETTINGS');
});

test('parseCrop clamps the region and only enables a real sub-rectangle', () => {
  assert.deepEqual(parseCrop({ enabled: true, x: 0.1, y: 0.1, w: 0.8, h: 0.8 }), { enabled: true, x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  // A full-frame crop is treated as disabled even when the flag is set.
  assert.equal(parseCrop({ enabled: true, x: 0, y: 0, w: 1, h: 1 }).enabled, false);
  // Width is bounded so the rectangle stays inside the frame.
  assert.ok(Math.abs(parseCrop({ enabled: true, x: 0.8, w: 1 }).w - 0.2) < 1e-9);
  assert.equal(parseCrop(undefined).enabled, false);
});

test('parseCaption keeps printable text and strips control characters', () => {
  assert.deepEqual(parseCaption({ top: 'HELLO - WORLD 100%', bottom: "it's fine" }), { top: 'HELLO - WORLD 100%', bottom: "it's fine" });
  assert.equal(parseCaption({ top: 'line\nbreak' }).top, 'line break');
  assert.equal(parseCaption({ top: 'x'.repeat(200) }).top.length, 120);
  assert.deepEqual(parseCaption(undefined), { top: '', bottom: '' });
});

test('nextAttempt reduces width and colours while over target', () => {
  const next = nextAttempt({
    width: 480, fps: 15, colors: 96, dedupeFrames: false, frameDropModulo: 0,
    durationSec: 6, outputBytes: 20 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, allowTrim: false, minWidth: 120
  });
  assert.ok(next);
  assert.ok(next.width < 480);
  assert.ok(next.colors <= 96);
});

test('nextAttempt predicts a frame-rate cut that lands near the target in one step', () => {
  const next = nextAttempt({
    width: 120, fps: 15, colors: 96, dedupeFrames: false, frameDropModulo: 0,
    durationSec: 6, outputBytes: 20 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, allowTrim: false, minWidth: 120
  });
  assert.ok(next);
  assert.equal(next.fps, 8);
});

test('nextAttempt cuts width deeper when far over the target', () => {
  const next = nextAttempt({
    width: 800, fps: 15, colors: 96, dedupeFrames: false, frameDropModulo: 0,
    durationSec: 6, outputBytes: 50 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, allowTrim: false, minWidth: 120
  });
  assert.ok(next);
  assert.equal(next.width, 400);
});

test('nextAttempt prefers lossy compression over dropping frames when allowed', () => {
  const next = nextAttempt({
    width: 120, fps: 6, colors: 32, dedupeFrames: false, frameDropModulo: 0,
    gifsicleLossy: 0, allowLossy: true,
    durationSec: 6, outputBytes: 12 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, allowTrim: false, minWidth: 120
  });
  assert.ok(next);
  assert.equal(next.gifsicleLossy, 40);
  assert.equal(next.dedupeFrames, false);
});

test('nextAttempt holds a locked minimum width for square targets', () => {
  const next = nextAttempt({
    width: 128, fps: 15, colors: 96, dedupeFrames: false, frameDropModulo: 0,
    durationSec: 6, outputBytes: 20 * 1024 * 1024, targetBytes: 256 / 1024 * 1024 * 1024, allowTrim: false, minWidth: 128
  });
  assert.ok(next);
  assert.equal(next.width, 128);
});

test('nextAttempt terminates when every lever is exhausted', () => {
  const next = nextAttempt({
    width: 120, fps: 6, colors: 32, dedupeFrames: true, frameDropModulo: 3,
    gifsicleLossy: 160, allowLossy: true,
    durationSec: 6, outputBytes: 20 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, allowTrim: false, minWidth: 120
  });
  assert.equal(next, null);
});

test('exceedsFrameBudget rejects pathological encode workloads', () => {
  const normal = exceedsFrameBudget({ width: 480, height: 270, fps: 15, durationSec: 6 });
  assert.equal(normal.exceeds, false);

  const maxOutput = exceedsFrameBudget({ width: 1280, height: 720, fps: 30, durationSec: 60 });
  assert.equal(maxOutput.exceeds, false);

  const boomerangMax = exceedsFrameBudget({ width: 1280, height: 720, fps: 30, durationSec: 60, playback: 'boomerang' });
  assert.equal(boomerangMax.exceeds, false);

  const pathological = exceedsFrameBudget({ width: 3840, height: 2160, fps: 60, durationSec: 60 });
  assert.equal(pathological.exceeds, true);
  assert.ok(pathological.message.includes('safety limit'));
});

test('exceedsFrameBudget uses a configurable limit', () => {
  const result = exceedsFrameBudget({ width: 100, height: 100, fps: 10, durationSec: 2, maxFramePixels: 100_000 });
  assert.equal(result.exceeds, true);
  assert.equal(result.totalFramePixels, 200_000);
});

test('discordTargetChecks validates emoji constraints', () => {
  const checks = discordTargetChecks({ preset: 'emoji', outputBytes: 200 * 1024, width: 128, height: 128, format: 'gif' });
  assert.ok(checks.length >= 2);
  assert.ok(checks.every((c) => c.pass));
});

test('discordTargetChecks flags oversized emoji', () => {
  const checks = discordTargetChecks({ preset: 'emoji', outputBytes: 300 * 1024, width: 128, height: 128, format: 'gif' });
  const sizeCheck = checks.find((c) => c.label === 'File size');
  assert.ok(sizeCheck);
  assert.equal(sizeCheck.pass, false);
});

test('discordTargetChecks warns about GIF auto-play threshold', () => {
  const checks = discordTargetChecks({ preset: 'free', outputBytes: 500 * 1024, width: 320, height: 180, format: 'gif' });
  const autoPlay = checks.find((c) => c.label === 'Auto-play');
  assert.ok(autoPlay);
  assert.equal(autoPlay.pass, false);
  assert.ok(autoPlay.detail.includes('static thumbnail'));
});

test('discordTargetChecks warns about Discord server resize', () => {
  const checks = discordTargetChecks({ preset: 'free', outputBytes: 5 * 1024 * 1024, width: 480, height: 270, format: 'gif' });
  const resize = checks.find((c) => c.label === 'Server resize');
  assert.ok(resize);
  assert.equal(resize.pass, false);
});

test('discordTargetChecks returns empty for unknown presets', () => {
  const checks = discordTargetChecks({ preset: 'unknown', outputBytes: 1000, width: 100, height: 100, format: 'gif' });
  assert.deepEqual(checks, []);
});

test('isProtectedPath matches exact paths, children, and parents', () => {
  const base = path.resolve('data', 'output');
  const child = path.join(base, 'clip.gif');
  assert.equal(isProtectedPath(base, new Set([base])), true);
  assert.equal(isProtectedPath(child, new Set([base])), true);
  assert.equal(isProtectedPath(base, new Set([child])), true);
  assert.equal(isProtectedPath(path.resolve('data', 'uploads', 'x.mp4'), new Set([base])), false);
});
