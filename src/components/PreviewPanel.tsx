import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Columns2,
  Download,
  EyeOff,
  FileDown,
  MonitorDown,
  Play,
  ShieldCheck,
  Video,
  Wand2,
  Image as ImageIcon
} from 'lucide-react';
import { EmptyState } from './EmptyState';
import { WebhookRow } from './SettingsPanel';
import { clampNumber, formatBytes, profileFor } from '../utils';
import { STRINGS } from '../strings';
import type { CropRect, Job, OverlaySettings, RecentOutput } from '../types';
import { useEffect, useMemo, useRef, useState } from 'react';


export function PreviewPanel({
  file,
  objectUrl,
  job,
  outputFit,
  onReveal,
  onSaveAs,
  onSendWebhook,
  onCopyText,
  onNotice,
  onPreviewTime,
  previewSeekTime,
  recentOutputs,
  onRevealRecent,
  onClearRecent,
  crop,
  caption,
  overlay
}: {
  file: File | null;
  objectUrl: string;
  job: Job | null;
  outputFit: boolean;
  crop: CropRect;
  caption: { top: string; bottom: string };
  overlay: OverlaySettings;
  onReveal: () => void;
  onSaveAs: (job: Job) => void;
  onSendWebhook: (webhookUrl: string) => void;
  onCopyText: (text: string, successMessage: string) => void;
  onNotice: (message: string) => void;
  onPreviewTime: (seconds: number) => void;
  previewSeekTime: number | null;
  recentOutputs: RecentOutput[];
  onRevealRecent: (id: string) => void;
  onClearRecent: () => void;
}) {
  const isGif = file?.type === 'image/gif' || file?.name.toLowerCase().endsWith('.gif');
  const [altText, setAltText] = useState('');
  const [outputName, setOutputName] = useState('');
  const [outputPaused, setOutputPaused] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [lilliputPreview, setLilliputPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastTimeUpdateRef = useRef(0);

  useEffect(() => {
    if (job?.status === 'complete') {
      setAltText(defaultAltText(job.inputName));
      const ext = job.settings.format === 'apng' ? 'png' : job.settings.format === 'webp' ? 'webp' : job.settings.format === 'mp4' ? 'mp4' : job.settings.format === 'avif' ? 'avif' : 'gif';
      setOutputName(`${safeFileBase(job.inputName)}-gifm.${ext}`);
    }
  }, [job?.id, job?.status, job?.inputName, job?.settings.format]);

  useEffect(() => {
    setOutputPaused(false);
    setCompareMode(false);
    setLilliputPreview(false);
  }, [job?.id]);

  useEffect(() => {
    if (job?.settings.format !== 'gif') setLilliputPreview(false);
  }, [job?.settings.format]);

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

  const lilliputTable = useMemo(() => Array.from({ length: 256 }, (_, i) => ((Math.floor(i / 8) * 8 + 4) / 255).toFixed(4)).join(' '), []);
  const lilliputStyle: React.CSSProperties | undefined = lilliputPreview ? { filter: 'url(#lilliput-crush)' } : undefined;
  const outputMeta = job?.outputMeta;
  const outputDimensions = outputMeta?.width && outputMeta.height ? `${outputMeta.width}x${outputMeta.height}` : STRINGS.diagnostics.emptyValue;
  const canUseDiscordPreview = job?.settings.format === 'gif';

  return (
    <aside className="preview-panel" aria-label={STRINGS.preview.aria}>
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <defs>
          <filter id="lilliput-crush" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR type="discrete" tableValues={lilliputTable} />
              <feFuncG type="discrete" tableValues={lilliputTable} />
              <feFuncB type="discrete" tableValues={lilliputTable} />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>
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
            onTimeUpdate={(event) => { const now = Date.now(); if (now - lastTimeUpdateRef.current > 250) { lastTimeUpdateRef.current = now; onPreviewTime(event.currentTarget.currentTime); } }}
          />
        ) : (
          <EmptyState icon={<Video aria-hidden="true" />} title={STRINGS.preview.emptyTitle} body={STRINGS.preview.empty} />
        )}
        {objectUrl && (caption.top || caption.bottom) ? (
          <div className="caption-preview" aria-hidden="true">
            {caption.top ? <span className="caption-top">{caption.top}</span> : null}
            {caption.bottom ? <span className="caption-bottom">{caption.bottom}</span> : null}
          </div>
        ) : null}
        {objectUrl && overlay.enabled && overlay.id ? (
          <div className="overlay-preview" aria-hidden="true" style={{
            width: `${Math.round(overlay.scale * 100)}%`,
            opacity: overlay.opacity,
            ...overlayPreviewPosition(overlay.position)
          }}>
            <img src={`/api/overlays/${overlay.id}`} alt="" />
          </div>
        ) : null}
      </div>

      <section className="output-box" aria-label={STRINGS.output.aria} aria-live="polite">
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
              <div className="output-meta-grid" aria-label={STRINGS.output.meta.aria}>
                <span>{STRINGS.output.meta.dimensions}<strong>{outputDimensions}</strong></span>
                <span>{STRINGS.output.meta.duration}<strong>{outputMeta?.durationSec ? formatSeconds(outputMeta.durationSec) : STRINGS.diagnostics.emptyValue}</strong></span>
                <span>{STRINGS.output.meta.fps}<strong>{outputMeta?.fps ? outputMeta.fps.toFixed(0) : STRINGS.diagnostics.emptyValue}</strong></span>
                <span>{STRINGS.output.meta.quality}<strong>{job.ssim != null ? `${Math.round(job.ssim * 100)}%` : STRINGS.diagnostics.emptyValue}</strong></span>
                {outputMeta?.frameCount ? <span>{STRINGS.output.meta.frames}<strong>{outputMeta.frameCount}</strong></span> : null}
              </div>
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
            <div className={`output-preview${compareMode ? ' compare-active' : ''}`}>
              {compareMode && objectUrl ? (
                <div className="compare-grid">
                  <figure className="compare-card">
                    <figcaption>{STRINGS.output.compareSource}</figcaption>
                    {isGif ? <img src={objectUrl} alt={STRINGS.output.compareSource} /> : <video src={objectUrl} muted loop playsInline autoPlay />}
                  </figure>
                  <figure className="compare-card">
                    <figcaption>{STRINGS.output.compareOutput}</figcaption>
                    {job.settings.format === 'mp4' ? (
                      <video src={job.downloadUrl} muted loop playsInline autoPlay />
                    ) : (
                      <img src={job.downloadUrl} alt={STRINGS.output.outputPreviewAlt} style={lilliputStyle} />
                    )}
                  </figure>
                </div>
              ) : job.settings.format === 'mp4' ? (
                <video src={job.downloadUrl} controls muted loop playsInline />
              ) : outputPaused ? (
                <div className="motion-hidden-state" role="img" aria-label={STRINGS.output.motionHiddenTitle}>
                  <EyeOff aria-hidden="true" />
                  <strong>{STRINGS.output.motionHiddenTitle}</strong>
                  <span>{STRINGS.output.motionHiddenBody}</span>
                </div>
              ) : (
                <img src={job.downloadUrl} alt={STRINGS.output.outputPreviewAlt} style={lilliputStyle} />
              )}
              <div className="output-preview-actions" role="group" aria-label={STRINGS.output.reviewControls}>
                {job.settings.format !== 'mp4' && !compareMode ? (
                  <button type="button" className="secondary-button output-pause" aria-pressed={outputPaused} onClick={() => setOutputPaused((p) => !p)}>
                    {outputPaused ? <Play size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                    {outputPaused ? STRINGS.output.showMotion : STRINGS.output.hideMotion}
                  </button>
                ) : null}
                {objectUrl ? (
                  <button type="button" className="secondary-button output-pause" aria-pressed={compareMode} onClick={() => setCompareMode((c) => !c)}>
                    <Columns2 size={14} aria-hidden="true" />
                    {compareMode ? STRINGS.output.hideCompare : STRINGS.output.compare}
                  </button>
                ) : null}
                {canUseDiscordPreview ? (
                  <button type="button" className={`secondary-button output-pause${lilliputPreview ? ' active' : ''}`} aria-pressed={lilliputPreview} onClick={() => setLilliputPreview((p) => !p)}>
                    <ShieldCheck size={14} aria-hidden="true" />
                    {STRINGS.output.discordPreview}
                  </button>
                ) : null}
              </div>
            </div>
            <label className="alt-field">
              <span>{STRINGS.output.filenameLabel}</span>
              <input type="text" value={outputName} maxLength={120} onChange={(event) => setOutputName(event.currentTarget.value)} />
            </label>
            <div className="download-grid">
              <a className="primary-button" href={job.downloadUrl} download={outputName || undefined}>
                <Download aria-hidden="true" />
                {STRINGS.output.downloadFormats[job.settings.format]}
              </a>
              <button type="button" className="secondary-button" onClick={onReveal}>
                <MonitorDown aria-hidden="true" />
                {STRINGS.output.openOutput}
              </button>
              <button type="button" className="secondary-button" onClick={() => onSaveAs(job)}>
                <FileDown aria-hidden="true" />
                {STRINGS.output.saveAs}
              </button>
              <button type="button" className="secondary-button" onClick={async () => {
                try {
                  if (!job.downloadUrl) return;
                  const res = await fetch(job.downloadUrl);
                  const blob = await res.blob();
                  const mime = blob.type.startsWith('image/') ? blob.type : 'image/gif';
                  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
                  onNotice(STRINGS.notices.outputCopied);
                } catch {
                  onNotice(STRINGS.notices.clipboardImageUnsupported);
                }
              }}>
                <ClipboardCopy aria-hidden="true" />
                {STRINGS.output.copyOutput}
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
          <div className="state-card error-state">
            <AlertTriangle aria-hidden="true" />
            <div>
              <strong>{STRINGS.output.failedTitle}</strong>
              <p>{job.error}</p>
              {job.errorCode ? <span>{STRINGS.output.errorCode(job.errorCode)}</span> : null}
              <small>{STRINGS.output.failedRecovery}</small>
            </div>
          </div>
        ) : job?.status === 'cancelled' ? (
          <div className="state-card">
            <AlertTriangle aria-hidden="true" />
            <div>
              <strong>{STRINGS.output.cancelledTitle}</strong>
              <p>{STRINGS.output.cancelledRecovery}</p>
            </div>
          </div>
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

function overlayPreviewPosition(position: string): React.CSSProperties {
  const margin = '3%';
  switch (position) {
    case 'top-left': return { top: margin, left: margin };
    case 'top-right': return { top: margin, right: margin };
    case 'bottom-left': return { bottom: margin, left: margin };
    case 'center': return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    default: return { bottom: margin, right: margin };
  }
}

function safeFileBase(inputName: string) {
  return inputName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gifm-output';
}

function defaultAltText(inputName: string) {
  const base = inputName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return base ? STRINGS.alt.fromName(base) : STRINGS.alt.default;
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return STRINGS.format.zeroSeconds;
  if (seconds < 60) return STRINGS.format.seconds(seconds.toFixed(2));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return STRINGS.format.minuteSeconds(minutes, rest.toFixed(0).padStart(2, '0'));
}
