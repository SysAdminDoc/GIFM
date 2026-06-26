import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Download,
  FileDown,
  Gauge,
  Image as ImageIcon,
  Loader2,
  MonitorDown,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Terminal,
  Trash2,
  UploadCloud,
  Video,
  Wand2
} from 'lucide-react';
import { SettingsPanel, WebhookRow, UrlImportRow, NumberField } from './components/SettingsPanel';
import { clampNumber, evenNumber, formatBytes, profileFor, normalizeCrop, normalizeLoopCount, readStorage, writeStorage, readApiError, uploadWithProgress, formatTimecode } from './utils';
import {
  Component,
  type ChangeEvent,
  type DragEvent,
  type ErrorInfo,
  type FormEvent,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { probeClientMedia } from './clientPreflight';
import { usePollJobs } from './jobPolling';
import { STRINGS, setActiveLocale, LOCALE_LABELS, type Locale } from './strings';
import {
  TARGET_PROFILES,
  type TargetPreset,
  type DitherMode,
  type PaletteMode,
  type EncoderBackend,
  type OutputFormat,
  type Theme,
  type Playback,
  type CropRect,
  type Rotation,
  type ColorFilter,
  type OverlayPosition,
  type OverlaySettings,
  type Settings,
  type Job,
  type SourceMeta,
  type HealthInfo,
  type SavedPreset,
  type RecentOutput,
  type BatchJob,
  type SourceSession,
  type TimelineClip,
  type LoopCandidate,
  type ExtractedFrame,
  type FrameManifest,
  type SavePickerWindow,
  type ApiErrorPayload
} from './types';

const VERSION = '0.5.1';
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
  perFramePalette: false,
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
  saturation: 1,
  gifsicleColorSpace: 'srgb',
  gifsicleOptDither: 'none',
  subtitleId: '',
  borderRadius: 0
};

