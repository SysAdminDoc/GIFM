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
  nextAttempt,
  isProtectedPath
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

test('dimensionLockForPreset locks emoji and avatar to square output', () => {
  assert.deepEqual(dimensionLockForPreset('emoji'), { square: true, fixedWidth: 128, minWidth: 128, fpsMax: 30 });
  assert.deepEqual(dimensionLockForPreset('avatar'), { square: true, fixedWidth: 0, minWidth: 128, fpsMax: 30 });
  assert.deepEqual(dimensionLockForPreset('free'), { square: false, fixedWidth: 0, minWidth: 120, fpsMax: 30 });
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

test('isProtectedPath matches exact paths, children, and parents', () => {
  const base = path.resolve('data', 'output');
  const child = path.join(base, 'clip.gif');
  assert.equal(isProtectedPath(base, new Set([base])), true);
  assert.equal(isProtectedPath(child, new Set([base])), true);
  assert.equal(isProtectedPath(base, new Set([child])), true);
  assert.equal(isProtectedPath(path.resolve('data', 'uploads', 'x.mp4'), new Set([base])), false);
});
