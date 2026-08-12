import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Image as ImageIcon,
  Loader2,
  MonitorDown,
  RotateCcw,
  Scissors,
  Terminal,
  Trash2,
  UploadCloud,
  Video,
  Wand2
} from 'lucide-react';
import { SettingsPanel, UrlImportRow } from './components/SettingsPanel';
import { EmptyState, StatusTile } from './components/EmptyState';
import { PreviewPanel } from './components/PreviewPanel';
import { TimelineEditor } from './components/TimelineEditor';
import { ProgressPanel } from './components/ProgressPanel';
import { LogPanel } from './components/LogPanel';
import { DiagnosticsPanel, estimateOutputBytes } from './components/DiagnosticsPanel';
import { BatchQueue } from './components/BatchQueue';
import { clampNumber, evenNumber, formatBytes, profileFor, normalizeCrop, normalizeLoopCount, readStorage, writeStorage, useDebouncedStorage, readApiError, uploadWithProgress, formatTimecode } from './utils';
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
import { usePollJobs, usePollUrlImport } from './jobPolling';
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
  type UrlImportJob,
  type TimelineClip,
  type LoopCandidate,
  type ExtractedFrame,
  type FrameManifest,
  type SavePickerWindow,
  type ApiErrorPayload
} from './types';

const VERSION = '0.5.3';
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
  const [urlImportJob, setUrlImportJob] = useState<UrlImportJob | null>(null);
  const [timelineThumbnails, setTimelineThumbnails] = useState<Array<{ timeSec: number; dataUrl: string }>>([]);
  const [loopCandidates, setLoopCandidates] = useState<LoopCandidate[]>([]);
  const [loopBusy, setLoopBusy] = useState(false);
  const [frameManifest, setFrameManifest] = useState<FrameManifest | null>(null);
  const [editedFrames, setEditedFrames] = useState<ExtractedFrame[]>([]);
  const [frameBusy, setFrameBusy] = useState(false);
  const [zoomedFrameIndex, setZoomedFrameIndex] = useState<number | null>(null);
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

  useDebouncedStorage(SETTINGS_KEY, settings, 400);

  useEffect(() => {
    writeStorage(PRESETS_KEY, savedPresets);
  }, [savedPresets]);

  useEffect(() => {
    writeStorage(RECENTS_KEY, recentOutputs);
  }, [recentOutputs]);

  useDebouncedStorage(CLIPS_KEY, timelineClips, 400);

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
      setTimelineThumbnails([]);
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

  const adoptImportedSource = useCallback((prepared: SourceSession) => {
    setFile(null);
    setBatchFiles([]);
    setBatchJobs([]);
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
  }, []);

  const handleUrlImportUpdate = useCallback((next: UrlImportJob) => {
    setUrlImportJob(next);
    if (next.status === 'complete' && next.source) {
      setSourceBusy(false);
      adoptImportedSource(next.source);
    } else if (next.status === 'failed') {
      setSourceBusy(false);
      setNotice(next.error || STRINGS.errors.importFailed);
    } else if (next.status === 'cancelled') {
      setSourceBusy(false);
      setNotice(STRINGS.notices.importCancelled);
    }
  }, [adoptImportedSource]);

  usePollUrlImport(urlImportJob && !isTerminalUrlImport(urlImportJob) ? urlImportJob.id : '', handleUrlImportUpdate);

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
  const canStart = (batchFiles.length > 0 || Boolean(sourceSession)) && !busy && !sourceBusy && job?.status !== 'running' && job?.status !== 'queued';
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
    const key = `${nextFile.name}:${nextFile.size}`;
    const stored = loadTimelineClips().filter((c) => c.sourceKey === key);
    setTimelineClips(stored);
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
    if (batchFiles.length > 0) {
      await submitUploadedFiles(
        batchFiles,
        settings,
        batchFiles.length > 1 ? STRINGS.notices.submittingJobs(batchFiles.length) : STRINGS.notices.encodingStarted
      );
      return;
    }
    if (sourceSession) {
      setBusy(true);
      setNotice(STRINGS.notices.encodingStarted);
      try {
        const response = await fetch(`/api/sources/${sourceSession.id}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, STRINGS.errors.encodeStartFailed));
        }
        const nextJob = (await response.json()) as Job;
        setJob(nextJob);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : STRINGS.errors.encodeStartFailed);
      } finally {
        setBusy(false);
      }
    }
  };

  const importFromUrl = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setSourceBusy(true);
    setUrlImportJob(null);
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
      const nextJob = (await response.json()) as UrlImportJob;
      setUrlImportJob(nextJob);
    } catch (error) {
      setSourceBusy(false);
      setNotice(error instanceof Error ? error.message : STRINGS.errors.importFailed);
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
      void fetchThumbnails(prepared.id);
      return prepared;
    } finally {
      setSourceBusy(false);
    }
  };

  const fetchThumbnails = async (sourceId: string) => {
    try {
      const response = await fetch(`/api/sources/${sourceId}/thumbnails`);
      if (response.ok) {
        const data = await response.json();
        setTimelineThumbnails(data.thumbnails ?? []);
      }
    } catch {
      // Non-critical — timeline works without thumbnails.
    }
  };

  const addTimelineClip = () => {
    if (!file && !sourceSession) return;
    const key = sourceKeyFor(file, sourceSession);
    const clip = makeTimelineClip(timelineClips.length + 1, settings, key);
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

  const duplicateTimelineClip = (id: string) => {
    const clip = timelineClips.find((item) => item.id === id);
    if (!clip) return;
    const dupe: TimelineClip = {
      ...clip,
      id: crypto.randomUUID(),
      name: STRINGS.timeline.clipCopyName(clip.name),
      createdAt: new Date().toISOString()
    };
    setTimelineClips((current) => [...current, dupe]);
    setSelectedClipId(dupe.id);
    setNotice(STRINGS.notices.clipAdded(dupe.name));
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

  const concatTimelineClips = async (clipsToConcat: TimelineClip[]) => {
    if (clipsToConcat.length < 2) return;
    setBusy(true);
    try {
      const prepared = await prepareSource();
      setNotice(STRINGS.notices.concatStarted);
      const response = await fetch(`/api/sources/${prepared.id}/concat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: clipsToConcat.map((c) => ({ startSec: c.startSec, durationSec: c.durationSec })),
          settings
        })
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, STRINGS.errors.encodeStartFailed));
      }
      const nextJob = (await response.json()) as Job;
      setJob(nextJob);
      setNotice(STRINGS.notices.encodingStarted);
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

  const cancelUrlImport = async () => {
    if (!urlImportJob || isTerminalUrlImport(urlImportJob)) return;
    const response = await fetch(`/api/import-url/${urlImportJob.id}/cancel`, { method: 'POST' });
    if (!response.ok) {
      setNotice(await readApiError(response, STRINGS.errors.cancelFailed));
      return;
    }
    setUrlImportJob((await response.json()) as UrlImportJob);
    setNotice(STRINGS.notices.importCancelling);
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

  const renamePreset = (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSavedPresets((current) => current.map((item) => item.id === id ? { ...item, name: trimmed } : item));
    setNotice(STRINGS.notices.presetRenamed(trimmed));
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
          <div className="topbar-status" role="status">
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
          onRenamePreset={renamePreset}
          onDeletePreset={deletePreset}
          onImportPresets={importPresets}
          onNotice={setNotice}
          health={health}
          sourceSessionId={sourceSession?.id ?? ''}
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

          <UrlImportRow busy={sourceBusy} importJob={urlImportJob} onImport={importFromUrl} onCancel={() => { void cancelUrlImport(); }} />

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
            onDuplicateClip={duplicateTimelineClip}
            onExportClip={(clip) => exportTimelineClips([clip])}
            onExportAll={() => exportTimelineClips(timelineClips)}
            onConcatAll={() => concatTimelineClips(timelineClips)}
            onImportClip={importTimelineClip}
            onPrepareSource={() => {
              void prepareSource().catch((error) => setNotice(error instanceof Error ? error.message : STRINGS.errors.sourcePrepareFailed));
            }}
            onFindLoops={findLoops}
            loopCandidates={loopCandidates}
            loopBusy={loopBusy}
            thumbnails={timelineThumbnails}
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
              <div className="frame-strip" role="list">
                {editedFrames.map((frame, arrayIndex) => (
                  <div
                    key={`frame-${frame.index}`}
                    className="frame-card"
                    role="listitem"
                    aria-label={STRINGS.timeline.frameAlt(frame.index + 1)}
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
                    <img
                      src={frame.url}
                      alt={STRINGS.timeline.frameAlt(frame.index + 1)}
                      className={zoomedFrameIndex === frame.index ? 'frame-zoomed' : ''}
                      tabIndex={0}
                      role="button"
                      onClick={() => setZoomedFrameIndex((prev) => prev === frame.index ? null : frame.index)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomedFrameIndex((prev) => prev === frame.index ? null : frame.index); } }}
                    />
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
              <EmptyState icon={<ImageIcon aria-hidden="true" />} title={STRINGS.timeline.noFramesTitle} body={STRINGS.timeline.noFrames} compact />
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
            {sourceMeta ? (
              <span className={`estimate-chip ${estimateOutputBytes(settings, sourceMeta) <= targetBytes ? 'ok' : 'warn'}`}>
                ~{formatBytes(estimateOutputBytes(settings, sourceMeta))}
              </span>
            ) : null}
            <span className="notice" role="status" aria-live="polite">
              {uploadProgress !== null ? STRINGS.notices.uploading(uploadProgress) : notice}
            </span>
            {uploadProgress !== null ? (
              <div className="upload-progress" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
            ) : null}
          </div>

          <ProgressPanel job={job} />
          <BatchQueue jobs={batchJobs} onSelectJob={setJob} onRevealJob={revealRecentOutput} onSaveAs={saveOutputAs} onCancelJob={cancelBatchJob} onCancelAll={async () => {
            const cancellable = batchJobs.filter((item) => item.job?.status === 'queued' || item.job?.status === 'running');
            await Promise.all(cancellable.map((item) => item.job ? cancelBatchJob(item.job.id) : Promise.resolve()));
          }} />
          <LogPanel job={job} />
          <DiagnosticsPanel health={health} sourceMeta={sourceMeta} settings={settings} job={job} onCopyText={copyText} />
        </section>

        <PreviewPanel
          file={file}
          objectUrl={objectUrl}
          job={job}
          outputFit={outputFit}
          crop={settings.crop}
          caption={settings.caption}
          overlay={settings.overlay}
          onReveal={revealOutput}
          onSaveAs={saveOutputAs}
          onSendWebhook={sendToWebhook}
          onCopyText={copyText}
          onNotice={setNotice}
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















function formatRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return STRINGS.diagnostics.emptyValue;
  if (ratio < 0.1) return STRINGS.format.tinyRatio;
  return `${ratio.toFixed(1)}x`;
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


function isTerminalJob(job: Job) {
  return job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled';
}

function isTerminalUrlImport(job: UrlImportJob) {
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

function makeTimelineClip(index: number, settings: Settings, sourceKey: string): TimelineClip {
  return {
    id: crypto.randomUUID(),
    name: STRINGS.timeline.defaultClipName(index),
    startSec: Number(settings.startSec.toFixed(2)),
    durationSec: Number(settings.durationSec.toFixed(2)),
    createdAt: new Date().toISOString(),
    sourceKey
  };
}

function sourceKeyFor(file: File | null, session: SourceSession | null): string {
  if (file) return `${file.name}:${file.size}`;
  if (session) return `${session.inputName}:${session.inputSize}`;
  return '';
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
    gifskiMotionQuality: Math.round(clampNumber(Number(value.gifskiMotionQuality ?? DEFAULT_SETTINGS.gifskiMotionQuality), 1, 100)),
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
