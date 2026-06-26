import {
  Download,
  Image as ImageIcon,
  Loader2,
  Settings2
} from 'lucide-react';
import {
  type PropsWithChildren,
  useEffect,
  useId,
  useState
} from 'react';
import { STRINGS } from '../strings';
import {
  TARGET_PROFILES,
  type TargetPreset,
  type DitherMode,
  type PaletteMode,
  type EncoderBackend,
  type OutputFormat,
  type Playback,
  type Rotation,
  type ColorFilter,
  type OverlayPosition,
  type OverlaySettings,
  type Settings,
  type HealthInfo,
  type SavedPreset,
  type CropRect
} from '../types';
import { clampNumber, normalizeCrop, normalizeLoopCount, profileFor, readApiError, readStorage, writeStorage } from '../utils';

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4];
const MAX_TRIM_START_SEC = 24 * 60 * 60;

export function SettingsPanel({
  settings,
  setSettings,
  savedPresets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  onImportPresets,
  health
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  savedPresets: SavedPreset[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  onImportPresets: (presets: SavedPreset[]) => void;
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
              aria-pressed={settings.targetPreset === profile.id}
              onClick={() => setPreset(profile.id)}
            >
              <span className="target-profile-copy">
                <strong>{profile.label}</strong>
                <small>{profile.description}</small>
              </span>
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
        <NumberField label={STRINGS.settings.width} value={settings.targetPreset === 'emoji' || settings.targetPreset === 'emoji-webp' ? 128 : settings.targetPreset === 'sticker' ? 320 : settings.width} min={160} max={1280} step={20} suffix={STRINGS.settings.units.px} disabled={settings.targetPreset === 'emoji' || settings.targetPreset === 'emoji-webp' || settings.targetPreset === 'sticker'} onChange={(value) => update('width', value)} />
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
        {settings.targetPreset === 'emoji' || settings.targetPreset === 'emoji-webp'
          ? <p className="profile-note">{STRINGS.settings.squareNote.emoji}</p>
          : settings.targetPreset === 'sticker'
            ? <p className="profile-note">{STRINGS.settings.squareNote.sticker}</p>
            : settings.targetPreset === 'avatar'
              ? <p className="profile-note">{STRINGS.settings.squareNote.avatar}</p>
              : null}

        <details className="advanced-settings">
          <summary>
            <span>
              <strong>{STRINGS.settings.sections.transform.title}</strong>
              <small>{STRINGS.settings.sections.transform.description}</small>
            </span>
          </summary>
          <div className="advanced-settings-grid">
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

            <NumberField label={STRINGS.settings.borderRadius.label} value={settings.borderRadius} min={0} max={48} step={4} suffix="px" onChange={(v) => update('borderRadius', v)} />

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

            <div className="subtitle-row">
              <span>{STRINGS.settings.subtitle.label}</span>
              <button type="button" className="secondary-button" onClick={async () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.srt,.ass,.ssa,.vtt';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const form = new FormData();
                  form.set('subtitle', file);
                  try {
                    const res = await fetch('/api/subtitle', { method: 'POST', body: form });
                    if (res.ok) {
                      const data = await res.json();
                      update('subtitleId', data.id);
                    }
                  } catch {
                    // Upload failed silently — user can retry.
                  }
                };
                input.click();
              }}>
                {settings.subtitleId ? STRINGS.settings.subtitle.replace : STRINGS.settings.subtitle.upload}
              </button>
              {settings.subtitleId ? (
                <button type="button" className="secondary-button" onClick={() => update('subtitleId', '')}>
                  {STRINGS.settings.subtitle.clear}
                </button>
              ) : null}
            </div>

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
          </div>
        </details>
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
        <ToggleField
          label={STRINGS.settings.perFramePalette.label}
          description={STRINGS.settings.perFramePalette.description}
          checked={settings.perFramePalette}
          onChange={(checked) => update('perFramePalette', checked)}
        />

        <label className="select-field">
          <span>{STRINGS.settings.format.label}</span>
          <select
            value={settings.targetPreset === 'sticker' ? 'apng' : settings.targetPreset === 'emoji-webp' ? 'webp' : settings.format}
            disabled={settings.targetPreset === 'sticker' || settings.targetPreset === 'emoji-webp'}
            onChange={(event) => update('format', event.target.value as OutputFormat)}
          >
            <option value="gif">{STRINGS.settings.format.options.gif}</option>
            <option value="apng">{STRINGS.settings.format.options.apng}</option>
            <option value="webp">{STRINGS.settings.format.options.webp}</option>
            <option value="mp4">{STRINGS.settings.format.options.mp4}</option>
            <option value="avif">{STRINGS.settings.format.options.avif}</option>
          </select>
        </label>
        {settings.targetPreset === 'sticker' || settings.format === 'apng'
          ? <p className="profile-note">{STRINGS.settings.format.apngNote}</p>
          : settings.format === 'webp'
            ? <p className="profile-note">{STRINGS.settings.format.webpNote}</p>
            : settings.format === 'mp4'
              ? <p className="profile-note">{STRINGS.settings.format.mp4Note}</p>
              : settings.format === 'avif'
                ? <p className="profile-note">{STRINGS.settings.format.avifNote}</p>
                : null}

        <label className="select-field">
          <span>{STRINGS.settings.encoder}</span>
          <select value={settings.encoderBackend} disabled={(settings.format !== 'gif') || settings.targetPreset === 'sticker'} onChange={(event) => update('encoderBackend', event.target.value as EncoderBackend)}>
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
            <>
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
              <label className="range-field">
                <span>Motion quality <strong>{settings.gifskiMotionQuality}</strong></span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={settings.gifskiMotionQuality}
                  onChange={(event) => update('gifskiMotionQuality', clampNumber(Number(event.target.value), 1, 100))}
                  aria-label="Motion quality"
                />
              </label>
            </>
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
        {settings.optimize && health?.gifsicle?.available ? (
          <>
            <label className="select-field">
              <span>{STRINGS.settings.gifsicleColorSpace.label}</span>
              <select value={settings.gifsicleColorSpace} onChange={(e) => update('gifsicleColorSpace', e.currentTarget.value as 'srgb' | 'oklab')}>
                <option value="srgb">{STRINGS.settings.gifsicleColorSpace.srgb}</option>
                <option value="oklab">{STRINGS.settings.gifsicleColorSpace.oklab}</option>
              </select>
            </label>
            <label className="select-field">
              <span>{STRINGS.settings.gifsicleOptDither.label}</span>
              <select value={settings.gifsicleOptDither} onChange={(e) => update('gifsicleOptDither', e.currentTarget.value as 'none' | 'ordered' | 'atkinson')}>
                <option value="none">{STRINGS.settings.gifsicleOptDither.none}</option>
                <option value="ordered">{STRINGS.settings.gifsicleOptDither.ordered}</option>
                <option value="atkinson">{STRINGS.settings.gifsicleOptDither.atkinson}</option>
              </select>
            </label>
          </>
        ) : null}
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
          <div className="preset-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={savedPresets.length === 0}
              onClick={() => {
                const blob = new Blob([JSON.stringify({ version: 1, presets: savedPresets }, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'gifm-presets.json';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              {STRINGS.presets.exportAll}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    const raw = JSON.parse(await file.text());
                    const imported = Array.isArray(raw?.presets) ? raw.presets : Array.isArray(raw) ? raw : [];
                    const valid = imported.filter((p: unknown): p is SavedPreset => typeof (p as SavedPreset)?.name === 'string' && typeof (p as SavedPreset)?.settings === 'object');
                    if (!valid.length) return;
                    onImportPresets(valid);
                  } catch {
                    // Silently reject malformed files.
                  }
                };
                input.click();
              }}
            >
              {STRINGS.presets.importFile}
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

export function NumberField({
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
          onChange={(event) => {
            const raw = Number(event.target.value);
            onChange(Number.isFinite(raw) ? clampNumber(raw, min, max) : value);
          }}
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

export function ToggleField({
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
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

export function CropOverlay({ crop }: { crop: CropRect }) {
  return (
    <div className="crop-overlay" aria-hidden="true">
      <div
        className="crop-region"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
      />
    </div>
  );
}

const WEBHOOK_KEY = 'gifm:webhook:v1';

export function WebhookRow({ onSend }: { onSend: (webhookUrl: string) => void }) {
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

export function UrlImportRow({ busy, onImport }: { busy: boolean; onImport: (url: string) => void }) {
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
