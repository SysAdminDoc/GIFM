import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileDown,
  Gauge,
  Image as ImageIcon,
  Loader2,
  MonitorDown,
  Play,
  RotateCcw,
  Scissors,
  Settings2,
  Terminal,
  Trash2,
  UploadCloud,
  Video,
  Wand2
} from 'lucide-react';
import {
  Component,
  type ChangeEvent,
  type DragEvent,
  type ErrorInfo,
  type FormEvent,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react';
import { probeClientMedia } from './clientPreflight';
import { STRINGS, setActiveLocale, LOCALE_LABELS, type Locale } from './strings';

const VERSION = '0.3.0';
const TARGET_PROFILES = STRINGS.target.profiles;
const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

type TargetPreset = typeof TARGET_PROFILES[number]['id'];
type DitherMode = 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none';
type PaletteMode = 'diff' | 'full' | 'single';
type EncoderBackend = 'ffmpeg' | 'gifski';
type OutputFormat = 'gif' | 'apng' | 'webp' | 'mp4';
type Theme = 'dark' | 'light' | 'high-contrast';
type Playback = 'normal' | 'reverse' | 'boomerang';
type CropRect = { enabled: boolean; x: number; y: number; w: number; h: number };
type Rotation = 0 | 90 | 180 | 270;
type ColorFilter = 'none' | 'grayscale' | 'invert' | 'sepia';
type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
type OverlaySettings = { enabled: boolean; id: string; position: OverlayPosition; scale: number; opacity: number };

type Settings = {
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
};

type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

type Attempt = {
  attempt: number;
  width: number;
  fps: number;
  colors: number;
  durationSec: number;
  strategy?: string;
  rejected?: boolean;
  outputBytes?: number;
};

type Job = {
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
};

type CommandRecord = {
  stage: string;
  tool: string;
  args: string[];
  command: string;
};

type SourceMeta = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string;
  rotation: number;
  probeSource?: 'client' | 'server';
  frameSampled?: boolean;
};

type HealthInfo = {
  version: string;
  ffmpeg: {
    available: boolean;
    path: string;
    version: string;
  };
  ffprobe: {
    available: boolean;
    path: string;
    version: string;
  };
  gifski: {
    available: boolean;
    path: string;
    version: string;
    license: string;
  };
  gifsicle?: {
    available: boolean;
    configured: boolean;
    path: string;
    version: string;
    license: string;
  };
  font?: {
    available: boolean;
    path: string;
    license: string;
  };
  platform: {
    os: string;
    arch: string;
    node: string;
  };
  maxUploadBytes?: number;
  maxTrimStartSec?: number;
  preparedSources?: number;
};

type SavedPreset = {
  id: string;
  name: string;
  settings: Settings;
};

type RecentOutput = {
  id: string;
  inputName: string;
  outputBytes: number;
  targetBytes: number;
  profileLabel: string;
  downloadUrl: string;
  completedAt: string;
};

type BatchJob = {
  localId: string;
  inputName: string;
  inputSize: number;
  job?: Job;
  status: 'pending' | 'submitted' | 'failed';
  error?: string;
};

type SourceSession = {
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

type TimelineClip = {
  id: string;
  name: string;
  startSec: number;
  durationSec: number;
  createdAt: string;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    id?: string;
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

type ApiErrorPayload = {
  error?: string | {
    code?: string;
    message?: string;
  };
};

const DEFAULT_SETTINGS: Settings = {
  targetPreset: 'free',
  targetMb: 10,
  width: 480,
  fps: 15,
  startSec: 0,
  durationSec: 6,
  colors: 96,
  dither: 'sierra2_4a',
  bayerScale: 5,
  paletteMode: 'diff',
  encoderBackend: 'ffmpeg',
  autoFit: true,
  allowTrim: false,
  optimize: true,
  gifskiQuality: 90,
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
  saturation: 1
};

const SETTINGS_KEY = 'gifm:settings:v1';
const PRESETS_KEY = 'gifm:presets:v1';
const RECENTS_KEY = 'gifm:recents:v1';
const THEME_KEY = 'gifm:theme:v1';
const LOCALE_KEY = 'gifm:locale:v1';
const MAX_RECENT_OUTPUTS = 8;
const MAX_TRIM_START_SEC = 24 * 60 * 60;

class ErrorBoundary extends Component<PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal">
          <AlertTriangle aria-hidden="true" />
          <h1>{STRINGS.errors.fatalTitle}</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            <RotateCcw aria-hidden="true" />
            {STRINGS.errors.reload}
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <GifmApp />
    </ErrorBoundary>
  );
}

