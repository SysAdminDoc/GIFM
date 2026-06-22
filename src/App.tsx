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
  Settings2,
  Terminal,
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
  useMemo,
  useRef,
  useState
} from 'react';

const VERSION = '0.1.0';

type TargetPreset = 'free' | 'nitro-basic' | 'nitro' | 'emoji' | 'avatar' | 'custom';
type DitherMode = 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none';
type PaletteMode = 'diff' | 'full' | 'single';

type Settings = {
  targetPreset: TargetPreset;
  targetMb: number;
  width: number;
  fps: number;
  startSec: number;
  durationSec: number;
  colors: number;
  dither: DitherMode;
  paletteMode: PaletteMode;
  autoFit: boolean;
  allowTrim: boolean;
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
  attempts: Attempt[];
  settings: Settings;
};

type SourceMeta = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string;
  rotation: number;
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
  paletteMode: 'diff',
  autoFit: true,
  allowTrim: false
};

const TARGET_PROFILES: Array<{
  id: TargetPreset;
  label: string;
  targetMb: number;
  description: string;
}> = [
  { id: 'free', label: 'Free 10 MB', targetMb: 10, description: 'Standard account file uploads.' },
  { id: 'nitro-basic', label: 'Basic 50 MB', targetMb: 50, description: 'Nitro Basic file sharing limit.' },
  { id: 'nitro', label: 'Nitro 500 MB', targetMb: 500, description: 'Full Nitro file sharing limit.' },
  { id: 'emoji', label: 'Emoji 256 KB', targetMb: 256 / 1024, description: 'Custom animated emoji upload ceiling.' },
  { id: 'avatar', label: 'Icon/avatar 10 MB', targetMb: 10, description: 'Square GIF guidance for avatars and server icons.' },
  { id: 'custom', label: 'Custom', targetMb: 10, description: 'Use a specific byte target.' }
];
const SETTINGS_KEY = 'gifm:settings:v1';
const PRESETS_KEY = 'gifm:presets:v1';
const RECENTS_KEY = 'gifm:recents:v1';
const MAX_RECENT_OUTPUTS = 8;

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
          <h1>GIFM stopped rendering</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            <RotateCcw aria-hidden="true" />
            Reload
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
  const [objectUrl, setObjectUrl] = useState<string>('');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      setPreviewTime(0);
      return undefined;
    }

    const controller = new AbortController();
    const probe = async () => {
      setProbeBusy(true);
      try {
        const body = new FormData();
        body.set('media', file);
        const response = await fetch('/api/probe', { method: 'POST', body, signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readApiError(response, `Probe failed (${response.status})`));
        }

        const metadata = (await response.json()) as SourceMeta;
        setSourceMeta(metadata);
        if (metadata.durationSec && metadata.durationSec > 0) {
          setSettings((current) => clampTrimToDuration(current, metadata.durationSec ?? current.durationSec));
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSourceMeta(null);
        setNotice(error instanceof Error ? error.message : 'Probe failed');
      } finally {
        if (!controller.signal.aborted) setProbeBusy(false);
      }
    };

    void probe();
    return () => controller.abort();
  }, [file]);

  useEffect(() => {
    if (!job || isTerminalJob(job)) {
      return undefined;
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        if (!response.ok) {
          throw new Error(`Status check failed (${response.status})`);
        }
        const nextJob = (await response.json()) as Job;
        setJob(nextJob);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Status check failed');
      }
    }, 800);

    return () => window.clearInterval(interval);
  }, [job]);

  useEffect(() => {
    if (job?.status !== 'complete' || !job.downloadUrl || !job.outputBytes) return;
    const recent = recentFromJob(job);
    setRecentOutputs((current) => [recent, ...current.filter((item) => item.id !== recent.id)].slice(0, MAX_RECENT_OUTPUTS));
  }, [job?.id, job?.status, job?.downloadUrl, job?.outputBytes]);

  const targetBytes = useMemo(() => settings.targetMb * 1024 * 1024, [settings.targetMb]);
  const originalRatio = useMemo(() => {
    if (!file) return 0;
    return file.size / targetBytes;
  }, [file, targetBytes]);

  const outputFit = job?.outputBytes ? job.outputBytes <= job.targetBytes : false;
  const canStart = Boolean(file) && !busy && job?.status !== 'running' && job?.status !== 'queued';
  const canCancel = job?.status === 'queued' || job?.status === 'running';

  const chooseFile = useCallback((nextFile?: File) => {
    if (!nextFile) return;
    setFile(nextFile);
    setJob(null);
    setNotice(`${nextFile.name} loaded`);
  }, []);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.currentTarget.files?.[0]);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(true);
  };

  const startEncoding = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setNotice('Encoding started');

    try {
      const body = new FormData();
      body.set('media', file);
      body.set('settings', JSON.stringify(settings));

      const response = await fetch('/api/jobs', {
        method: 'POST',
        body
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Encoding failed to start (${response.status})`));
      }

      const nextJob = (await response.json()) as Job;
      setJob(nextJob);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Encoding failed to start');
    } finally {
      setBusy(false);
    }
  };

  const revealOutput = async () => {
    if (!job) return;
    const response = await fetch(`/api/jobs/${job.id}/reveal`, { method: 'POST' });
    setNotice(response.ok ? 'Output location opened' : await readApiError(response, 'Could not open output location'));
  };

  const cancelEncoding = async () => {
    if (!job || !canCancel) return;

    const response = await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    if (!response.ok) {
      setNotice(await readApiError(response, 'Cancel failed'));
      return;
    }

    const nextJob = (await response.json()) as Job;
    setJob(nextJob);
    setNotice('Job cancelled');
  };

  const savePreset = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setSavedPresets((current) => {
      const existing = current.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
      const nextPreset = { id: existing?.id ?? crypto.randomUUID(), name: trimmed, settings };
      return [nextPreset, ...current.filter((preset) => preset.id !== nextPreset.id)].slice(0, 20);
    });
    setNotice(`Preset saved: ${trimmed}`);
  };

  const loadPreset = (id: string) => {
    const preset = savedPresets.find((item) => item.id === id);
    if (!preset) return;
    setSettings(normalizeSettings(preset.settings));
    setNotice(`Preset loaded: ${preset.name}`);
  };

  const deletePreset = (id: string) => {
    const preset = savedPresets.find((item) => item.id === id);
    setSavedPresets((current) => current.filter((item) => item.id !== id));
    if (preset) setNotice(`Preset deleted: ${preset.name}`);
  };

  const revealRecentOutput = async (id: string) => {
    const response = await fetch(`/api/jobs/${id}/reveal`, { method: 'POST' });
    setNotice(response.ok ? 'Output location opened' : await readApiError(response, 'Recent output is no longer available'));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <div>
            <h1>GIFM</h1>
            <p>v{VERSION} local GIF maker</p>
          </div>
        </div>
        <div className="topbar-status" aria-live="polite">
          <Gauge aria-hidden="true" />
          <span>{file ? `${formatBytes(file.size)} source` : 'Ready for video or GIF'}</span>
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
        />

        <section className="center-stage" aria-label="Input and encoding">
          <div
            className={`drop-zone${dragActive ? ' is-active' : ''}`}
            onDrop={onDrop}
            onDragLeave={() => setDragActive(false)}
            onDragOver={onDragOver}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.gif,image/gif"
              onChange={onFileChange}
              aria-label="Choose video or GIF file"
            />
            <div className="drop-icon">
              {file?.type === 'image/gif' ? <ImageIcon aria-hidden="true" /> : <UploadCloud aria-hidden="true" />}
            </div>
            <div>
              <h2>Drop video or GIF</h2>
              <p>MP4, MOV, WebM, AVI, MKV, and existing GIF files are processed locally with FFmpeg.</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              <MonitorDown aria-hidden="true" />
              Browse
            </button>
          </div>

          <div className="source-strip">
            <StatusTile label="Target" value={formatBytes(targetBytes)} tone="cyan" />
            <StatusTile label="Source ratio" value={file ? formatRatio(originalRatio) : '-'} tone="amber" />
            <StatusTile label="Auto fit" value={settings.autoFit ? 'On' : 'Off'} tone={settings.autoFit ? 'lime' : 'muted'} />
            <StatusTile label="Queue" value={queueLabel(job)} tone={job?.status === 'queued' ? 'amber' : 'muted'} />
          </div>

          <TrimTimeline
            settings={settings}
            setSettings={setSettings}
            sourceMeta={sourceMeta}
            probeBusy={probeBusy}
            previewTime={previewTime}
          />

          <div className="action-row">
            <button type="submit" className="primary-button" disabled={!canStart}>
              {job?.status === 'running' || job?.status === 'queued' ? (
                <Loader2 aria-hidden="true" className="spin" />
              ) : (
                <Wand2 aria-hidden="true" />
              )}
              Start encoding
            </button>
            {canCancel ? (
              <button type="button" className="secondary-button" onClick={cancelEncoding}>
                <AlertTriangle aria-hidden="true" />
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              disabled={!file}
              onClick={() => {
                setFile(null);
                setJob(null);
                setNotice('Selection cleared');
              }}
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </button>
            <span className="notice" aria-live="polite">
              {notice}
            </span>
          </div>

          <ProgressPanel job={job} />
          <LogPanel job={job} />
        </section>

        <PreviewPanel
          file={file}
          objectUrl={objectUrl}
          job={job}
          outputFit={outputFit}
          onReveal={revealOutput}
          onPreviewTime={setPreviewTime}
          recentOutputs={recentOutputs}
          onRevealRecent={revealRecentOutput}
          onClearRecent={() => setRecentOutputs([])}
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
  onDeletePreset
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  savedPresets: SavedPreset[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
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
    <aside className="settings-panel" aria-label="Compression settings">
      <div className="panel-heading">
        <Settings2 aria-hidden="true" />
        <div>
          <h2>Target</h2>
          <p>Discord-ready size controls</p>
        </div>
      </div>

      <div className="preset-grid" role="group" aria-label="Target size preset">
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
        label="Target"
        value={settings.targetMb}
        min={0.05}
        max={500}
        step={settings.targetMb < 1 ? 0.05 : 0.5}
        suffix="MB"
        onChange={(value) => {
          setSettings((current) => ({ ...current, targetMb: value, targetPreset: 'custom' }));
        }}
      />
      <p className="profile-note">{activeProfile.description}</p>

      <div className="preset-manager">
        <label className="select-field">
          <span>Saved preset</span>
          <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.currentTarget.value)}>
            <option value="">Choose preset</option>
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
            placeholder="Preset name"
            aria-label="Preset name"
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
            Save
          </button>
          <button type="button" className="secondary-button" disabled={!selectedPresetId} onClick={() => onLoadPreset(selectedPresetId)}>
            Load
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
            Delete
          </button>
        </div>
      </div>

      <div className="rule" />

      <NumberField label="Width" value={settings.width} min={160} max={1280} step={20} suffix="px" onChange={(value) => update('width', value)} />
      <NumberField label="FPS" value={settings.fps} min={5} max={30} step={1} suffix="fps" onChange={(value) => update('fps', value)} />
      <NumberField label="Start" value={settings.startSec} min={0} max={7200} step={0.25} suffix="sec" onChange={(value) => update('startSec', value)} />
      <NumberField label="Duration" value={settings.durationSec} min={0.5} max={60} step={0.25} suffix="sec" onChange={(value) => update('durationSec', value)} />

      <div className="rule" />

      <NumberField label="Palette" value={settings.colors} min={16} max={256} step={8} suffix="colors" onChange={(value) => update('colors', value)} />

      <label className="select-field">
        <span>Dither</span>
        <select value={settings.dither} onChange={(event) => update('dither', event.target.value as DitherMode)}>
          <option value="sierra2_4a">Sierra 2-4A</option>
          <option value="bayer">Bayer</option>
          <option value="floyd_steinberg">Floyd-Steinberg</option>
          <option value="none">None</option>
        </select>
      </label>

      <label className="select-field">
        <span>Palette mode</span>
        <select value={settings.paletteMode} onChange={(event) => update('paletteMode', event.target.value as PaletteMode)}>
          <option value="diff">Scene diff</option>
          <option value="full">Full frame</option>
          <option value="single">Single palette</option>
        </select>
      </label>

      <ToggleField
        label="Auto fit"
        description="Retry with lower width, FPS, and colors until the GIF fits."
        checked={settings.autoFit}
        onChange={(checked) => update('autoFit', checked)}
      />
      <ToggleField
        label="Allow duration trim"
        description="Only trims when every visual-quality lever is exhausted."
        checked={settings.allowTrim}
        onChange={(checked) => update('allowTrim', checked)}
      />
    </aside>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const id = label.toLowerCase().replace(/\s+/g, '-');
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
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <em>{suffix}</em>
      </div>
    </label>
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

function TrimTimeline({
  settings,
  setSettings,
  sourceMeta,
  probeBusy,
  previewTime
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  sourceMeta: SourceMeta | null;
  probeBusy: boolean;
  previewTime: number;
}) {
  const duration = Math.max(0.5, sourceMeta?.durationSec ?? settings.startSec + settings.durationSec);
  const start = clampNumber(settings.startSec, 0, Math.max(0, duration - 0.5));
  const end = clampNumber(settings.startSec + settings.durationSec, start + 0.5, duration);

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

  return (
    <section className="trim-panel" aria-label="Trim timeline">
      <div className="trim-head">
        <strong>{probeBusy ? 'Probing source' : 'Source trim'}</strong>
        <span>
          {formatSeconds(start)} - {formatSeconds(end)} / {formatSeconds(duration)}
        </span>
      </div>
      <div className="range-stack">
        <input
          type="range"
          min={0}
          max={duration}
          step={0.05}
          value={start}
          onChange={(event) => setStart(Number(event.currentTarget.value))}
          aria-label="Trim start"
        />
        <input
          type="range"
          min={0}
          max={duration}
          step={0.05}
          value={end}
          onChange={(event) => setEnd(Number(event.currentTarget.value))}
          aria-label="Trim end"
        />
      </div>
      <div className="trim-actions">
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={() => setStart(previewTime)}>
          Use current start
        </button>
        <button type="button" className="secondary-button" disabled={!sourceMeta} onClick={() => setEnd(previewTime)}>
          Use current end
        </button>
      </div>
      <div className="metadata-grid" aria-label="Source metadata">
        <span>
          Duration <strong>{sourceMeta?.durationSec ? formatSeconds(sourceMeta.durationSec) : '-'}</strong>
        </span>
        <span>
          Size <strong>{sourceMeta?.width && sourceMeta.height ? `${sourceMeta.width}x${sourceMeta.height}` : '-'}</strong>
        </span>
        <span>
          FPS <strong>{sourceMeta?.fps ? sourceMeta.fps.toFixed(2) : '-'}</strong>
        </span>
        <span>
          Codec <strong>{sourceMeta?.codec || '-'}</strong>
        </span>
        <span>
          Rotation <strong>{sourceMeta ? `${sourceMeta.rotation} deg` : '-'}</strong>
        </span>
      </div>
    </section>
  );
}

function PreviewPanel({
  file,
  objectUrl,
  job,
  outputFit,
  onReveal,
  onPreviewTime,
  recentOutputs,
  onRevealRecent,
  onClearRecent
}: {
  file: File | null;
  objectUrl: string;
  job: Job | null;
  outputFit: boolean;
  onReveal: () => void;
  onPreviewTime: (seconds: number) => void;
  recentOutputs: RecentOutput[];
  onRevealRecent: (id: string) => void;
  onClearRecent: () => void;
}) {
  const isGif = file?.type === 'image/gif' || file?.name.toLowerCase().endsWith('.gif');

  return (
    <aside className="preview-panel" aria-label="Preview and output">
      <div className="panel-heading">
        <Play aria-hidden="true" />
        <div>
          <h2>Preview</h2>
          <p>{file ? file.name : 'No file selected'}</p>
        </div>
      </div>

      <div className="preview-box">
        {objectUrl && isGif ? (
          <img src={objectUrl} alt="Selected GIF preview" />
        ) : objectUrl ? (
          <video src={objectUrl} controls muted playsInline onTimeUpdate={(event) => onPreviewTime(event.currentTarget.currentTime)} />
        ) : (
          <div className="empty-preview">
            <Video aria-hidden="true" />
            <span>Select a video or GIF to preview it here.</span>
          </div>
        )}
      </div>

      <section className="output-box" aria-label="Output">
        <div className="output-title">
          <FileDown aria-hidden="true" />
          <h3>Output</h3>
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
                Download GIF
              </a>
              <button type="button" className="secondary-button" onClick={onReveal}>
                <MonitorDown aria-hidden="true" />
                Open output
              </button>
            </div>
          </>
        ) : job?.status === 'failed' ? (
          <>
            <p className="error-text">{job.error}</p>
            {job.errorCode ? <p className="muted-text">Error code: {job.errorCode}</p> : null}
            <p className="muted-text">Adjust settings and press Start encoding again, or reset the selection.</p>
          </>
        ) : job?.status === 'cancelled' ? (
          <p className="muted-text">The job was cancelled. Press Start encoding to run it again.</p>
        ) : (
          <p className="muted-text">Finished GIFs appear here with exact byte size and download actions.</p>
        )}
      </section>

      <section className="attempt-box" aria-label="Encoding attempts">
        <h3>Fit attempts</h3>
        <div className="attempt-list">
          {(job?.attempts ?? []).map((attempt) => (
            <div key={attempt.attempt} className="attempt-row">
              <span>#{attempt.attempt}</span>
              <span>{attempt.width}px</span>
              <span>{attempt.fps} fps</span>
              <span>{attempt.colors} colors</span>
              <span>{attempt.strategy ?? 'standard'}</span>
              <strong>{attempt.outputBytes ? formatBytes(attempt.outputBytes) : 'running'}</strong>
              {attempt.rejected ? <span className="attempt-rejected">rejected</span> : null}
            </div>
          ))}
          {!job?.attempts.length && <p className="muted-text">No attempts yet.</p>}
        </div>
      </section>

      <section className="recent-box" aria-label="Recent outputs">
        <div className="recent-heading">
          <h3>Recent outputs</h3>
          <button type="button" className="text-button" disabled={!recentOutputs.length} onClick={onClearRecent}>
            Clear
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
                  Download
                </a>
                <button type="button" className="secondary-button" onClick={() => onRevealRecent(item.id)}>
                  Open
                </button>
              </div>
            </div>
          ))}
          {!recentOutputs.length && <p className="muted-text">No recent outputs.</p>}
        </div>
      </section>
    </aside>
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
    <section className="progress-panel" aria-label="Encoding progress">
      <div>
        <strong>{job?.stage ?? 'Idle'}</strong>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="progress-track">
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
  return (
    <section className="log-panel" aria-label="Log">
      <div className="output-title">
        <Terminal aria-hidden="true" />
        <h3>Log</h3>
      </div>
      <pre>{job?.logs.length ? job.logs.join('\n') : 'Waiting for an encode job.'}</pre>
    </section>
  );
}

function formatBytes(bytes: number) {
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

function formatRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return '-';
  if (ratio < 0.1) return '<0.1x';
  return `${ratio.toFixed(1)}x`;
}

function profileFor(preset: TargetPreset) {
  return TARGET_PROFILES.find((profile) => profile.id === preset) ?? TARGET_PROFILES[0];
}

function outputSuitability(job: Job) {
  const profile = profileFor(job.settings.targetPreset);
  if ((job.outputBytes ?? 0) <= job.targetBytes) {
    return `Fits ${profile.label}. ${profile.description}`;
  }

  return `Over ${profile.label}. Try ${nextCompressionLever(job)}.`;
}

function nextCompressionLever(job: Job) {
  const settings = job.settings;
  if (settings.width > 360) return 'lower width first';
  if (settings.fps > 10) return 'lower FPS';
  if (settings.colors > 64) return 'fewer palette colors';
  if (!settings.allowTrim && settings.durationSec > 2) return 'enabling duration trim';
  if (settings.durationSec > 1) return 'a shorter clip';
  return 'a smaller target profile or simpler source motion';
}

async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message ?? fallback;
}

function isTerminalJob(job: Job) {
  return job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled';
}

function queueLabel(job: Job | null) {
  if (!job) return '-';
  if (job.status === 'queued') return `#${job.queuePosition ?? 1}`;
  if (job.status === 'running') return 'Running';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'failed') return 'Failed';
  return 'Done';
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

function loadSettings() {
  return normalizeSettings(readStorage<Partial<Settings>>(SETTINGS_KEY) ?? DEFAULT_SETTINGS);
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
    startSec: clampNumber(Number(value.startSec ?? DEFAULT_SETTINGS.startSec), 0, 7200),
    durationSec: clampNumber(Number(value.durationSec ?? DEFAULT_SETTINGS.durationSec), 0.5, 60),
    colors: clampNumber(Number(value.colors ?? DEFAULT_SETTINGS.colors), 16, 256),
    dither: isDitherMode(value.dither) ? value.dither : DEFAULT_SETTINGS.dither,
    paletteMode: isPaletteMode(value.paletteMode) ? value.paletteMode : DEFAULT_SETTINGS.paletteMode,
    autoFit: Boolean(value.autoFit ?? DEFAULT_SETTINGS.autoFit),
    allowTrim: Boolean(value.allowTrim ?? DEFAULT_SETTINGS.allowTrim)
  };
}

function isDitherMode(value: unknown): value is DitherMode {
  return value === 'sierra2_4a' || value === 'bayer' || value === 'floyd_steinberg' || value === 'none';
}

function isPaletteMode(value: unknown): value is PaletteMode {
  return value === 'diff' || value === 'full' || value === 'single';
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
  if (!Number.isFinite(seconds) || seconds < 0) return '0.00s';
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(0).padStart(2, '0')}`;
}
