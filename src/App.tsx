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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string>('');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        <SettingsPanel settings={settings} setSettings={setSettings} />

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
        />
      </form>
    </main>
  );
}

function SettingsPanel({
  settings,
  setSettings
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}) {
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

function PreviewPanel({
  file,
  objectUrl,
  job,
  outputFit,
  onReveal
}: {
  file: File | null;
  objectUrl: string;
  job: Job | null;
  outputFit: boolean;
  onReveal: () => void;
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
          <video src={objectUrl} controls muted playsInline />
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