function GifmApp() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => loadPresets());
  const [recentOutputs, setRecentOutputs] = useState<RecentOutput[]>(() => loadRecentOutputs());
  const [file, setFile] = useState<File | null>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [objectUrl, setObjectUrl] = useState<string>('');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  const [sourceSession, setSourceSession] = useState<SourceSession | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [timelineClips, setTimelineClips] = useState<TimelineClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState('');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewSeekTime, setPreviewSeekTime] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    setActiveLocale(locale);
    document.documentElement.lang = locale;
    writeStorage(LOCALE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    writeStorage(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    writeStorage(PRESETS_KEY, savedPresets);
  }, [savedPresets]);

  useEffect(() => {
    writeStorage(RECENTS_KEY, recentOutputs);
  }, [recentOutputs]);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => setHealth(payload as HealthInfo | null))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!file) {
      setObjectUrl('');
      return undefined;
    }

    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!file) {
      setSourceMeta(null);
      setSourceSession(null);
      setTimelineClips([]);
      setSelectedClipId('');
      setPreviewTime(0);
      setPreviewSeekTime(null);
      return undefined;
    }
    if (!objectUrl) return undefined;

    const controller = new AbortController();
    const probe = async () => {
      setProbeBusy(true);
      try {
        const clientMetadata = await probeClientMedia(file, objectUrl, controller.signal);
        if (clientMetadata) {
          setSourceMeta(clientMetadata);
          if (clientMetadata.durationSec && clientMetadata.durationSec > 0) {
            setSettings((current) => clampTrimToDuration(current, clientMetadata.durationSec ?? current.durationSec));
          }
          return;
        }

        const body = new FormData();
        body.set('media', file);
        const response = await fetch('/api/probe', { method: 'POST', body, signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readApiError(response, `${STRINGS.errors.probeFailed} (${response.status})`));
        }

        const metadata = { ...(await response.json()) as SourceMeta, probeSource: 'server' as const, frameSampled: false };
        setSourceMeta(metadata);
        if (metadata.durationSec && metadata.durationSec > 0) {
          setSettings((current) => clampTrimToDuration(current, metadata.durationSec ?? current.durationSec));
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSourceMeta(null);
        setNotice(error instanceof Error ? error.message : STRINGS.errors.probeFailed);
      } finally {
        if (!controller.signal.aborted) setProbeBusy(false);
      }
    };

    void probe();
    return () => controller.abort();
  }, [file, objectUrl]);

  useEffect(() => {
    if (!job || isTerminalJob(job)) {
      return undefined;
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        if (!response.ok) {
          throw new Error(`${STRINGS.errors.statusFailed} (${response.status})`);
        }
        const nextJob = (await response.json()) as Job;
        setJob(nextJob);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : STRINGS.errors.statusFailed);
      }
    }, 800);

    return () => window.clearInterval(interval);
  }, [job]);

  useEffect(() => {
    const activeJobs = batchJobs
      .map((item) => item.job)
      .filter((item): item is Job => item ? !isTerminalJob(item) : false);
    if (!activeJobs.length) return undefined;

    const interval = window.setInterval(async () => {
      const updates = await Promise.all(activeJobs.map((item) => fetchJob(item.id).catch(() => null)));
      setBatchJobs((current) => current.map((item) => {
        const nextJob = updates.find((update) => update?.id === item.job?.id);
        return nextJob ? { ...item, job: nextJob } : item;
      }));
      const currentJobUpdate = updates.find((update): update is Job => Boolean(update && update.id === job?.id));
      if (currentJobUpdate) setJob(currentJobUpdate);
    }, 800);

    return () => window.clearInterval(interval);
  }, [batchJobs, job?.id]);

  useEffect(() => {
    if (job?.status !== 'complete' || !job.downloadUrl || !job.outputBytes) return;
    const recent = recentFromJob(job);
    setRecentOutputs((current) => [recent, ...current.filter((item) => item.id !== recent.id)].slice(0, MAX_RECENT_OUTPUTS));
  }, [job?.id, job?.status, job?.downloadUrl, job?.outputBytes]);

  useEffect(() => {
    const completed = batchJobs
      .map((item) => item.job)
      .filter((item): item is Job => Boolean(item?.downloadUrl && item.outputBytes && item.status === 'complete'));
    if (!completed.length) return;

    setRecentOutputs((current) => {
      let next = current;
      for (const completedJob of completed) {
        if (next.some((item) => item.id === completedJob.id)) continue;
        const recent = recentFromJob(completedJob);
        next = [recent, ...next].slice(0, MAX_RECENT_OUTPUTS);
      }
      return next;
    });
  }, [batchJobs]);

  const targetBytes = useMemo(() => settings.targetMb * 1024 * 1024, [settings.targetMb]);
  const activeProfile = useMemo(() => profileFor(settings.targetPreset), [settings.targetPreset]);
  const originalRatio = useMemo(() => {
    if (!file) return 0;
    return file.size / targetBytes;
  }, [file, targetBytes]);

  const outputFit = job?.outputBytes ? job.outputBytes <= job.targetBytes : false;
  const canStart = batchFiles.length > 0 && !busy && job?.status !== 'running' && job?.status !== 'queued';
  const canCancel = job?.status === 'queued' || job?.status === 'running';

  const chooseFiles = useCallback((nextFiles?: FileList | File[]) => {
    const files = Array.from(nextFiles ?? []);
    const nextFile = files[0];
    if (!nextFile) return;
    setObjectUrl('');
    setFile(nextFile);
    setBatchFiles(files);
    setBatchJobs([]);
    setJob(null);
    setSourceSession(null);
    setTimelineClips([]);
    setSelectedClipId('');
    setPreviewTime(0);
    setPreviewSeekTime(null);
    setNotice(files.length > 1 ? STRINGS.notices.filesLoaded(files.length) : STRINGS.notices.fileLoaded(nextFile.name));
  }, []);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFiles(event.currentTarget.files ?? undefined);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    chooseFiles(event.dataTransfer.files);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(true);
  };

  const submitUploadedFiles = async (filesToSubmit: File[], settingsForJob: Settings, noticeText: string) => {
    if (!filesToSubmit.length) return;
    setBusy(true);
    setNotice(noticeText);
    const queuedItems = filesToSubmit.map((item) => ({
      localId: crypto.randomUUID(),
      inputName: item.name,
      inputSize: item.size,
      status: 'pending' as const
    }));
    setBatchJobs(queuedItems);

    try {
      let firstJob: Job | null = null;
      for (let index = 0; index < filesToSubmit.length; index += 1) {
        const nextFile = filesToSubmit[index];
        const localId = queuedItems[index].localId;
        const body = new FormData();
        body.set('media', nextFile);
        body.set('settings', JSON.stringify(settingsForJob));

        const response = await fetch('/api/jobs', {
          method: 'POST',
          body
        });

        if (!response.ok) {
          const message = await readApiError(response, `${STRINGS.errors.encodeStartFailed} (${response.status})`);
          setBatchJobs((current) => current.map((item) => item.localId === localId ? { ...item, status: 'failed', error: message } : item));
          continue;
        }

        const nextJob = (await response.json()) as Job;
        setBatchJobs((current) => current.map((item) => item.localId === localId ? { ...item, status: 'submitted', job: nextJob } : item));
        if (!firstJob) {
          firstJob = nextJob;
          setJob(nextJob);
        }
      }

      setNotice(firstJob ? STRINGS.notices.jobsSubmitted : STRINGS.notices.noJobsSubmitted);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : STRINGS.errors.encodeStartFailed);
    } finally {
      setBusy(false);
    }
  };

  const startEncoding = async (event: FormEvent) => {
    event.preventDefault();
    await submitUploadedFiles(
      batchFiles,
      settings,
      batchFiles.length > 1 ? STRINGS.notices.submittingJobs(batchFiles.length) : STRINGS.notices.encodingStarted
    );
  };

  const importFromUrl = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setSourceBusy(true);
    setNotice(STRINGS.notices.importingUrl);
    try {
      const response = await fetch('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed })
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, STRINGS.errors.importFailed));
      }
      const prepared = (await response.json()) as SourceSession;
      setFile(null);
      setBatchFiles([]);
      setObjectUrl('');
      setSourceSession(prepared);
      setSourceMeta({
        durationSec: prepared.durationSec,
        width: prepared.width,
        height: prepared.height,
        fps: prepared.fps,
        codec: prepared.codec,
        rotation: prepared.rotation,
        probeSource: 'server',
        frameSampled: false
      });
      setNotice(STRINGS.notices.sourcePrepared(prepared.inputName));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : STRINGS.errors.importFailed);
    } finally {
      setSourceBusy(false);
    }
  };

  const prepareSource = async () => {
    if (!file) throw new Error(STRINGS.errors.noSourceFile);
    if (sourceSession && sourceSession.inputName === file.name && sourceSession.inputSize === file.size) {
      return sourceSession;
    }

    setSourceBusy(true);
    setNotice(STRINGS.notices.preparingSource(file.name));
    try {
      const body = new FormData();
      body.set('media', file);
      const response = await fetch('/api/sources', { method: 'POST', body });
      if (!response.ok) {
        throw new Error(await readApiError(response, `${STRINGS.errors.sourcePrepareFailed} (${response.status})`));
      }

      const prepared = (await response.json()) as SourceSession;
      setSourceSession(prepared);
      setSourceMeta((current) => current ?? {
        durationSec: prepared.durationSec,
        width: prepared.width,
        height: prepared.height,
        fps: prepared.fps,
        codec: prepared.codec,
        rotation: prepared.rotation,
        probeSource: 'server',
        frameSampled: false
      });
      setNotice(STRINGS.notices.sourcePrepared(prepared.inputName));
      return prepared;
    } finally {
      setSourceBusy(false);
    }
  };

  const addTimelineClip = () => {
    if (!file) return;
    const clip = makeTimelineClip(timelineClips.length + 1, settings);
    setTimelineClips((current) => [...current, clip]);
    setSelectedClipId(clip.id);
    setNotice(STRINGS.notices.clipAdded(clip.name));
  };

  const updateTimelineClip = (id: string) => {
    const clip = timelineClips.find((item) => item.id === id);
    if (!clip) return;
    setTimelineClips((current) => current.map((item) => item.id === id ? {
      ...item,
      startSec: Number(settings.startSec.toFixed(2)),
      durationSec: Number(settings.durationSec.toFixed(2))
    } : item));
    setNotice(STRINGS.notices.clipUpdated(clip.name));
  };

  const applyTimelineClip = (clip: TimelineClip) => {
    setSettings((current) => clipSettings(current, clip));
    setSelectedClipId(clip.id);
    setPreviewSeekTime(clip.startSec);
    setNotice(STRINGS.notices.clipLoaded(clip.name));
  };

  const deleteTimelineClip = (id: string) => {
    const clip = timelineClips.find((item) => item.id === id);
    setTimelineClips((current) => current.filter((item) => item.id !== id));
    if (selectedClipId === id) setSelectedClipId('');
    if (clip) setNotice(STRINGS.notices.clipDeleted(clip.name));
  };

  const exportTimelineClips = async (clipsToExport: TimelineClip[]) => {
    if (!clipsToExport.length || !file) return;
    setBusy(true);
    try {
      const prepared = await prepareSource();
      setNotice(STRINGS.notices.submittingClips(clipsToExport.length));
      const queuedItems = clipsToExport.map((clip) => ({
        localId: crypto.randomUUID(),
        inputName: `${prepared.inputName} - ${clip.name}`,
        inputSize: prepared.inputSize,
        status: 'pending' as const
      }));
      setBatchJobs(queuedItems);

      let firstJob: Job | null = null;
      for (let index = 0; index < clipsToExport.length; index += 1) {
        const clip = clipsToExport[index];
        const localId = queuedItems[index].localId;
        const response = await fetch(`/api/sources/${prepared.id}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clipName: clip.name,
            settings: clipSettings(settings, clip)
          })
        });

        if (!response.ok) {
          const message = await readApiError(response, `${STRINGS.errors.encodeStartFailed} (${response.status})`);
          setBatchJobs((current) => current.map((item) => item.localId === localId ? { ...item, status: 'failed', error: message } : item));
          continue;
        }

        const nextJob = (await response.json()) as Job;
        setBatchJobs((current) => current.map((item) => item.localId === localId ? { ...item, status: 'submitted', job: nextJob } : item));
        if (!firstJob) {
          firstJob = nextJob;
          setJob(nextJob);
        }
      }

      setNotice(firstJob ? STRINGS.notices.clipJobsSubmitted : STRINGS.notices.noJobsSubmitted);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : STRINGS.errors.encodeStartFailed);
    } finally {
      setBusy(false);
    }
  };

  const revealOutput = async () => {
    if (!job) return;
    const response = await fetch(`/api/jobs/${job.id}/reveal`, { method: 'POST' });
    setNotice(response.ok ? STRINGS.notices.outputOpened : await readApiError(response, STRINGS.errors.outputOpenFailed));
  };

  const sendToWebhook = async (webhookUrl: string) => {
    if (!job || job.status !== 'complete') return;
    setNotice(STRINGS.notices.webhookSending);
    try {
      const response = await fetch(`/api/jobs/${job.id}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl })
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, STRINGS.errors.webhookFailed));
      }
      setNotice(STRINGS.notices.webhookSent);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : STRINGS.errors.webhookFailed);
    }
  };

  const saveOutputAs = async (targetJob: Job) => {
    if (!targetJob.downloadUrl) return;

    try {
      await saveJobOutput(targetJob);
      setNotice(STRINGS.notices.gifSaved);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setNotice(STRINGS.notices.saveCancelled);
        return;
      }
      setNotice(error instanceof Error ? error.message : STRINGS.errors.saveFailed);
    }
  };

  const copyText = useCallback(async (text: string, successMessage: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(STRINGS.errors.copyFailed);
      await navigator.clipboard.writeText(text);
      setNotice(successMessage);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : STRINGS.errors.copyFailed);
    }
  }, []);

  const cancelEncoding = async () => {
    if (!job || !canCancel) return;

    const response = await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    if (!response.ok) {
      setNotice(await readApiError(response, STRINGS.errors.cancelFailed));
      return;
    }

    const nextJob = (await response.json()) as Job;
    setJob(nextJob);
    setNotice(STRINGS.notices.jobCancelled);
  };

  const cancelBatchJob = async (id: string) => {
    const response = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
    if (!response.ok) {
      setNotice(await readApiError(response, STRINGS.errors.cancelFailed));
      return;
    }

    const nextJob = (await response.json()) as Job;
    setBatchJobs((current) => current.map((item) => item.job?.id === nextJob.id ? { ...item, job: nextJob } : item));
    if (job?.id === nextJob.id) setJob(nextJob);
    setNotice(STRINGS.notices.jobCancelled);
  };

  const savePreset = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setSavedPresets((current) => {
      const existing = current.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
      const nextPreset = { id: existing?.id ?? crypto.randomUUID(), name: trimmed, settings };
      return [nextPreset, ...current.filter((preset) => preset.id !== nextPreset.id)].slice(0, 20);
    });
    setNotice(STRINGS.notices.presetSaved(trimmed));
  };

  const loadPreset = (id: string) => {
    const preset = savedPresets.find((item) => item.id === id);
    if (!preset) return;
    setSettings(normalizeSettings(preset.settings));
    setNotice(STRINGS.notices.presetLoaded(preset.name));
  };

  const deletePreset = (id: string) => {
    const preset = savedPresets.find((item) => item.id === id);
    setSavedPresets((current) => current.filter((item) => item.id !== id));
    if (preset) setNotice(STRINGS.notices.presetDeleted(preset.name));
  };

  const revealRecentOutput = async (id: string) => {
    const response = await fetch(`/api/jobs/${id}/reveal`, { method: 'POST' });
    if (response.ok) {
      setNotice(STRINGS.notices.outputOpened);
      return;
    }

    setRecentOutputs((current) => current.filter((item) => item.id !== id));
    setNotice(await readApiError(response, STRINGS.errors.recentUnavailable));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <div>
            <h1>{STRINGS.app.name}</h1>
            <p>{STRINGS.app.subtitle(VERSION)}</p>
          </div>
        </div>
        <div className="topbar-meta" aria-live="polite">
          <div className="topbar-status">
            <Gauge aria-hidden="true" />
            <span>{batchFiles.length > 1 ? STRINGS.app.filesSelected(batchFiles.length) : file ? STRINGS.app.sourceSize(formatBytes(file.size)) : STRINGS.app.ready}</span>
          </div>
          <div className="trust-strip" aria-label={STRINGS.app.runtimeAria}>
            <span className="trust-chip">
              <CheckCircle2 aria-hidden="true" />
              {STRINGS.app.localOnly}
            </span>
            <span className="trust-chip">
              <Terminal aria-hidden="true" />
              {health ? health.ffmpeg.available ? STRINGS.app.ffmpegReady : STRINGS.app.ffmpegUnavailable : STRINGS.app.runtimePending}
            </span>
            <span className="trust-chip">
              <Gauge aria-hidden="true" />
              {STRINGS.app.targetStatus(activeProfile.label, formatBytes(targetBytes))}
            </span>
          </div>
          <label className="theme-select">
            <span className="visually-hidden">{STRINGS.app.localeLabel}</span>
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label={STRINGS.app.localeLabel}>
              {(Object.keys(LOCALE_LABELS) as Locale[]).map((code) => (
                <option key={code} value={code}>{LOCALE_LABELS[code]}</option>
              ))}
            </select>
          </label>
          <label className="theme-select">
            <span className="visually-hidden">{STRINGS.app.theme.label}</span>
            <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)} aria-label={STRINGS.app.theme.label}>
              <option value="dark">{STRINGS.app.theme.options.dark}</option>
              <option value="light">{STRINGS.app.theme.options.light}</option>
              <option value="high-contrast">{STRINGS.app.theme.options.highContrast}</option>
            </select>
          </label>
        </div>
      </header>

      <form className="workspace" onSubmit={startEncoding}>
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          savedPresets={savedPresets}
          onSavePreset={savePreset}
          onLoadPreset={loadPreset}
          onDeletePreset={deletePreset}
          health={health}
        />

        <section className="center-stage" aria-label={STRINGS.input.workspaceAria}>
          <div
            className={`drop-zone${dragActive ? ' is-active' : ''}`}
            onDrop={onDrop}
            onDragLeave={() => setDragActive(false)}
            onDragOver={onDragOver}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="video/*,.gif,image/gif"
              onChange={onFileChange}
              aria-label={STRINGS.input.fileAria}
            />
            <div className="drop-icon">
              {file?.type === 'image/gif' ? <ImageIcon aria-hidden="true" /> : <UploadCloud aria-hidden="true" />}
            </div>
            <div>
              <h2>{STRINGS.input.heading}</h2>
              <p>{STRINGS.input.description}</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              <MonitorDown aria-hidden="true" />
              {STRINGS.input.browse}
            </button>
          </div>

          <UrlImportRow busy={sourceBusy} onImport={importFromUrl} />

          <div className="source-strip">
            <StatusTile label={STRINGS.target.title} value={formatBytes(targetBytes)} tone="cyan" />
            <StatusTile label={STRINGS.input.sourceRatio} value={file ? formatRatio(originalRatio) : STRINGS.diagnostics.emptyValue} tone="amber" />
            <StatusTile label={STRINGS.settings.autoFit.label} value={settings.autoFit ? STRINGS.settings.autoFit.on : STRINGS.settings.autoFit.off} tone={settings.autoFit ? 'lime' : 'muted'} />
            <StatusTile label={STRINGS.input.queue} value={queueLabel(job)} tone={job?.status === 'queued' ? 'amber' : 'muted'} />
          </div>

          <TimelineEditor
            settings={settings}
            setSettings={setSettings}
            sourceMeta={sourceMeta}
            probeBusy={probeBusy}
            previewTime={previewTime}
            onSeekPreview={setPreviewSeekTime}
            clips={timelineClips}
            selectedClipId={selectedClipId}
            onAddClip={addTimelineClip}
            onUpdateClip={updateTimelineClip}
            onApplyClip={applyTimelineClip}
            onDeleteClip={deleteTimelineClip}
            onExportClip={(clip) => exportTimelineClips([clip])}
            onExportAll={() => exportTimelineClips(timelineClips)}
            onPrepareSource={() => {
              void prepareSource().catch((error) => setNotice(error instanceof Error ? error.message : STRINGS.errors.sourcePrepareFailed));
            }}
            sourceSession={sourceSession}
            sourceBusy={sourceBusy}
            exportBusy={busy}
          />

          <div className="action-row">
            <button type="submit" className="primary-button" disabled={!canStart}>
              {job?.status === 'running' || job?.status === 'queued' ? (
                <Loader2 aria-hidden="true" className="spin" />
              ) : (
                <Wand2 aria-hidden="true" />
              )}
              {STRINGS.input.startEncoding}
            </button>
            {canCancel ? (
              <button type="button" className="secondary-button" onClick={cancelEncoding}>
                <AlertTriangle aria-hidden="true" />
                {STRINGS.input.cancel}
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              disabled={!file}
              onClick={() => {
                setFile(null);
                setBatchFiles([]);
                setBatchJobs([]);
                setJob(null);
                setSourceSession(null);
                setTimelineClips([]);
                setSelectedClipId('');
                setPreviewTime(0);
                setPreviewSeekTime(null);
                setNotice(STRINGS.notices.selectionCleared);
              }}
            >
              <RotateCcw aria-hidden="true" />
              {STRINGS.input.reset}
            </button>
            <span className="notice" aria-live="polite">
              {notice}
            </span>
          </div>

          <ProgressPanel job={job} />
          <BatchQueue jobs={batchJobs} onSelectJob={setJob} onRevealJob={revealRecentOutput} onSaveAs={saveOutputAs} onCancelJob={cancelBatchJob} />
          <LogPanel job={job} />
          <DiagnosticsPanel health={health} sourceMeta={sourceMeta} settings={settings} job={job} onCopyText={copyText} />
        </section>

        <PreviewPanel
          file={file}
          objectUrl={objectUrl}
          job={job}
          outputFit={outputFit}
          crop={settings.crop}
          onReveal={revealOutput}
          onSaveAs={saveOutputAs}
          onSendWebhook={sendToWebhook}
          onCopyText={copyText}
          onPreviewTime={setPreviewTime}
          previewSeekTime={previewSeekTime}
          recentOutputs={recentOutputs}
          onRevealRecent={revealRecentOutput}
          onClearRecent={() => {
            setRecentOutputs([]);
            setNotice(STRINGS.notices.recentCleared);
          }}
        />
      </form>
    </main>
  );
}

