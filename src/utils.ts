import { STRINGS } from './strings';
import { TARGET_PROFILES, type TargetPreset, type CropRect, type ApiErrorPayload } from './types';

export function clampNumber(value: number, min: number, max: number) {
  const num = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, num));
}

export function evenNumber(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return STRINGS.format.zeroBytes;
  const units = STRINGS.format.byteUnits;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function profileFor(preset: TargetPreset) {
  return TARGET_PROFILES.find((profile) => profile.id === preset) ?? TARGET_PROFILES[0];
}

export function normalizeCrop(value: unknown): CropRect {
  const raw = value && typeof value === 'object' ? (value as CropRect) : { enabled: false, x: 0, y: 0, w: 1, h: 1 };
  const x = clampNumber(Number(raw.x ?? 0), 0, 0.95);
  const y = clampNumber(Number(raw.y ?? 0), 0, 0.95);
  const w = clampNumber(Number(raw.w ?? 1), 0.05, 1 - x);
  const h = clampNumber(Number(raw.h ?? 1), 0.05, 1 - y);
  const enabled = Boolean(raw.enabled) && (x > 0 || y > 0 || w < 1 || h < 1);
  return { enabled, x, y, w, h };
}

export function normalizeLoopCount(value: unknown): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return 0;
  if (num <= -1) return -1;
  return clampNumber(num, 0, 1000);
}

export function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be full or disabled.
  }
}

export async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message ?? fallback;
}

export function formatTimecode(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00:00';
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const wholeSeconds = rounded % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
}
