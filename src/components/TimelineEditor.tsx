import * as React from 'react';
import {
  Copy,
  Loader2,
  Play,
  Scissors,
  Trash2,
  UploadCloud,
  Wand2
} from 'lucide-react';
import { EmptyState } from './EmptyState';
import { NumberField } from './SettingsPanel';
import { clampNumber, formatBytes, formatTimecode } from '../utils';
import { STRINGS } from '../strings';
import type { LoopCandidate, Settings, SourceMeta, SourceSession, TimelineClip } from '../types';
import { useCallback, useEffect, useRef, useState } from 'react';

export function TimelineEditor({
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
  onDuplicateClip,
  onExportClip,
  onExportAll,
  onConcatAll,
  onImportClip,
  onPrepareSource,
  onFindLoops,
  loopCandidates,
  loopBusy,
  thumbnails,
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
  onDuplicateClip: (id: string) => void;
  onExportClip: (clip: TimelineClip) => void;
  onExportAll: () => void;
  onConcatAll: () => void;
  onImportClip: (name: string, startSec: number, durationSec: number) => void;
  onPrepareSource: () => void;
  onFindLoops: () => void;
  loopCandidates: LoopCandidate[];
  loopBusy: boolean;
  thumbnails: Array<{ timeSec: number; dataUrl: string }>;
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
  const railRef = useRef<HTMLDivElement | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; timeSec: number; thumb: string } | null>(null);

  const updateRailHover = useCallback((clientX: number) => {
    const rail = railRef.current;
    if (!rail || !thumbnails.length) return;
    const rect = rail.getBoundingClientRect();
    const fraction = clampNumber((clientX - rect.left) / rect.width, 0, 1);
    const timeSec = fraction * duration;
    let closest = thumbnails[0];
    for (const t of thumbnails) {
      if (Math.abs(t.timeSec - timeSec) < Math.abs(closest.timeSec - timeSec)) closest = t;
    }
    setHoverInfo({ x: clientX - rect.left, timeSec, thumb: closest.dataUrl });
  }, [thumbnails, duration]);

  const dragRef = useRef<{ anchorSec: number; active: boolean; pointerId: number } | null>(null);

  const fractionToTime = useCallback((clientX: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return clampNumber((clientX - rect.left) / rect.width, 0, 1) * duration;
  }, [duration]);

  const onRailPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const time = fractionToTime(e.clientX);
    if (e.pointerType !== 'mouse') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events in UI tests do not always have a capturable pointer.
      }
    }
    dragRef.current = { anchorSec: time, active: true, pointerId: e.pointerId };
    setStartAndSeek(time);
  }, [fractionToTime]);

  const onRailPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.active) {
      if (drag.pointerId !== e.pointerId) return;
      const time = fractionToTime(e.clientX);
      const lo = Math.min(drag.anchorSec, time);
      const hi = Math.max(drag.anchorSec, time);
      setSettings((current) => ({
        ...current,
        startSec: Number(lo.toFixed(2)),
        durationSec: Number(Math.max(0.5, hi - lo).toFixed(2))
      }));
      return;
    }
    if (e.pointerType !== 'touch') updateRailHover(e.clientX);
  }, [fractionToTime, updateRailHover]);

  const finishRailDrag = useCallback(() => {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (!drag) return;
    drag.active = false;
    try {
      if (rail?.hasPointerCapture(drag.pointerId)) rail.releasePointerCapture(drag.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }, []);

  const onRailPointerEnd = useCallback(() => finishRailDrag(), [finishRailDrag]);

  useEffect(() => {
    window.addEventListener('pointerup', finishRailDrag);
    window.addEventListener('pointercancel', finishRailDrag);
    window.addEventListener('mouseup', finishRailDrag);
    return () => {
      window.removeEventListener('pointerup', finishRailDrag);
      window.removeEventListener('pointercancel', finishRailDrag);
      window.removeEventListener('mouseup', finishRailDrag);
    };
  }, [finishRailDrag]);

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

  if (!sourceMeta && !probeBusy) {
    return (
      <section className="timeline-editor timeline-editor-empty" aria-label={STRINGS.timeline.aria}>
        <div className="timeline-head">
          <div className="output-title">
            <Scissors aria-hidden="true" />
            <h3>{STRINGS.timeline.title}</h3>
          </div>
        </div>
        <EmptyState icon={<Scissors aria-hidden="true" />} title={STRINGS.timeline.noSourceTitle} body={STRINGS.timeline.noSourceBody} compact />
      </section>
    );
  }

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
        {hoverInfo ? (
          <div className="timeline-hover-thumb" style={{ left: `${clampNumber(hoverInfo.x, 50, (railRef.current?.offsetWidth ?? 300) - 50)}px` }}>
            <img src={hoverInfo.thumb} alt="" />
            <span>{formatTimecode(hoverInfo.timeSec)}</span>
          </div>
        ) : null}
        <div
          className="timeline-rail"
          aria-hidden="true"
          ref={railRef}
          onPointerDown={onRailPointerDown}
          onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerEnd}
          onPointerCancel={onRailPointerEnd}
          onLostPointerCapture={onRailPointerEnd}
          onPointerLeave={() => setHoverInfo(null)}
        >
          {thumbnails.length > 0 ? (
            <div className="timeline-filmstrip">
              {thumbnails.map((thumb, i) => (
                <img key={i} src={thumb.dataUrl} alt="" />
              ))}
            </div>
          ) : null}
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

      <div className={`source-session-row${sourceSession ? ' is-ready' : ''}`}>
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
          <button type="button" className="secondary-button" disabled={clips.length < 2 || sourceBusy || exportBusy} onClick={onConcatAll}>
            <Scissors aria-hidden="true" />
            {STRINGS.timeline.concatAll}
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
                const maxDuration = sourceMeta?.durationSec ?? Infinity;
                for (const line of lines) {
                  const [name, startStr, , durStr] = line.split(',');
                  if (!name || !startStr || !durStr) continue;
                  const startSec = clampNumber(Number(startStr), 0, Math.max(0, maxDuration - 0.5));
                  const durationSec = clampNumber(Number(durStr), 0.5, Math.max(0.5, maxDuration - startSec));
                  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec)) continue;
                  onImportClip(name.trim(), startSec, durationSec);
                }
              } catch (csvError) {
                console.warn('CSV import failed:', csvError);
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
              <button type="button" className="secondary-button icon-button" aria-label={STRINGS.timeline.duplicateClip} onClick={() => onDuplicateClip(clip.id)}>
                <Copy aria-hidden="true" />
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
        placeholder="0:00:00.00"
        aria-label={label}
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  );
}

function sourceProbeLabel(sourceMeta: SourceMeta | null) {
  if (!sourceMeta) return STRINGS.diagnostics.emptyValue;
  if (sourceMeta.probeSource === 'client') {
    return sourceMeta.frameSampled ? STRINGS.trim.clientFrame : STRINGS.trim.clientMetadata;
  }
  if (sourceMeta.probeSource === 'server') return STRINGS.trim.serverProbe;
  return STRINGS.diagnostics.emptyValue;
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