function SettingsPanel({
  settings,
  setSettings,
  savedPresets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  health
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  savedPresets: SavedPreset[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  health: HealthInfo | null;
}) {
  const [presetName, setPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const setPreset = (preset: TargetPreset) => {
    const profile = profileFor(preset);
    setSettings((current) => ({
      ...current,
      targetPreset: preset,
      targetMb: preset === 'custom' ? current.targetMb : profile.targetMb
    }));
  };

  const activeProfile = profileFor(settings.targetPreset);

  return (
    <aside className="settings-panel" aria-label={STRINGS.target.subtitle}>
      <div className="panel-heading">
        <Settings2 aria-hidden="true" />
        <div>
          <h2>{STRINGS.target.title}</h2>
          <p>{STRINGS.target.subtitle}</p>
        </div>
      </div>

      <SettingsSection title={STRINGS.settings.sections.target.title} description={STRINGS.settings.sections.target.description}>
        <div className="preset-grid" role="group" aria-label={STRINGS.target.ariaPresetGroup}>
          {TARGET_PROFILES.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={settings.targetPreset === profile.id ? 'selected' : ''}
              onClick={() => setPreset(profile.id)}
            >
              {profile.label}
            </button>
          ))}
        </div>

        <NumberField
          label={STRINGS.target.sizeLabel}
          value={settings.targetMb}
          min={0.05}
          max={500}
          step={0.01}
          suffix={STRINGS.target.customUnit}
          onChange={(value) => {
            setSettings((current) => ({ ...current, targetMb: value, targetPreset: 'custom' }));
          }}
        />
        <p className="profile-note">{activeProfile.description}</p>
      </SettingsSection>

      <SettingsSection title={STRINGS.settings.sections.clip.title} description={STRINGS.settings.sections.clip.description}>
        <NumberField label={STRINGS.settings.width} value={settings.targetPreset === 'emoji' ? 128 : settings.targetPreset === 'sticker' ? 320 : settings.width} min={160} max={1280} step={20} suffix={STRINGS.settings.units.px} disabled={settings.targetPreset === 'emoji' || settings.targetPreset === 'sticker'} onChange={(value) => update('width', value)} />
        <NumberField label={STRINGS.settings.fps} value={settings.fps} min={5} max={30} step={1} suffix={STRINGS.settings.units.fps} onChange={(value) => update('fps', value)} />
        <NumberField label={STRINGS.settings.start} value={settings.startSec} min={0} max={health?.maxTrimStartSec ?? MAX_TRIM_START_SEC} step={0.25} suffix={STRINGS.settings.units.seconds} onChange={(value) => update('startSec', value)} />
        <NumberField label={STRINGS.settings.duration} value={settings.durationSec} min={0.5} max={60} step={0.25} suffix={STRINGS.settings.units.seconds} onChange={(value) => update('durationSec', value)} />
        <label className="select-field">
          <span>{STRINGS.settings.speed.label}</span>
          <select value={String(settings.speed)} onChange={(event) => update('speed', clampNumber(Number(event.target.value), 0.25, 8))}>
            {SPEED_OPTIONS.map((value) => (
              <option key={value} value={String(value)}>{STRINGS.settings.speed.option(value)}</option>
            ))}
          </select>
        </label>
        <label className="select-field">
          <span>{STRINGS.settings.playback.label}</span>
          <select value={settings.playback} onChange={(event) => update('playback', event.target.value as Playback)}>
            <option value="normal">{STRINGS.settings.playback.options.normal}</option>
            <option value="reverse">{STRINGS.settings.playback.options.reverse}</option>
            <option value="boomerang">{STRINGS.settings.playback.options.boomerang}</option>
          </select>
        </label>
        <ToggleField
          label={STRINGS.settings.crop.label}
          description={STRINGS.settings.crop.description}
          checked={settings.crop.enabled}
          onChange={(checked) => update('crop', normalizeCrop({ ...settings.crop, enabled: checked, ...(checked && settings.crop.w >= 1 && settings.crop.h >= 1 ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : {}) }))}
        />
        {settings.crop.enabled
          ? (
            <div className="crop-fields">
              <CropRange label={STRINGS.settings.crop.x} value={settings.crop.x} max={0.95} onChange={(x) => update('crop', normalizeCrop({ ...settings.crop, x }))} />
              <CropRange label={STRINGS.settings.crop.y} value={settings.crop.y} max={0.95} onChange={(y) => update('crop', normalizeCrop({ ...settings.crop, y }))} />
              <CropRange label={STRINGS.settings.crop.w} value={settings.crop.w} max={1} onChange={(w) => update('crop', normalizeCrop({ ...settings.crop, w }))} />
              <CropRange label={STRINGS.settings.crop.h} value={settings.crop.h} max={1} onChange={(h) => update('crop', normalizeCrop({ ...settings.crop, h }))} />
            </div>
          )
          : null}
        {settings.targetPreset === 'emoji'
          ? <p className="profile-note">{STRINGS.settings.squareNote.emoji}</p>
          : settings.targetPreset === 'sticker'
            ? <p className="profile-note">{STRINGS.settings.squareNote.sticker}</p>
            : settings.targetPreset === 'avatar'
              ? <p className="profile-note">{STRINGS.settings.squareNote.avatar}</p>
              : null}

        <label className="text-field">
          <span>{STRINGS.settings.caption.top}</span>
          <input type="text" maxLength={120} value={settings.caption.top} placeholder={STRINGS.settings.caption.placeholder} onChange={(event) => update('caption', { ...settings.caption, top: event.target.value })} />
        </label>
        <label className="text-field">
          <span>{STRINGS.settings.caption.bottom}</span>
          <input type="text" maxLength={120} value={settings.caption.bottom} placeholder={STRINGS.settings.caption.placeholder} onChange={(event) => update('caption', { ...settings.caption, bottom: event.target.value })} />
        </label>
        {(settings.caption.top || settings.caption.bottom) && health && health.font && !health.font.available
          ? <p className="profile-note">{STRINGS.settings.caption.unavailable}</p>
          : null}

        <label className="select-field">
          <span>{STRINGS.settings.rotate.label}</span>
          <select value={String(settings.rotate)} onChange={(event) => update('rotate', Number(event.target.value) as Rotation)}>
            <option value="0">{STRINGS.settings.rotate.options.none}</option>
            <option value="90">{STRINGS.settings.rotate.options.cw90}</option>
            <option value="180">{STRINGS.settings.rotate.options.deg180}</option>
            <option value="270">{STRINGS.settings.rotate.options.ccw90}</option>
          </select>
        </label>
        <div className="flip-row">
          <ToggleField label={STRINGS.settings.flipH} description="" checked={settings.flipH} onChange={(checked) => update('flipH', checked)} />
          <ToggleField label={STRINGS.settings.flipV} description="" checked={settings.flipV} onChange={(checked) => update('flipV', checked)} />
        </div>
        <label className="select-field">
          <span>{STRINGS.settings.colorFilter.label}</span>
          <select value={settings.colorFilter} onChange={(event) => update('colorFilter', event.target.value as ColorFilter)}>
            <option value="none">{STRINGS.settings.colorFilter.options.none}</option>
            <option value="grayscale">{STRINGS.settings.colorFilter.options.grayscale}</option>
            <option value="invert">{STRINGS.settings.colorFilter.options.invert}</option>
            <option value="sepia">{STRINGS.settings.colorFilter.options.sepia}</option>
          </select>
        </label>
        <label className="range-field">
          <span>{STRINGS.settings.saturation.label} <strong>{settings.saturation.toFixed(1)}x</strong></span>
          <input type="range" min={0} max={3} step={0.1} value={settings.saturation} onChange={(event) => update('saturation', clampNumber(Number(event.target.value), 0, 3))} aria-label={STRINGS.settings.saturation.label} />
        </label>
        <OverlayField value={settings.overlay} onChange={(overlay) => update('overlay', overlay)} />
      </SettingsSection>

      <SettingsSection title={STRINGS.settings.sections.encoding.title} description={STRINGS.settings.sections.encoding.description}>
        <NumberField label={STRINGS.settings.palette} value={settings.colors} min={16} max={256} step={8} suffix={STRINGS.settings.units.colors} onChange={(value) => update('colors', value)} />

        <label className="select-field">
          <span>{STRINGS.settings.dither}</span>
          <select value={settings.dither} onChange={(event) => update('dither', event.target.value as DitherMode)}>
            <option value="sierra2_4a">{STRINGS.settings.ditherOptions.sierra}</option>
            <option value="bayer">{STRINGS.settings.ditherOptions.bayer}</option>
            <option value="floyd_steinberg">{STRINGS.settings.ditherOptions.floydSteinberg}</option>
            <option value="none">{STRINGS.settings.ditherOptions.none}</option>
          </select>
        </label>

        {settings.dither === 'bayer'
          ? (
            <label className="range-field">
              <span>{STRINGS.settings.bayerScale.label} <strong>{settings.bayerScale}</strong></span>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={settings.bayerScale}
                onChange={(event) => update('bayerScale', clampNumber(Number(event.target.value), 0, 5))}
                aria-label={STRINGS.settings.bayerScale.label}
              />
            </label>
          )
          : null}

        <label className="select-field">
          <span>{STRINGS.settings.paletteMode}</span>
          <select value={settings.paletteMode} onChange={(event) => update('paletteMode', event.target.value as PaletteMode)}>
            <option value="diff">{STRINGS.settings.paletteModeOptions.diff}</option>
            <option value="full">{STRINGS.settings.paletteModeOptions.full}</option>
            <option value="single">{STRINGS.settings.paletteModeOptions.single}</option>
          </select>
        </label>

        <label className="select-field">
          <span>{STRINGS.settings.format.label}</span>
          <select
            value={settings.targetPreset === 'sticker' ? 'apng' : settings.format}
            disabled={settings.targetPreset === 'sticker'}
            onChange={(event) => update('format', event.target.value as OutputFormat)}
          >
            <option value="gif">{STRINGS.settings.format.options.gif}</option>
            <option value="apng">{STRINGS.settings.format.options.apng}</option>
            <option value="webp">{STRINGS.settings.format.options.webp}</option>
            <option value="mp4">{STRINGS.settings.format.options.mp4}</option>
          </select>
        </label>
        {settings.targetPreset === 'sticker' || settings.format === 'apng'
          ? <p className="profile-note">{STRINGS.settings.format.apngNote}</p>
          : settings.format === 'webp'
            ? <p className="profile-note">{STRINGS.settings.format.webpNote}</p>
            : settings.format === 'mp4'
              ? <p className="profile-note">{STRINGS.settings.format.mp4Note}</p>
              : null}

        <label className="select-field">
          <span>{STRINGS.settings.encoder}</span>
          <select value={settings.encoderBackend} disabled={settings.format !== 'gif' || settings.targetPreset === 'sticker'} onChange={(event) => update('encoderBackend', event.target.value as EncoderBackend)}>
            <option value="ffmpeg">{STRINGS.settings.encoderOptions.ffmpeg}</option>
            <option value="gifski" disabled={!health?.gifski?.available}>{STRINGS.settings.encoderOptions.gifski}</option>
          </select>
        </label>
        <p className="profile-note">
          {settings.encoderBackend === 'gifski'
            ? STRINGS.settings.encoderNotes.gifski
            : STRINGS.settings.encoderNotes.ffmpeg}
        </p>

        {settings.encoderBackend === 'gifski'
          ? (
            <label className="range-field">
              <span>{STRINGS.settings.gifskiQuality.label} <strong>{settings.gifskiQuality}</strong></span>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={settings.gifskiQuality}
                onChange={(event) => update('gifskiQuality', clampNumber(Number(event.target.value), 1, 100))}
                aria-label={STRINGS.settings.gifskiQuality.label}
              />
            </label>
          )
          : null}

        <label className="select-field">
          <span>{STRINGS.settings.loop.label}</span>
          <select value={String(settings.loopCount)} onChange={(event) => update('loopCount', normalizeLoopCount(event.target.value))}>
            <option value="0">{STRINGS.settings.loop.options.infinite}</option>
            <option value="-1">{STRINGS.settings.loop.options.once}</option>
            <option value="3">{STRINGS.settings.loop.options.three}</option>
            <option value="5">{STRINGS.settings.loop.options.five}</option>
          </select>
        </label>

        <ToggleField
          label={STRINGS.settings.autoFit.label}
          description={STRINGS.settings.autoFit.description}
          checked={settings.autoFit}
          onChange={(checked) => update('autoFit', checked)}
        />
        <ToggleField
          label={STRINGS.settings.allowTrim.label}
          description={STRINGS.settings.allowTrim.description}
          checked={settings.allowTrim}
          onChange={(checked) => update('allowTrim', checked)}
        />
        <ToggleField
          label={STRINGS.settings.optimize.label}
          description={STRINGS.settings.optimize.description}
          checked={settings.optimize}
          onChange={(checked) => update('optimize', checked)}
        />
        {!health?.gifsicle?.available
          ? <p className="profile-note">{STRINGS.settings.optimize.unavailable}</p>
          : null}
      </SettingsSection>

      <SettingsSection title={STRINGS.settings.sections.presets.title} description={STRINGS.settings.sections.presets.description}>
        <div className="preset-manager">
          <label className="select-field">
            <span>{STRINGS.presets.savedLabel}</span>
            <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.currentTarget.value)}>
              <option value="">{STRINGS.presets.choose}</option>
              {savedPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <div className="preset-actions">
            <input
              type="text"
              value={presetName}
              maxLength={32}
              placeholder={STRINGS.presets.namePlaceholder}
              aria-label={STRINGS.presets.namePlaceholder}
              onChange={(event) => setPresetName(event.currentTarget.value)}
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                onSavePreset(presetName);
                setPresetName('');
              }}
            >
              {STRINGS.presets.save}
            </button>
            <button type="button" className="secondary-button" disabled={!selectedPresetId} onClick={() => onLoadPreset(selectedPresetId)}>
              {STRINGS.presets.load}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!selectedPresetId}
              onClick={() => {
                onDeletePreset(selectedPresetId);
                setSelectedPresetId('');
              }}
            >
              {STRINGS.presets.delete}
            </button>
          </div>
        </div>
      </SettingsSection>
    </aside>
  );
}

