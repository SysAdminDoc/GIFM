import { STRINGS } from './strings';

export const TARGET_PROFILES = STRINGS.target.profiles;

export type TargetPreset = typeof TARGET_PROFILES[number]['id'];
export type DitherMode = 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none';
export type PaletteMode = 'diff' | 'full' | 'single';
export type EncoderBackend = 'ffmpeg' | 'gifski';
export type OutputFormat = 'gif' | 'apng' | 'webp' | 'mp4' | 'avif';
export type Theme = 'dark' | 'light' | 'high-contrast';
export type Playback = 'normal' | 'reverse' | 'boomerang';
export type CropRect = { enabled: boolean; x: number; y: number; w: number; h: number };
export type Rotation = 0 | 90 | 180 | 270;
export type ColorFilter = 'none' | 'grayscale' | 'invert' | 'sepia';
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
export type OverlaySettings = { enabled: boolean; id: string; position: OverlayPosition; scale: number; opacity: number };

export type Settings = {
  targetPreset: TargetPreset;
  targetMb: number;
  width: number;
  fps: number;
  startSec: number;
  durationSec: number;
  colors: number;
  dither: DitherMode;
  bayerScale: number;
  paletteMode: PaletteMode;
  perFramePalette: boolean;
  encoderBackend: EncoderBackend;
  autoFit: boolean;
  allowTrim: boolean;
  optimize: boolean;
  gifskiQuality: number;
  loopCount: number;
  speed: number;
  playback: Playback;
  crop: CropRect;
  format: OutputFormat;
  caption: { top: string; bottom: string };
  overlay: OverlaySettings;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  colorFilter: ColorFilter;
  saturation: number;
  gifsicleColorSpace: 'srgb' | 'oklab';
  gifsicleOptDither: 'none' | 'ordered' | 'atkinson';
  subtitleId: string;
  borderRadius: number;
};

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export type Attempt = {
  attempt: number;
  width: number;
  fps: number;
  colors: number;
  durationSec: number;
  strategy?: string;
  rejected?: boolean;
  outputBytes?: number;
};

export type CommandRecord = {
  stage: string;
  tool: string;
  args: string[];
  command: string;
};

export type DiscordCheck = {
  label: string;
  pass: boolean;
  detail: string;
};

export type OutputMeta = {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: number | null;
  format: string;
};

export type Job = {
  id: string;
  status: JobStatus;
  progress: number;
  stage: string;
  queuePosition?: number;
  inputName: string;
  inputSize: number;
  outputBytes?: number;
  targetBytes: number;
  downloadUrl?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  errorCode?: string;
  warnings: string[];
  logs: string[];
  commands?: CommandRecord[];
  attempts: Attempt[];
  settings: Settings;
  outputMeta?: OutputMeta | null;
  discordChecks?: DiscordCheck[];
  ssim?: number | null;
};

export type SourceMeta = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string;
  rotation: number;
  probeSource?: 'client' | 'server';
  frameSampled?: boolean;
};

export type HealthInfo = {
  version: string;
  ffmpeg: { available: boolean; path: string; version: string };
  ffprobe: { available: boolean; path: string; version: string };
  gifski: { available: boolean; path: string; version: string; license: string };
  gifsicle?: { available: boolean; configured: boolean; path: string; version: string; license: string };
  font?: { available: boolean; path: string; license: string };
  platform: { os: string; arch: string; node: string };
  maxUploadBytes?: number;
  maxTrimStartSec?: number;
  preparedSources?: number;
};

export type SavedPreset = {
  id: string;
  name: string;
  settings: Settings;
};

export type RecentOutput = {
  id: string;
  inputName: string;
  outputBytes: number;
  targetBytes: number;
  profileLabel: string;
  downloadUrl: string;
  completedAt: string;
};

export type BatchJob = {
  localId: string;
  inputName: string;
  inputSize: number;
  job?: Job;
  status: 'pending' | 'submitted' | 'failed';
  error?: string;
};

export type SourceSession = {
  id: string;
  inputName: string;
  inputSize: number;
  sourceKind: string;
  createdAt: string;
  lastUsedAt: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string;
  rotation: number;
};

export type LoopCandidate = {
  timeSec: number;
  ssim: number;
};

export type ExtractedFrame = {
  index: number;
  file: string;
  url: string;
  delayCentiseconds: number;
};

export type FrameManifest = {
  frameId: string;
  fps: number;
  frameCount: number;
  frames: ExtractedFrame[];
};

export type TimelineClip = {
  id: string;
  name: string;
  startSec: number;
  durationSec: number;
  createdAt: string;
};

export type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    id?: string;
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

export type ApiErrorPayload = {
  error?: string | { code?: string; message?: string };
};
