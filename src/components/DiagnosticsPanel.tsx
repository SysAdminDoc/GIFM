import { useMemo } from 'react';
import { Terminal } from 'lucide-react';
import { STRINGS } from '../strings';
import type { Settings, SourceMeta, HealthInfo, Job } from '../types';
import { clampNumber, formatBytes } from '../utils';

export function DiagnosticsPanel({
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
  const diagnostic = useMemo(() => {
    const redactPaths = (obj: unknown): unknown => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(redactPaths);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if ((k === 'path' || k === 'inputPath' || k === 'outputPath' || k === 'workPath') && typeof v === 'string') {
          out[k] = '[redacted]';
        } else {
          out[k] = redactPaths(v);
        }
      }
      return out;
    };
    return redactPaths({
      generatedAt: new Date().toISOString(),
      health,
      sourceMeta,
      estimate: sourceMeta ? {
        outputBytes: estimateOutputBytes(settings, sourceMeta),
        targetBytes: settings.targetMb * 1024 * 1024
      } : null,
      settings,
      job
    });
  }, [health, sourceMeta, settings, job]);
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

export function estimateOutputBytes(settings: Settings, sourceMeta: SourceMeta) {
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