function SettingsSection({
  title,
  description,
  children
}: PropsWithChildren<{
  title: string;
  description: string;
}>) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  disabled = false
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const id = `${label.toLowerCase().replace(/\s+/g, '-')}-${generatedId}`;
  return (
    <label className="number-field" htmlFor={id}>
      <span>{label}</span>
      <div>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

const WEBHOOK_KEY = 'gifm:webhook:v1';

function WebhookRow({ onSend }: { onSend: (webhookUrl: string) => void }) {
  const [url, setUrl] = useState(() => readStorage<string>(WEBHOOK_KEY) ?? '');
  useEffect(() => {
    writeStorage(WEBHOOK_KEY, url);
  }, [url]);
  return (
    <div className="webhook-row">
      <input
        type="url"
        value={url}
        placeholder={STRINGS.output.webhookPlaceholder}
        aria-label={STRINGS.output.webhookAria}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button type="button" className="secondary-button" disabled={!url.trim()} onClick={() => onSend(url.trim())}>
        {STRINGS.output.sendToDiscord}
      </button>
    </div>
  );
}

function UrlImportRow({ busy, onImport }: { busy: boolean; onImport: (url: string) => void }) {
  const [url, setUrl] = useState('');
  return (
    <div className="url-import">
      <input
        type="url"
        value={url}
        placeholder={STRINGS.input.urlPlaceholder}
        aria-label={STRINGS.input.urlAria}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && url.trim() && !busy) {
            event.preventDefault();
            onImport(url);
          }
        }}
      />
      <button type="button" className="secondary-button" disabled={busy || !url.trim()} onClick={() => onImport(url)}>
        {busy ? <Loader2 className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        {STRINGS.input.importUrl}
      </button>
    </div>
  );
}