const SETTINGS_KEY = 'gifm:settings:v1';
const PRESETS_KEY = 'gifm:presets:v1';
const RECENTS_KEY = 'gifm:recents:v1';
const THEME_KEY = 'gifm:theme:v1';
const LOCALE_KEY = 'gifm:locale:v1';
const CLIPS_KEY = 'gifm:clips:v1';
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
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  const [sourceSession, setSourceSession] = useState<SourceSession | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [loopCandidates, setLoopCandidates] = useState<LoopCandidate[]>([]);
  const [loopBusy, setLoopBusy] = useState(false);
  const [frameManifest, setFrameManifest] = useState<FrameManifest | null>(null);
  const [editedFrames, setEditedFrames] = useState<ExtractedFrame[]>([]);
  const [frameBusy, setFrameBusy] = useState(false);
  const [timelineClips, setTimelineClips] = useState<TimelineClip[]>(() => loadTimelineClips());
  const [selectedClipId, setSelectedClipId] = useState('');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewSeekTime, setPreviewSeekTime] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragFrameRef = useRef<number | null>(null);

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
    writeStorage(CLIPS_KEY, timelineClips);
  }, [timelineClips]);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => setHealth(payload as HealthInfo | null))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    // Pick up a file staged by the desktop "Make GIF with GIFM" shell verb.
    fetch('/api/pending-import')
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        const prepared = payload?.source as SourceSession | undefined;
        if (!prepared) return;
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
      })
      .catch(() => undefined);
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
      setFrameManifest(null);
      setEditedFrames([]);
      setLoopCandidates([]);
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

  // A single polling hook drives both the active single job and any running batch jobs.
  const activePollIds = useMemo(() => {
    const ids = new Set<string>();
    if (job && !isTerminalJob(job)) ids.add(job.id);
    for (const item of batchJobs) {
      if (item.job && !isTerminalJob(item.job)) ids.add(item.job.id);
    }
    return [...ids];
  }, [job, batchJobs]);

  usePollJobs(activePollIds, (updates) => {
    const byId = new Map(updates.map((update) => [update.id, update]));
    setJob((current) => (current && byId.has(current.id) ? byId.get(current.id)! : current));
    setBatchJobs((current) => current.map((item) => (item.job && byId.has(item.job.id) ? { ...item, job: byId.get(item.job.id)! } : item)));
  });

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

  useEffect(() => {
    // Paste an image/video (e.g. a copied screenshot) anywhere outside a text field to load it.
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const pasted = Array.from(event.clipboardData?.files ?? []).filter((item) => item.type.startsWith('image/') || item.type.startsWith('video/'));
      if (pasted.length) {
        event.preventDefault();
        chooseFiles(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [chooseFiles]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files.length) {
      chooseFiles(event.dataTransfer.files);
      return;
    }
    // A drag from a browser tab carries a URL rather than a file; route it through the URL importer.
    const uri = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).trim();
    if (/^https?:\/\//i.test(uri)) {
      void importFromUrl(uri);
    }
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

        setUploadProgress(0);
        const response = await uploadWithProgress('/api/jobs', body, (percent) => setUploadProgress(percent));
        setUploadProgress(null);

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
      setUploadProgress(null);
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

  const importTimelineClip = (name: string, startSec: number, durationSec: number) => {
    const clip: TimelineClip = {
      id: crypto.randomUUID(),
      name,
      startSec,
      durationSec,
      createdAt: new Date().toISOString()
    };
    setTimelineClips((current) => [...current, clip]);
    setNotice(STRINGS.notices.clipAdded(name));
  };

  const findLoops = async () => {
    if (!sourceSession || loopBusy) return;
    setLoopBusy(true);
    setLoopCandidates([]);
    try {
      const response = await fetch(`/api/sources/${sourceSession.id}/loops`);
      if (!response.ok) {
        setNotice(await readApiError(response, STRINGS.errors.probeFailed));
        return;
      }
      const data = await response.json();
      setLoopCandidates(data.loops ?? []);
      if (!data.loops?.length) setNotice(STRINGS.notices.noLoopsFound);
    } catch {
      setNotice(STRINGS.errors.probeFailed);
    } finally {
      setLoopBusy(false);
    }
  };

  const extractFrames = async () => {
    if (!sourceSession || frameBusy) return;
    setFrameBusy(true);
    try {
      const response = await fetch(`/api/sources/${sourceSession.id}/frames`, { method: 'POST' });
      if (!response.ok) {
        setNotice(await readApiError(response, STRINGS.errors.probeFailed));
        return;
      }
      const manifest = await response.json() as FrameManifest;
      setFrameManifest(manifest);
      setEditedFrames([...manifest.frames]);
    } catch {
      setNotice(STRINGS.errors.probeFailed);
    } finally {
      setFrameBusy(false);
    }
  };

  const encodeEditedFrames = async () => {
    if (!sourceSession || !frameManifest || editedFrames.length < 2 || frameBusy) return;
    setFrameBusy(true);
    try {
      const response = await fetch('/api/frames/encode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: sourceSession.id,
          frameId: frameManifest.frameId,
          frames: editedFrames.map((f) => ({ index: f.index, delayCentiseconds: f.delayCentiseconds })),
          settings
        })
      });
      if (response.ok) {
        const result = await response.json() as Job;
        setJob(result);
        setNotice(STRINGS.notices.encodingStarted);
      } else {
        setNotice(await readApiError(response, STRINGS.errors.encodeStartFailed));
      }
    } catch {
      setNotice(STRINGS.errors.encodeStartFailed);
    } finally {
      setFrameBusy(false);
    }
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

  const importPresets = (incoming: SavedPreset[]) => {
    setSavedPresets((current) => {
      const nameSet = new Set(current.map((p) => p.name.toLowerCase()));
      const fresh = incoming.filter((p) => !nameSet.has(p.name.toLowerCase())).map((p) => ({ ...p, id: crypto.randomUUID() }));
      return [...fresh, ...current].slice(0, 50);
    });
    setNotice(STRINGS.notices.presetsImported(incoming.length));
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
          onImportPresets={importPresets}
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
            <StatusTile icon={<Gauge aria-hidden="true" />} label={STRINGS.target.title} value={formatBytes(targetBytes)} tone="cyan" />
            <StatusTile icon={<Video aria-hidden="true" />} label={STRINGS.input.sourceRatio} value={file ? formatRatio(originalRatio) : STRINGS.diagnostics.emptyValue} tone="amber" />
            <StatusTile icon={<CheckCircle2 aria-hidden="true" />} label={STRINGS.settings.autoFit.label} value={settings.autoFit ? STRINGS.settings.autoFit.on : STRINGS.settings.autoFit.off} tone={settings.autoFit ? 'lime' : 'muted'} />
            <StatusTile icon={<Terminal aria-hidden="true" />} label={STRINGS.input.queue} value={queueLabel(job)} tone={job?.status === 'queued' ? 'amber' : 'muted'} />
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
            onImportClip={importTimelineClip}
            onPrepareSource={() => {
              void prepareSource().catch((error) => setNotice(error instanceof Error ? error.message : STRINGS.errors.sourcePrepareFailed));
            }}
            onFindLoops={findLoops}
            loopCandidates={loopCandidates}
            loopBusy={loopBusy}
            sourceSession={sourceSession}
            sourceBusy={sourceBusy}
            exportBusy={busy}
          />

          <section className="frame-editor" aria-label={STRINGS.timeline.frameEditor}>
            <div className="frame-editor-head">
              <h3>{STRINGS.timeline.frameEditor}</h3>
              <span>{editedFrames.length > 0 ? STRINGS.timeline.frameCount(editedFrames.length) : ''}</span>
              <button type="button" className="secondary-button" disabled={!sourceSession || frameBusy} onClick={extractFrames}>
                {frameBusy ? <Loader2 className="spin" aria-hidden="true" /> : <Scissors aria-hidden="true" />}
                {frameBusy ? STRINGS.timeline.extracting : STRINGS.timeline.extractFrames}
              </button>
              {editedFrames.length >= 2 ? (
                <button type="button" className="primary-button" disabled={frameBusy} onClick={encodeEditedFrames}>
                  <Wand2 aria-hidden="true" />
                  {STRINGS.timeline.encodeFrames}
                </button>
              ) : null}
            </div>
            {editedFrames.length > 0 ? (
              <div className="frame-strip">
                {editedFrames.map((frame, arrayIndex) => (
                  <div
                    key={`frame-${frame.index}`}
                    className="frame-card"
                    draggable
                    onDragStart={() => { dragFrameRef.current = arrayIndex; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      const from = dragFrameRef.current;
                      if (from === null || from === arrayIndex) return;
                      setEditedFrames((prev) => {
                        const next = [...prev];
                        const [moved] = next.splice(from, 1);
                        next.splice(arrayIndex, 0, moved);
                        return next;
                      });
                      dragFrameRef.current = null;
                    }}
                    onDragEnd={() => { dragFrameRef.current = null; }}
                  >
                    <img src={frame.url} alt={STRINGS.timeline.frameCount(frame.index + 1)} />
                    <div className="frame-controls">
                      <label>
                        <span>{STRINGS.timeline.delayLabel}</span>
                        <input
                          type="number"
                          min={1}
                          max={1000}
                          step={1}
                          value={frame.delayCentiseconds}
                          onChange={(e) => {
                            const delay = Math.max(1, Math.min(1000, Math.round(Number(e.target.value))));
                            const idx = frame.index;
                            setEditedFrames((prev) => prev.map((f) => f.index === idx ? { ...f, delayCentiseconds: delay } : f));
                          }}
                        />
                      </label>
                      <button type="button" className="secondary-button" onClick={() => setEditedFrames((prev) => prev.filter((f) => f.index !== frame.index))}>
                        <Trash2 size={14} aria-hidden="true" />
                        {STRINGS.timeline.deleteFrame}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-text">{STRINGS.timeline.noFrames}</p>
            )}
          </section>

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
            {sourceMeta && !uploadProgress ? (
              <span className={`estimate-chip ${estimateOutputBytes(settings, sourceMeta) <= targetBytes ? 'ok' : 'warn'}`}>
                ~{formatBytes(estimateOutputBytes(settings, sourceMeta))}
              </span>
            ) : null}
            <span className="notice" aria-live="polite">
              {uploadProgress !== null ? `Uploading ${uploadProgress}%` : notice}
            </span>
            {uploadProgress !== null ? (
              <div className="upload-progress" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
            ) : null}
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
  onImportClip,
  onPrepareSource,
  onFindLoops,
  loopCandidates,
  loopBusy,
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
  onImportClip: (name: string, startSec: number, durationSec: number) => void;
  onPrepareSource: () => void;
  onFindLoops: () => void;
  loopCandidates: LoopCandidate[];
  loopBusy: boolean;
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
        <button type="button" className="secondary-button" disabled={!sourceSession || loopBusy} onClick={onFindLoops}>
          {loopBusy ? <Loader2 className="spin" aria-hidden="true" /> : null}
          {STRINGS.timeline.findLoops}
        </button>
      </div>

      {loopCandidates.length > 0 ? (
        <div className="loop-suggestions">
          <strong>{STRINGS.timeline.loopSuggestions}</strong>
          {loopCandidates.map((c, i) => (
            <button key={i} type="button" className="secondary-button" onClick={() => {
              setSettings((current) => ({ ...current, startSec: 0, durationSec: c.timeSec }));
              onSeekPreview(c.timeSec);
            }}>
              {formatTimecode(c.timeSec)} ({Math.round(c.ssim * 100)}%)
            </button>
          ))}
        </div>
      ) : null}

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
          <button type="button" className="secondary-button" disabled={!clips.length} onClick={() => {
            const header = 'name,startSec,endSec,durationSec';
            const rows = clips.map((c) => `${c.name},${c.startSec},${(c.startSec + c.durationSec).toFixed(2)},${c.durationSec}`);
            const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'gifm-clips.csv';
            a.click();
            URL.revokeObjectURL(a.href);
          }}>
            {STRINGS.timeline.exportCsv}
          </button>
          <button type="button" className="secondary-button" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const lines = text.trim().split(/\r?\n/).slice(1);
                for (const line of lines) {
                  const [name, startStr, , durStr] = line.split(',');
                  if (!name || !startStr || !durStr) continue;
                  const startSec = Number(startStr);
                  const durationSec = Number(durStr);
                  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) continue;
                  onImportClip(name.trim(), startSec, durationSec);
                }
              } catch {
                // Silently reject malformed CSV.
              }
            };
            input.click();
          }}>
            {STRINGS.timeline.importCsv}
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
        aria-label={label}
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
  const [outputPaused, setOutputPaused] = useState(false);
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

  const cropStyle: React.CSSProperties | undefined = crop.enabled
    ? { objectViewBox: `inset(${crop.y * 100}% ${(1 - crop.x - crop.w) * 100}% ${(1 - crop.y - crop.h) * 100}% ${crop.x * 100}%)` }
    : undefined;

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
          <img src={objectUrl} alt={STRINGS.preview.selectedGifAlt} style={cropStyle} />
        ) : objectUrl ? (
          <video
            ref={videoRef}
            src={objectUrl}
            controls
            muted
            playsInline
            style={cropStyle}
            onLoadedMetadata={(event) => onPreviewTime(event.currentTarget.currentTime)}
            onSeeked={(event) => onPreviewTime(event.currentTarget.currentTime)}
            onTimeUpdate={(event) => onPreviewTime(event.currentTarget.currentTime)}
          />
        ) : (
          <EmptyState icon={<Video aria-hidden="true" />} title={STRINGS.preview.emptyTitle} body={STRINGS.preview.empty} />
        )}
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
            {job.outputMeta ? (
              <p className="muted-text">
                {job.outputMeta.width}x{job.outputMeta.height}{job.outputMeta.durationSec ? `, ${job.outputMeta.durationSec.toFixed(1)}s` : ''}{job.outputMeta.fps ? `, ${job.outputMeta.fps.toFixed(0)} fps` : ''}{job.ssim != null ? ` · ${Math.round(job.ssim * 100)}% quality` : ''}
              </p>
            ) : null}
            {job.discordChecks && job.discordChecks.length > 0 ? (
              <ul className="discord-checks" role="list">
                {job.discordChecks.map((check, i) => (
                  <li key={i} className={check.pass ? 'check-pass' : 'check-fail'}>
                    {check.pass ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                    <span>{check.label}: {check.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="output-preview">
              {job.settings.format === 'mp4' ? (
                <video src={job.downloadUrl} controls muted loop playsInline />
              ) : (
                <img src={outputPaused ? undefined : job.downloadUrl} alt={STRINGS.output.outputPreviewAlt} />
              )}
              {job.settings.format !== 'mp4' ? (
                <button type="button" className="secondary-button output-pause" onClick={() => setOutputPaused((p) => !p)}>
                  {outputPaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                  {outputPaused ? 'Play' : 'Pause'}
                </button>
              ) : null}
            </div>
            <div className="download-grid">
              <a className="primary-button" href={job.downloadUrl} download>
                <Download aria-hidden="true" />
                {STRINGS.output.downloadFormats[job.settings.format]}
              </a>
              <button type="button" className="secondary-button" onClick={onReveal}>
                <MonitorDown aria-hidden="true" />
                {STRINGS.output.openOutput}
              </button>
              <button type="button" className="secondary-button" onClick={() => onSaveAs(job)}>
                <Download aria-hidden="true" />
                {STRINGS.output.saveAs}
              </button>
              <button type="button" className="secondary-button" onClick={async () => {
                try {
                  if (!job.downloadUrl) return;
                  const res = await fetch(job.downloadUrl);
                  const blob = await res.blob();
                  const mime = blob.type.startsWith('image/') ? blob.type : 'image/gif';
                  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
                  onCopyText('', 'Copied to clipboard');
                } catch {
                  onCopyText('', 'Clipboard copy not supported in this browser');
                }
              }}>
                <ClipboardCopy aria-hidden="true" />
                Copy
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

function StatusTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: 'cyan' | 'amber' | 'lime' | 'muted' }) {
  return (
    <div className={`status-tile ${tone}`}>
      <span className="status-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    </div>
  );
}

function ProgressPanel({ job }: { job: Job | null }) {
  const progress = Math.max(0, Math.min(100, job?.progress ?? 0));
  const isActive = job?.status === 'running' || job?.status === 'queued';
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) { startRef.current = null; setElapsed(0); return undefined; }
    if (!startRef.current) startRef.current = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const eta = isActive && progress > 3 && elapsed > 2
    ? Math.round((elapsed / progress) * (100 - progress))
    : null;

  return (
    <section className="progress-panel" aria-label={STRINGS.progress.aria}>
      <div>
        <strong>{job?.stage ?? STRINGS.progress.idle}</strong>
        <span>
          {Math.round(progress)}%
          {isActive && elapsed > 0 ? ` · ${formatElapsed(elapsed)}` : ''}
          {eta !== null ? ` · ~${formatElapsed(eta)} left` : ''}
        </span>
      </div>
      {!job ? <p>{STRINGS.progress.readyBody}</p> : null}
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
          {job.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
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
        <pre className="log-scroll">{job?.logs.slice(-200).join('\n')}</pre>
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


function estimateOutputBytes(settings: Settings, sourceMeta: SourceMeta) {
  const duration = Math.max(0.5, Math.min(settings.durationSec, sourceMeta.durationSec ?? settings.durationSec));
  const sourceWidth = sourceMeta.width ?? settings.width;
  const sourceHeight = sourceMeta.height ?? Math.round(sourceWidth * 9 / 16);
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


async function saveJobOutput(job: Job) {
  if (!job.downloadUrl) throw new Error(STRINGS.errors.outputUnavailable);
  const response = await fetch(job.downloadUrl);
  if (!response.ok) {
    throw new Error(await readApiError(response, STRINGS.errors.downloadFailed));
  }

  const blob = await response.blob();
  const format = job.settings.format;
  const ext = format === 'apng' ? 'png' : format === 'webp' ? 'webp' : format === 'mp4' ? 'mp4' : format === 'avif' ? 'avif' : 'gif';
  const suggestedName = `${safeFileBase(job.inputName)}-gifm.${ext}`;
  const acceptByFormat: Record<OutputFormat, { description: string; accept: Record<string, string[]> }> = {
    apng: { description: STRINGS.files.apngDescription, accept: { 'image/apng': ['.png'] } },
    webp: { description: STRINGS.files.webpDescription, accept: { 'image/webp': ['.webp'] } },
    mp4: { description: STRINGS.files.mp4Description, accept: { 'video/mp4': ['.mp4'] } },
    avif: { description: STRINGS.files.avifDescription, accept: { 'image/avif': ['.avif'] } },
    gif: { description: STRINGS.files.gifDescription, accept: { 'image/gif': ['.gif'] } }
  };
  const fileType = acceptByFormat[format];
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
  // First load with no stored choice: default to the app's premium dark workspace.
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

function loadTimelineClips(): TimelineClip[] {
  return (readStorage<TimelineClip[]>(CLIPS_KEY) ?? [])
    .filter((clip) => clip?.id && clip?.name && Number.isFinite(clip?.startSec) && Number.isFinite(clip?.durationSec))
    .slice(0, 50);
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
    perFramePalette: Boolean(value.perFramePalette ?? DEFAULT_SETTINGS.perFramePalette),
    encoderBackend: isEncoderBackend(value.encoderBackend) ? value.encoderBackend : DEFAULT_SETTINGS.encoderBackend,
    autoFit: Boolean(value.autoFit ?? DEFAULT_SETTINGS.autoFit),
    allowTrim: Boolean(value.allowTrim ?? DEFAULT_SETTINGS.allowTrim),
    optimize: Boolean(value.optimize ?? DEFAULT_SETTINGS.optimize),
    gifskiQuality: Math.round(clampNumber(Number(value.gifskiQuality ?? DEFAULT_SETTINGS.gifskiQuality), 1, 100)),
    loopCount: normalizeLoopCount(value.loopCount),
    speed: clampNumber(Number(value.speed ?? DEFAULT_SETTINGS.speed), 0.25, 8),
    playback: isPlayback(value.playback) ? value.playback : DEFAULT_SETTINGS.playback,
    crop: normalizeCrop(value.crop),
    format: (['apng', 'webp', 'mp4', 'avif'] as string[]).includes(String(value.format)) ? (value.format as OutputFormat) : 'gif',
    caption: normalizeCaption(value.caption),
    overlay: normalizeOverlay(value.overlay),
    rotate: ([0, 90, 180, 270] as const).includes(value.rotate as Rotation) ? (value.rotate as Rotation) : 0,
    flipH: Boolean(value.flipH),
    flipV: Boolean(value.flipV),
    colorFilter: (['none', 'grayscale', 'invert', 'sepia'] as const).includes(value.colorFilter as ColorFilter) ? (value.colorFilter as ColorFilter) : 'none',
    saturation: clampNumber(Number(value.saturation ?? 1), 0, 3),
    gifsicleColorSpace: (['srgb', 'oklab'] as const).includes(value.gifsicleColorSpace as 'srgb' | 'oklab') ? (value.gifsicleColorSpace as 'srgb' | 'oklab') : 'srgb',
    gifsicleOptDither: (['none', 'ordered', 'atkinson'] as const).includes(value.gifsicleOptDither as 'none' | 'ordered' | 'atkinson') ? (value.gifsicleOptDither as 'none' | 'ordered' | 'atkinson') : 'none',
    subtitleId: typeof value.subtitleId === 'string' ? value.subtitleId : '',
    borderRadius: Math.round(clampNumber(Number(value.borderRadius ?? 0), 0, 48))
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


function clampTrimToDuration(settings: Settings, durationSec: number): Settings {
  const startSec = clampNumber(settings.startSec, 0, Math.max(0, durationSec - 0.5));
  const duration = clampNumber(settings.durationSec, 0.5, Math.max(0.5, durationSec - startSec));
  return {
    ...settings,
    startSec: Number(startSec.toFixed(2)),
    durationSec: Number(duration.toFixed(2))
  };
}


function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return STRINGS.format.zeroSeconds;
  if (seconds < 60) return STRINGS.format.seconds(seconds.toFixed(2));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return STRINGS.format.minuteSeconds(minutes, rest.toFixed(0).padStart(2, '0'));
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

function formatElapsed(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