function OverlayField({ value, onChange }: { value: OverlaySettings; onChange: (value: OverlaySettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onPick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.set('overlay', file);
      const response = await fetch('/api/overlay', { method: 'POST', body });
      if (!response.ok) {
        throw new Error(await readApiError(response, STRINGS.settings.overlay.uploadFailed));
      }
      const { id } = (await response.json()) as { id: string };
      onChange({ ...value, id, enabled: true });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : STRINGS.settings.overlay.uploadFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-field">
      <ToggleField
        label={STRINGS.settings.overlay.label}
        description={STRINGS.settings.overlay.description}
        checked={value.enabled}
        onChange={(checked) => onChange({ ...value, enabled: checked && Boolean(value.id) })}
      />
      <label className="overlay-pick secondary-button">
        {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
        {value.id ? STRINGS.settings.overlay.replace : STRINGS.settings.overlay.choose}
        <input type="file" accept="image/*" onChange={(event) => onPick(event.target.files?.[0] ?? null)} />
      </label>
      {error ? <p className="profile-note">{error}</p> : null}
      {value.id ? (
        <>
          <label className="select-field">
            <span>{STRINGS.settings.overlay.position}</span>
            <select value={value.position} onChange={(event) => onChange({ ...value, position: event.target.value as OverlayPosition })}>
              <option value="top-left">{STRINGS.settings.overlay.positions.topLeft}</option>
              <option value="top-right">{STRINGS.settings.overlay.positions.topRight}</option>
              <option value="bottom-left">{STRINGS.settings.overlay.positions.bottomLeft}</option>
              <option value="bottom-right">{STRINGS.settings.overlay.positions.bottomRight}</option>
              <option value="center">{STRINGS.settings.overlay.positions.center}</option>
            </select>
          </label>
          <label className="range-field">
            <span>{STRINGS.settings.overlay.size} <strong>{Math.round(value.scale * 100)}%</strong></span>
            <input type="range" min={0.05} max={1} step={0.05} value={value.scale} onChange={(event) => onChange({ ...value, scale: clampNumber(Number(event.target.value), 0.05, 1) })} aria-label={STRINGS.settings.overlay.size} />
          </label>
          <label className="range-field">
            <span>{STRINGS.settings.overlay.opacity} <strong>{Math.round(value.opacity * 100)}%</strong></span>
            <input type="range" min={0.1} max={1} step={0.05} value={value.opacity} onChange={(event) => onChange({ ...value, opacity: clampNumber(Number(event.target.value), 0.1, 1) })} aria-label={STRINGS.settings.overlay.opacity} />
          </label>
        </>
      ) : null}
    </div>
  );
}

function CropRange({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="range-field">
      <span>{label} <strong>{Math.round(value * 100)}%</strong></span>
      <input
        type="range"
        min={0}
        max={max}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
    </label>
  );
}

function CropOverlay({ crop }: { crop: CropRect }) {
  return (
    <div className="crop-overlay" aria-hidden="true">
      <div
        className="crop-region"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
      />
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-box" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function BatchQueue({
  jobs,
  onSelectJob,
  onRevealJob,
  onSaveAs,
  onCancelJob
}: {
  jobs: BatchJob[];
  onSelectJob: (job: Job) => void;
  onRevealJob: (id: string) => void;
  onSaveAs: (job: Job) => void;
  onCancelJob: (id: string) => void;
}) {
  if (!jobs.length) return null;

  const completedIds = jobs
    .filter((item) => item.job?.status === 'complete' && item.job.downloadUrl)
    .map((item) => item.job!.id);

  return (
    <section className="batch-panel" aria-label={STRINGS.batch.aria}>
      <div className="output-title">
        <h3>{STRINGS.batch.title}</h3>
        {completedIds.length > 1 ? (
          <a className="secondary-button" href={`/api/jobs/zip?ids=${completedIds.join(',')}`} download>
            <Download aria-hidden="true" />
            {STRINGS.batch.downloadAll(completedIds.length)}
          </a>
        ) : null}
      </div>
      <div className="batch-list">
        {jobs.map((item) => {
          const itemJob = item.job;
          const canCancelItem = itemJob?.status === 'queued' || itemJob?.status === 'running';
          return (
            <div key={item.localId} className="batch-row">
              <button type="button" className="batch-main" disabled={!itemJob} onClick={() => itemJob && onSelectJob(itemJob)}>
                <strong>{item.inputName}</strong>
                <span>{batchStatus(item)}</span>
              </button>
              <span>{STRINGS.batch.attempts(itemJob?.attempts.length ?? 0)}</span>
              <span>{itemJob?.outputBytes ? `${formatBytes(itemJob.outputBytes)} / ${formatBytes(itemJob.targetBytes)}` : formatBytes(item.inputSize)}</span>
              <div>
                {itemJob?.status === 'complete' && itemJob.downloadUrl ? (
                  <>
                    <a className="secondary-button" href={itemJob.downloadUrl} download>
                      {STRINGS.output.download}
                    </a>
                    <button type="button" className="secondary-button" onClick={() => onRevealJob(itemJob.id)}>
                      {STRINGS.output.open}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => onSaveAs(itemJob)}>
                      {STRINGS.output.saveAs}
                    </button>
                  </>
                ) : canCancelItem ? (
                  <button type="button" className="secondary-button" onClick={() => onCancelJob(itemJob.id)}>
                    {STRINGS.input.cancel}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TimelineEditor({
  settings,
  setSettings,
  sourceMeta,
  probeBusy,
  previewTime,
  onSeekPreview,
  clips,
  selectedClipId,
  onAddClip,
  onUpdateClip,
  onApplyClip,
  onDeleteClip,
  onExportClip,
  onExportAll,
  onPrepareSource,
  sourceSession,
  sourceBusy,
  exportBusy
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  sourceMeta: SourceMeta | null;
  probeBusy: boolean;
  previewTime: number;
  onSeekPreview: (seconds: number) => void;
  clips: TimelineClip[];
  selectedClipId: string;
  onAddClip: () => void;
  onUpdateClip: (id: string) => void;
  onApplyClip: (clip: TimelineClip) => void;
  onDeleteClip: (id: string) => void;
  onExportClip: (clip: TimelineClip) => void;
  onExportAll: () => void;
  onPrepareSource: () => void;
  sourceSession: SourceSession | null;
  sourceBusy: boolean;
  exportBusy: boolean;
}) {
  const duration = Math.max(0.5, sourceMeta?.durationSec ?? settings.startSec + settings.durationSec);
  const start = clampNumber(settings.startSec, 0, Math.max(0, duration - 0.5));
  const end = clampNumber(settings.startSec + settings.durationSec, start + 0.5, duration);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);
  const playhead = clampNumber(previewTime, 0, duration);
  const rangeLeft = `${(start / duration) * 100}%`;
  const rangeWidth = `${Math.max(0.2, ((end - start) / duration) * 100)}%`;
  const playheadLeft = `${(playhead / duration) * 100}%`;

  const setStart = (value: number) => {
    setSettings((current) => {
      const currentEnd = Math.min(duration, current.startSec + current.durationSec);
      const nextStart = clampNumber(value, 0, Math.max(0, currentEnd - 0.5));
      return { ...current, startSec: Number(nextStart.toFixed(2)), durationSec: Number((currentEnd - nextStart).toFixed(2)) };
    });
  };

  const setEnd = (value: number) => {
    setSettings((current) => {
      const nextEnd = clampNumber(value, current.startSec + 0.5, duration);
      return { ...current, durationSec: Number((nextEnd - current.startSec).toFixed(2)) };
    });
  };

  const setStartAndSeek = (value: number) => {
    setStart(value);
    onSeekPreview(value);
  };

  const setEndAndSeek = (value: number) => {
    setEnd(value);
    onSeekPreview(value);
  };

  const setTimecodeStart = (value: number) => {
    setStartAndSeek(value);
  };

  const setTimecodeEnd = (value: number) => {
    setEndAndSeek(value);
  };

  return (
    <section className={`timeline-editor${probeBusy ? ' is-loading' : ''}`} aria-label={STRINGS.timeline.aria} aria-busy={probeBusy}>
      <div className="timeline-head">
        <div className="output-title">
          <Scissors aria-hidden="true" />
          <h3>{probeBusy ? STRINGS.trim.probing : STRINGS.timeline.title}</h3>
        </div>
        <div className="timeline-summary">
          <strong>{formatTimecode(start)} - {formatTimecode(end)}</strong>
          <span>{STRINGS.timeline.durationLabel(formatTimecode(end - start), formatTimecode(duration))}</span>
        </div>
      </div>

      <div className="timeline-rail-wrap">
        <div className="timeline-rail" aria-hidden="true">
          <span className="timeline-selected" style={{ left: rangeLeft, width: rangeWidth }} />
          <span className="timeline-playhead" style={{ left: playheadLeft }} />
          {clips.map((clip) => (
            <span
              key={clip.id}
              className={`timeline-marker${clip.id === selectedClipId ? ' selected' : ''}`}
              style={{
                left: `${(clip.startSec / duration) * 100}%`,
                width: `${Math.max(0.2, (clip.durationSec / duration) * 100)}%`
              }}
              title={`${clip.name}: ${formatTimecode(clip.startSec)} - ${formatTimecode(clip.startSec + clip.durationSec)}`}
            />
          ))}
        </div>
        <div className="timeline-scale">
          <span>{formatTimecode(0)}</span>
          <span>{STRINGS.timeline.playhead(formatTimecode(playhead))}</span>
          <span>{formatTimecode(duration)}</span>
        </div>
      </div>

      <div className="timeline-range-grid">
        <label>
          <span>{STRINGS.trim.startAria}</span>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.05}
            value={start}
            onChange={(event) => setStartAndSeek(Number(event.currentTarget.value))}
            aria-label={STRINGS.trim.startAria}
          />
        </label>
        <label>
          <span>{STRINGS.trim.endAria}</span>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.05}
            value={end}
            onChange={(event) => setEndAndSeek(Number(event.currentTarget.value))}
            aria-label={STRINGS.trim.endAria}
          />
        </label>
      </div>

      <div className="timecode-grid">
        <TimecodeField label={STRINGS.settings.start} value={start} max={Math.max(0, end - 0.5)} onChange={setTimecodeStart} />
        <TimecodeField label={STRINGS.trim.end} value={end} min={start + 0.5} max={duration} onChange={setTimecodeEnd} />
        <NumberField
          label={STRINGS.settings.duration}
          value={Number((end - start).toFixed(2))}
          min={0.5}
          max={60}
          step={0.25}
          suffix={STRINGS.settings.units.seconds}
          onChange={(value) => setEnd(start + value)}
        />
      </div>

      <div className="timeline-actions">
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={() => setStartAndSeek(previewTime)}>
          {STRINGS.trim.useCurrentStart}
        </button>
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={() => setEndAndSeek(previewTime)}>
          {STRINGS.trim.useCurrentEnd}
        </button>
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={() => onSeekPreview(start)}>
          <Play aria-hidden="true" />
          {STRINGS.timeline.previewStart}
        </button>
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={onAddClip}>
          <Scissors aria-hidden="true" />
          {STRINGS.timeline.addClip}
        </button>
        <button type="button" className="secondary-button" disabled={!selectedClip} onClick={() => selectedClip && onUpdateClip(selectedClip.id)}>
          {STRINGS.timeline.updateClip}
        </button>
      </div>

      <div className="metadata-grid" aria-label={STRINGS.trim.metadataAria}>
        <span>
          {STRINGS.trim.duration} <strong>{sourceMeta?.durationSec ? formatSeconds(sourceMeta.durationSec) : STRINGS.diagnostics.emptyValue}</strong>
        </span>
        <span>
          {STRINGS.trim.size} <strong>{sourceMeta?.width && sourceMeta.height ? `${sourceMeta.width}x${sourceMeta.height}` : STRINGS.diagnostics.emptyValue}</strong>
        </span>
        <span>
          {STRINGS.trim.fps} <strong>{sourceMeta?.fps ? sourceMeta.fps.toFixed(2) : STRINGS.diagnostics.emptyValue}</strong>
        </span>
        <span>
          {STRINGS.trim.codec} <strong>{sourceMeta?.codec || STRINGS.diagnostics.emptyValue}</strong>
        </span>
        <span>
          {STRINGS.trim.rotation} <strong>{sourceMeta ? STRINGS.trim.degrees(sourceMeta.rotation) : STRINGS.diagnostics.emptyValue}</strong>
        </span>
        <span>
          {STRINGS.trim.probe} <strong>{sourceProbeLabel(sourceMeta)}</strong>
        </span>
      </div>

      <div className="source-session-row">
        <div>
          <strong>{sourceSession ? STRINGS.timeline.sourceReady : STRINGS.timeline.sourceNotReady}</strong>
          <span>{sourceSession ? STRINGS.timeline.sourceReadyBody(sourceSession.inputName, formatBytes(sourceSession.inputSize)) : STRINGS.timeline.sourceNotReadyBody}</span>
        </div>
        <button type="button" className="secondary-button" disabled={!sourceMeta || sourceBusy} onClick={onPrepareSource}>
          {sourceBusy ? <Loader2 aria-hidden="true" className="spin" /> : <UploadCloud aria-hidden="true" />}
          {sourceBusy ? STRINGS.timeline.preparingSource : sourceSession ? STRINGS.timeline.reprepareSource : STRINGS.timeline.prepareSource}
        </button>
      </div>

      <section className="clip-bin" aria-label={STRINGS.timeline.clipListAria}>
        <div className="clip-bin-head">
          <div>
            <strong>{STRINGS.timeline.clipBinTitle}</strong>
            <span>{clips.length ? STRINGS.timeline.clipCount(clips.length) : STRINGS.timeline.noClips}</span>
          </div>
          <button type="button" className="primary-button" disabled={!clips.length || sourceBusy || exportBusy} onClick={onExportAll}>
            <Wand2 aria-hidden="true" />
            {STRINGS.timeline.exportAll}
          </button>
        </div>
        <div className="clip-list">
          {clips.map((clip) => (
            <div key={clip.id} className={`clip-row${clip.id === selectedClipId ? ' selected' : ''}`}>
              <button type="button" className="clip-main" onClick={() => onApplyClip(clip)}>
                <strong>{clip.name}</strong>
                <span>{formatTimecode(clip.startSec)} - {formatTimecode(clip.startSec + clip.durationSec)} / {formatTimecode(clip.durationSec)}</span>
              </button>
              <button type="button" className="secondary-button" onClick={() => onExportClip(clip)} disabled={sourceBusy || exportBusy}>
                <Wand2 aria-hidden="true" />
                {STRINGS.timeline.exportClip}
              </button>
              <button type="button" className="secondary-button icon-button" aria-label={STRINGS.timeline.deleteClip(clip.name)} onClick={() => onDeleteClip(clip.id)}>
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ))}
          {!clips.length ? (
            <EmptyState icon={<Scissors aria-hidden="true" />} title={STRINGS.timeline.emptyTitle} body={STRINGS.timeline.emptyBody} compact />
          ) : null}
        </div>
      </section>
    </section>
  );
}

function TimecodeField({
  label,
  value,
  min = 0,
  max,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatTimecode(value));

  useEffect(() => {
    setDraft(formatTimecode(value));
  }, [value]);

  const commit = () => {
    const parsed = parseTimecode(draft);
    if (parsed === null) {
      setDraft(formatTimecode(value));
      return;
    }
    onChange(Number(clampNumber(parsed, min, max).toFixed(2)));
  };

  return (
    <label className="timecode-field">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        inputMode="numeric"
        placeholder="0:00:00"
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  );
}

function PreviewPanel({
  file,
  objectUrl,
  job,
  outputFit,
  onReveal,
  onSaveAs,
  onSendWebhook,
  onCopyText,
  onPreviewTime,
  previewSeekTime,
  recentOutputs,
  onRevealRecent,
  onClearRecent,
  crop
}: {
  file: File | null;
  objectUrl: string;
  job: Job | null;
  outputFit: boolean;
  crop: CropRect;
  onReveal: () => void;
  onSaveAs: (job: Job) => void;
  onSendWebhook: (webhookUrl: string) => void;
  onCopyText: (text: string, successMessage: string) => void;
  onPreviewTime: (seconds: number) => void;
  previewSeekTime: number | null;
  recentOutputs: RecentOutput[];
  onRevealRecent: (id: string) => void;
  onClearRecent: () => void;
}) {
  const isGif = file?.type === 'image/gif' || file?.name.toLowerCase().endsWith('.gif');
  const [altText, setAltText] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (job?.status === 'complete') {
      setAltText(defaultAltText(job.inputName));
    }
  }, [job?.id, job?.status, job?.inputName]);

  useEffect(() => {
    if (previewSeekTime === null || !videoRef.current) return;
    const video = videoRef.current;
    const nextTime = clampNumber(previewSeekTime, 0, Number.isFinite(video.duration) ? video.duration : previewSeekTime);
    try {
      video.currentTime = nextTime;
    } catch {
      // Some containers reject seeks until enough metadata is loaded.
    }
  }, [previewSeekTime, objectUrl]);

  return (
    <aside className="preview-panel" aria-label={STRINGS.preview.aria}>
      <div className="panel-heading">
        <Play aria-hidden="true" />
        <div>
          <h2>{STRINGS.preview.title}</h2>
          <p>{file ? file.name : STRINGS.preview.noFile}</p>
        </div>
      </div>

      <div className="preview-box">
        {objectUrl && isGif ? (
          <img src={objectUrl} alt={STRINGS.preview.selectedGifAlt} />
        ) : objectUrl ? (
          <video
            ref={videoRef}
            src={objectUrl}
            controls
            muted
            playsInline
            onLoadedMetadata={(event) => onPreviewTime(event.currentTarget.currentTime)}
            onSeeked={(event) => onPreviewTime(event.currentTarget.currentTime)}
            onTimeUpdate={(event) => onPreviewTime(event.currentTarget.currentTime)}
          />
        ) : (
          <EmptyState icon={<Video aria-hidden="true" />} title={STRINGS.preview.emptyTitle} body={STRINGS.preview.empty} />
        )}
        {objectUrl && crop.enabled ? <CropOverlay crop={crop} /> : null}
      </div>

      <section className="output-box" aria-label={STRINGS.output.aria}>
        <div className="output-title">
          <FileDown aria-hidden="true" />
          <h3>{STRINGS.output.title}</h3>
        </div>
        {job?.status === 'complete' ? (
          <>
            <div className={`fit-line ${outputFit ? 'ok' : 'warn'}`}>
              {outputFit ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              <span>
                {formatBytes(job.outputBytes ?? 0)} / {formatBytes(job.targetBytes)}
              </span>
            </div>
            <p className="muted-text">{outputSuitability(job)}</p>
            <div className="download-grid">
              <a className="primary-button" href={job.downloadUrl} download>
                <Download aria-hidden="true" />
                {STRINGS.output.downloadGif}
              </a>
              <button type="button" className="secondary-button" onClick={onReveal}>
                <MonitorDown aria-hidden="true" />
                {STRINGS.output.openOutput}
              </button>
              <button type="button" className="secondary-button" onClick={() => onSaveAs(job)}>
                <Download aria-hidden="true" />
                {STRINGS.output.saveAs}
              </button>
            </div>
            <label className="alt-field">
              <span>{STRINGS.output.altText}</span>
              <textarea value={altText} rows={2} onChange={(event) => setAltText(event.currentTarget.value)} />
            </label>
            <button type="button" className="secondary-button alt-copy" onClick={() => onCopyText(altText, STRINGS.notices.altTextCopied)}>
              {STRINGS.output.copyAltText}
            </button>
            <WebhookRow onSend={onSendWebhook} />
          </>
        ) : job?.status === 'failed' ? (
          <>
            <p className="error-text">{job.error}</p>
            {job.errorCode ? <p className="muted-text">{STRINGS.output.errorCode(job.errorCode)}</p> : null}
            <p className="muted-text">{STRINGS.output.failedRecovery}</p>
          </>
        ) : job?.status === 'cancelled' ? (
          <p className="muted-text">{STRINGS.output.cancelledRecovery}</p>
        ) : (
          <EmptyState icon={<FileDown aria-hidden="true" />} title={STRINGS.output.emptyTitle} body={STRINGS.output.empty} compact />
        )}
      </section>

      <section className="attempt-box" aria-label={STRINGS.attempts.aria}>
        <h3>{STRINGS.attempts.title}</h3>
        <div className="attempt-list">
          {(job?.attempts ?? []).map((attempt) => (
            <div key={attempt.attempt} className="attempt-row">
              <span>#{attempt.attempt}</span>
              <span>{attempt.width}px</span>
              <span>{attempt.fps} fps</span>
              <span>{attempt.colors} colors</span>
              <span>{attempt.strategy ?? STRINGS.attempts.defaultStrategy}</span>
              <strong>{attempt.outputBytes ? formatBytes(attempt.outputBytes) : STRINGS.attempts.running}</strong>
              {attempt.rejected ? <span className="attempt-rejected">{STRINGS.attempts.rejected}</span> : null}
            </div>
          ))}
          {!job?.attempts.length && (
            <EmptyState icon={<Wand2 aria-hidden="true" />} title={STRINGS.attempts.emptyTitle} body={STRINGS.attempts.empty} compact />
          )}
        </div>
      </section>

      <section className="recent-box" aria-label={STRINGS.recent.aria}>
        <div className="recent-heading">
          <h3>{STRINGS.recent.title}</h3>
          <button type="button" className="text-button" disabled={!recentOutputs.length} onClick={onClearRecent}>
            {STRINGS.recent.clear}
          </button>
        </div>
        <div className="recent-list">
          {recentOutputs.map((item) => (
            <div key={item.id} className="recent-row">
              <div>
                <strong>{item.inputName}</strong>
                <span>
                  {formatBytes(item.outputBytes)} / {formatBytes(item.targetBytes)} - {item.profileLabel}
                </span>
              </div>
              <div>
                <a className="secondary-button" href={item.downloadUrl} download>
                  {STRINGS.output.download}
                </a>
                <button type="button" className="secondary-button" onClick={() => onRevealRecent(item.id)}>
                  {STRINGS.output.open}
                </button>
              </div>
            </div>
          ))}
          {!recentOutputs.length && (
            <EmptyState icon={<ImageIcon aria-hidden="true" />} title={STRINGS.recent.emptyTitle} body={STRINGS.recent.empty} compact />
          )}
        </div>
      </section>
    </aside>
  );
}

function EmptyState({
  icon,
  title,
  body,
  compact = false
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
    </div>
  );
}

function StatusTile({ label, value, tone }: { label: string; value: string; tone: 'cyan' | 'amber' | 'lime' | 'muted' }) {
  return (
    <div className={`status-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProgressPanel({ job }: { job: Job | null }) {
  const progress = Math.max(0, Math.min(100, job?.progress ?? 0));
  return (
    <section className="progress-panel" aria-label={STRINGS.progress.aria}>
      <div>
        <strong>{job?.stage ?? STRINGS.progress.idle}</strong>
        <span>{Math.round(progress)}%</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={job?.stage ?? STRINGS.progress.aria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      {job?.warnings.length ? (
        <ul className="warnings">
          {job.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LogPanel({ job }: { job: Job | null }) {
  const hasLogs = Boolean(job?.logs.length);
  return (
    <section className="log-panel" aria-label={STRINGS.log.aria}>
      <div className="output-title">
        <Terminal aria-hidden="true" />
        <h3>{STRINGS.log.title}</h3>
      </div>
      {hasLogs ? (
        <pre>{job?.logs.join('\n')}</pre>
      ) : (
        <div className="log-empty">
          <EmptyState icon={<Terminal aria-hidden="true" />} title={STRINGS.log.emptyTitle} body={STRINGS.log.empty} compact />
        </div>
      )}
    </section>
  );
}

function DiagnosticsPanel({
  health,
  sourceMeta,
  settings,
  job,
  onCopyText
}: {
  health: HealthInfo | null;
  sourceMeta: SourceMeta | null;
  settings: Settings;
  job: Job | null;
  onCopyText: (text: string, successMessage: string) => void;
}) {
  const latestCommand = job?.commands?.at(-1);
  const diagnostic = useMemo(() => ({
    generatedAt: new Date().toISOString(),
    health,
    sourceMeta,
    estimate: sourceMeta ? {
      outputBytes: estimateOutputBytes(settings, sourceMeta),
      targetBytes: settings.targetMb * 1024 * 1024
    } : null,
    settings,
    job
  }), [health, sourceMeta, settings, job]);
  const json = useMemo(() => JSON.stringify(diagnostic, null, 2), [diagnostic]);

  return (
    <section className="diagnostics-panel" aria-label={STRINGS.diagnostics.aria}>
      <div className="output-title">
        <Terminal aria-hidden="true" />
        <h3>{STRINGS.diagnostics.title}</h3>
      </div>
      <div className="diagnostic-grid">
        <span>{STRINGS.diagnostics.ffmpeg} <strong>{health?.ffmpeg.version ?? STRINGS.diagnostics.unknown}</strong></span>
        <span>{STRINGS.diagnostics.ffprobe} <strong>{health?.ffprobe.version ?? STRINGS.diagnostics.unknown}</strong></span>
        <span>{STRINGS.diagnostics.encoder} <strong>{encoderHealthLabel(settings, health)}</strong></span>
        <span>{STRINGS.diagnostics.optimizer} <strong>{optimizerHealthLabel(health)}</strong></span>
        <span>{STRINGS.diagnostics.platform} <strong>{health ? `${health.platform.os}/${health.platform.arch}` : STRINGS.diagnostics.unknown}</strong></span>
        <span>{STRINGS.diagnostics.estimate} <strong>{sourceMeta ? formatBytes(estimateOutputBytes(settings, sourceMeta)) : STRINGS.diagnostics.emptyValue}</strong></span>
      </div>
      <details className="command-details">
        <summary>{STRINGS.diagnostics.latestCommand}</summary>
        <pre>{latestCommand?.command ?? STRINGS.diagnostics.noCommand}</pre>
      </details>
      <div className="diagnostic-actions">
        <button type="button" className="secondary-button" onClick={() => onCopyText(json, STRINGS.notices.diagnosticsCopied)}>
          {STRINGS.diagnostics.copyJson}
        </button>
        <button type="button" className="secondary-button" onClick={() => downloadDiagnosticJson(json)}>
          {STRINGS.diagnostics.downloadJson}
        </button>
      </div>
    </section>
  );
}

function formatBytes(bytes: number) {
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

function estimateOutputBytes(settings: Settings, sourceMeta: SourceMeta) {
  const duration = Math.max(0.5, Math.min(settings.durationSec, sourceMeta.durationSec ?? settings.durationSec));
  const sourceWidth = sourceMeta.width ?? settings.width;
  const sourceHeight = sourceMeta.height ?? settings.width;
  const scale = settings.width / Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight * scale);
  const playbackFactor = settings.playback === 'boomerang' ? 2 : 1;
  const frames = Math.max(1, (duration / Math.max(0.25, settings.speed)) * settings.fps * playbackFactor);
  const paletteFactor = clampNumber(settings.colors / 256, 0.15, 1);
  return Math.round(settings.width * height * frames * 0.18 * paletteFactor);
}

function optimizerHealthLabel(health: HealthInfo | null) {
  if (!health) return STRINGS.diagnostics.unknown;
  if (health.gifsicle?.available) return `gifsicle ${health.gifsicle.version}`;
  return STRINGS.diagnostics.optimizerUnavailable;
}

function downloadDiagnosticJson(json: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gifm-diagnostics-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function encoderHealthLabel(settings: Settings, health: HealthInfo | null) {
  if (settings.encoderBackend === 'ffmpeg') return STRINGS.settings.encoderOptions.ffmpeg;
  if (health?.gifski?.available) return `gifski ${health.gifski.version}`;
  return STRINGS.settings.encoderNotes.gifskiUnavailable;
}

function sourceProbeLabel(sourceMeta: SourceMeta | null) {
  if (!sourceMeta) return STRINGS.diagnostics.emptyValue;
  if (sourceMeta.probeSource === 'client') {
    return sourceMeta.frameSampled ? STRINGS.trim.clientFrame : STRINGS.trim.clientMetadata;
  }
  if (sourceMeta.probeSource === 'server') return STRINGS.trim.serverProbe;
  return STRINGS.diagnostics.emptyValue;
}

function formatRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return STRINGS.diagnostics.emptyValue;
  if (ratio < 0.1) return STRINGS.format.tinyRatio;
  return `${ratio.toFixed(1)}x`;
}

function profileFor(preset: TargetPreset) {
  return TARGET_PROFILES.find((profile) => profile.id === preset) ?? TARGET_PROFILES[0];
}

function outputSuitability(job: Job) {
  const profile = profileFor(job.settings.targetPreset);
  if ((job.outputBytes ?? 0) <= job.targetBytes) {
    return STRINGS.output.fitsProfile(profile.label, profile.description);
  }

  return STRINGS.output.overProfile(profile.label, nextCompressionLever(job));
}

function nextCompressionLever(job: Job) {
  const settings = job.settings;
  if (settings.width > 360) return STRINGS.output.levers.width;
  if (settings.fps > 10) return STRINGS.output.levers.fps;
  if (settings.colors > 64) return STRINGS.output.levers.colors;
  if (!settings.allowTrim && settings.durationSec > 2) return STRINGS.output.levers.trim;
  if (settings.durationSec > 1) return STRINGS.output.levers.shorter;
  return STRINGS.output.levers.smallerTarget;
}

async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message ?? fallback;
}

async function fetchJob(id: string) {
  const response = await fetch(`/api/jobs/${id}`);
  if (!response.ok) {
    throw new Error(await readApiError(response, `${STRINGS.errors.statusFailed} (${response.status})`));
  }
  return response.json() as Promise<Job>;
}

async function saveJobOutput(job: Job) {
  if (!job.downloadUrl) throw new Error(STRINGS.errors.outputUnavailable);
  const response = await fetch(job.downloadUrl);
  if (!response.ok) {
    throw new Error(await readApiError(response, STRINGS.errors.downloadFailed));
  }

  const blob = await response.blob();
  const format = job.settings.format;
  const ext = format === 'apng' ? 'png' : format === 'webp' ? 'webp' : format === 'mp4' ? 'mp4' : 'gif';
  const suggestedName = `${safeFileBase(job.inputName)}-gifm.${ext}`;
  const fileType: { description: string; accept: Record<string, string[]> } =
    format === 'apng'
      ? { description: STRINGS.files.apngDescription, accept: { 'image/apng': ['.png'] } }
      : format === 'webp'
        ? { description: STRINGS.files.webpDescription, accept: { 'image/webp': ['.webp'] } }
        : format === 'mp4'
          ? { description: STRINGS.files.mp4Description, accept: { 'video/mp4': ['.mp4'] } }
          : { description: STRINGS.files.gifDescription, accept: { 'image/gif': ['.gif'] } };
  const saveWindow = window as SavePickerWindow;
  if (!saveWindow.showSaveFilePicker) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  const handle = await saveWindow.showSaveFilePicker({
    id: 'gifm-output',
    suggestedName,
    types: [fileType]
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function safeFileBase(inputName: string) {
  return inputName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gifm-output';
}

function batchStatus(item: BatchJob) {
  if (item.error) return item.error;
  if (!item.job) return item.status === 'failed' ? STRINGS.batch.failedSubmit : STRINGS.batch.pending;
  if (item.job.status === 'queued') return STRINGS.batch.queued(item.job.queuePosition ?? 1);
  if (item.job.status === 'running') return item.job.stage;
  if (item.job.status === 'complete') return STRINGS.batch.complete;
  if (item.job.status === 'cancelled') return STRINGS.batch.cancelled;
  return item.job.error ?? STRINGS.batch.failed;
}

function isTerminalJob(job: Job) {
  return job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled';
}

function queueLabel(job: Job | null) {
  if (!job) return STRINGS.diagnostics.emptyValue;
  if (job.status === 'queued') return `#${job.queuePosition ?? 1}`;
  if (job.status === 'running') return STRINGS.queueStatus.running;
  if (job.status === 'cancelled') return STRINGS.queueStatus.cancelled;
  if (job.status === 'failed') return STRINGS.queueStatus.failed;
  return STRINGS.queueStatus.done;
}

function defaultAltText(inputName: string) {
  const base = inputName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return base ? STRINGS.alt.fromName(base) : STRINGS.alt.default;
}

function recentFromJob(job: Job): RecentOutput {
  return {
    id: job.id,
    inputName: job.inputName,
    outputBytes: job.outputBytes ?? 0,
    targetBytes: job.targetBytes,
    profileLabel: profileFor(job.settings.targetPreset).label,
    downloadUrl: job.downloadUrl ?? '',
    completedAt: job.completedAt ?? new Date().toISOString()
  };
}

function makeTimelineClip(index: number, settings: Settings): TimelineClip {
  return {
    id: crypto.randomUUID(),
    name: STRINGS.timeline.defaultClipName(index),
    startSec: Number(settings.startSec.toFixed(2)),
    durationSec: Number(settings.durationSec.toFixed(2)),
    createdAt: new Date().toISOString()
  };
}

function clipSettings(settings: Settings, clip: TimelineClip): Settings {
  return {
    ...settings,
    startSec: clip.startSec,
    durationSec: clip.durationSec
  };
}

function loadSettings() {
  return normalizeSettings(readStorage<Partial<Settings>>(SETTINGS_KEY) ?? DEFAULT_SETTINGS);
}

function loadTheme(): Theme {
  const stored = readStorage<Theme>(THEME_KEY);
  if (stored === 'dark' || stored === 'light' || stored === 'high-contrast') return stored;
  // First load with no stored choice: respect the OS preference.
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function loadLocale(): Locale {
  const stored = readStorage<Locale>(LOCALE_KEY);
  const locale: Locale = stored && LOCALE_LABELS[stored] ? stored : 'en';
  // Apply before the first render reads STRINGS so the initial paint is already localized.
  setActiveLocale(locale);
  return locale;
}

function loadPresets() {
  return (readStorage<SavedPreset[]>(PRESETS_KEY) ?? [])
    .filter((preset) => preset?.id && preset?.name && preset?.settings)
    .map((preset) => ({ ...preset, settings: normalizeSettings(preset.settings) }))
    .slice(0, 20);
}

function loadRecentOutputs() {
  return (readStorage<RecentOutput[]>(RECENTS_KEY) ?? [])
    .filter((item) => item?.id && item?.downloadUrl && item?.inputName)
    .slice(0, MAX_RECENT_OUTPUTS);
}

function normalizeSettings(value: Partial<Settings>): Settings {
  const preset = TARGET_PROFILES.some((profile) => profile.id === value.targetPreset) ? value.targetPreset as TargetPreset : DEFAULT_SETTINGS.targetPreset;
  const profile = profileFor(preset);
  const targetMb = preset === 'custom'
    ? clampNumber(Number(value.targetMb ?? DEFAULT_SETTINGS.targetMb), 0.05, 500)
    : profile.targetMb;

  return {
    targetPreset: preset,
    targetMb,
    width: evenNumber(clampNumber(Number(value.width ?? DEFAULT_SETTINGS.width), 120, 1280)),
    fps: clampNumber(Number(value.fps ?? DEFAULT_SETTINGS.fps), 5, 30),
    startSec: clampNumber(Number(value.startSec ?? DEFAULT_SETTINGS.startSec), 0, MAX_TRIM_START_SEC),
    durationSec: clampNumber(Number(value.durationSec ?? DEFAULT_SETTINGS.durationSec), 0.5, 60),
    colors: clampNumber(Number(value.colors ?? DEFAULT_SETTINGS.colors), 16, 256),
    dither: isDitherMode(value.dither) ? value.dither : DEFAULT_SETTINGS.dither,
    bayerScale: Math.round(clampNumber(Number(value.bayerScale ?? DEFAULT_SETTINGS.bayerScale), 0, 5)),
    paletteMode: isPaletteMode(value.paletteMode) ? value.paletteMode : DEFAULT_SETTINGS.paletteMode,
    encoderBackend: isEncoderBackend(value.encoderBackend) ? value.encoderBackend : DEFAULT_SETTINGS.encoderBackend,
    autoFit: Boolean(value.autoFit ?? DEFAULT_SETTINGS.autoFit),
    allowTrim: Boolean(value.allowTrim ?? DEFAULT_SETTINGS.allowTrim),
    optimize: Boolean(value.optimize ?? DEFAULT_SETTINGS.optimize),
    gifskiQuality: Math.round(clampNumber(Number(value.gifskiQuality ?? DEFAULT_SETTINGS.gifskiQuality), 1, 100)),
    loopCount: normalizeLoopCount(value.loopCount),
    speed: clampNumber(Number(value.speed ?? DEFAULT_SETTINGS.speed), 0.25, 8),
    playback: isPlayback(value.playback) ? value.playback : DEFAULT_SETTINGS.playback,
    crop: normalizeCrop(value.crop),
    format: value.format === 'apng' || value.format === 'webp' || value.format === 'mp4' ? value.format : 'gif',
    caption: normalizeCaption(value.caption),
    overlay: normalizeOverlay(value.overlay),
    rotate: ([0, 90, 180, 270] as const).includes(value.rotate as Rotation) ? (value.rotate as Rotation) : 0,
    flipH: Boolean(value.flipH),
    flipV: Boolean(value.flipV),
    colorFilter: (['none', 'grayscale', 'invert', 'sepia'] as const).includes(value.colorFilter as ColorFilter) ? (value.colorFilter as ColorFilter) : 'none',
    saturation: clampNumber(Number(value.saturation ?? 1), 0, 3)
  };
}

function isDitherMode(value: unknown): value is DitherMode {
  return value === 'sierra2_4a' || value === 'bayer' || value === 'floyd_steinberg' || value === 'none';
}

function isPaletteMode(value: unknown): value is PaletteMode {
  return value === 'diff' || value === 'full' || value === 'single';
}

function isEncoderBackend(value: unknown): value is EncoderBackend {
  return value === 'ffmpeg' || value === 'gifski';
}

function isPlayback(value: unknown): value is Playback {
  return value === 'normal' || value === 'reverse' || value === 'boomerang';
}

function normalizeOverlay(value: unknown): OverlaySettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<OverlaySettings>;
  const positions: OverlayPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  const id = typeof raw.id === 'string' ? raw.id : '';
  return {
    enabled: Boolean(raw.enabled) && Boolean(id),
    id,
    position: positions.includes(raw.position as OverlayPosition) ? (raw.position as OverlayPosition) : 'bottom-right',
    scale: clampNumber(Number(raw.scale ?? 0.25), 0.05, 1),
    opacity: clampNumber(Number(raw.opacity ?? 1), 0.1, 1)
  };
}

function normalizeCaption(value: unknown): { top: string; bottom: string } {
  const raw = (value && typeof value === 'object' ? value : {}) as { top?: unknown; bottom?: unknown };
  const clean = (text: unknown) => String(text ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120);
  return { top: clean(raw.top), bottom: clean(raw.bottom) };
}

function normalizeCrop(value: unknown): CropRect {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<CropRect>;
  const x = clampNumber(Number(raw.x ?? 0), 0, 0.95);
  const y = clampNumber(Number(raw.y ?? 0), 0, 0.95);
  const w = clampNumber(Number(raw.w ?? 1), 0.05, 1 - x);
  const h = clampNumber(Number(raw.h ?? 1), 0.05, 1 - y);
  const enabled = Boolean(raw.enabled) && (x > 0 || y > 0 || w < 1 || h < 1);
  return { enabled, x, y, w, h };
}

function normalizeLoopCount(value: unknown): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.loopCount;
  if (number <= -1) return -1;
  return clampNumber(number, 0, 1000);
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage can be disabled; the app still works without persistence.
  }
}

function clampTrimToDuration(settings: Settings, durationSec: number): Settings {
  const startSec = clampNumber(settings.startSec, 0, Math.max(0, durationSec - 0.5));
  const duration = clampNumber(settings.durationSec, 0.5, Math.max(0.5, durationSec - startSec));
  return {
    ...settings,
    startSec: Number(startSec.toFixed(2)),
    durationSec: Number(duration.toFixed(2))
  };
}

function clampNumber(value: number, min: number, max: number) {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
}

function evenNumber(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return STRINGS.format.zeroSeconds;
  if (seconds < 60) return STRINGS.format.seconds(seconds.toFixed(2));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return STRINGS.format.minuteSeconds(minutes, rest.toFixed(0).padStart(2, '0'));
}

function formatTimecode(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00:00';
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const wholeSeconds = rounded % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
}

function parseTimecode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts.map(Number) : [0, ...parts.map(Number)];
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}
