const en = {
  app: {
    name: 'GIFM',
    subtitle: (version: string) => `v${version} local GIF maker`,
    ready: 'Ready for video or GIF',
    sourceSize: (size: string) => `${size} source`,
    filesSelected: (count: number) => `${count} files selected`,
    runtimeAria: 'Local runtime status',
    localeLabel: 'Language',
    localOnly: 'Local only',
    ffmpegReady: 'FFmpeg ready',
    ffmpegUnavailable: 'FFmpeg unavailable',
    runtimePending: 'Checking runtime',
    targetStatus: (label: string, size: string) => label === 'Custom' ? `Custom target ${size}` : `${label} target`,
    theme: {
      label: 'Theme',
      options: {
        dark: 'Dark',
        light: 'Light',
        highContrast: 'High contrast'
      }
    }
  },
  errors: {
    fatalTitle: 'GIFM stopped rendering',
    reload: 'Reload',
    probeFailed: 'Probe failed',
    statusFailed: 'Status check failed',
    encodeStartFailed: 'Encoding failed to start',
    outputUnavailable: 'Output is not available.',
    downloadFailed: 'Download failed',
    saveFailed: 'Save failed',
    webhookFailed: 'Could not send to Discord',
    copyFailed: 'Copy failed',
    cancelFailed: 'Cancel failed',
    noSourceFile: 'Select a video before preparing clips.',
    sourcePrepareFailed: 'Could not prepare the source video',
    importFailed: 'Could not import that URL',
    outputOpenFailed: 'Could not open output location',
    recentUnavailable: 'Recent output is no longer available'
  },
  notices: {
    fileLoaded: (name: string) => `${name} loaded`,
    filesLoaded: (count: number) => `${count} files loaded`,
    submittingJobs: (count: number) => `Submitting ${count} jobs`,
    encodingStarted: 'Encoding started',
    jobsSubmitted: 'Jobs submitted',
    noJobsSubmitted: 'No jobs were submitted',
    outputOpened: 'Output location opened',
    gifSaved: 'GIF saved',
    altTextCopied: 'Alt text copied',
    webhookSending: 'Sending to Discord',
    webhookSent: 'Sent to Discord',
    diagnosticsCopied: 'Diagnostics copied',
    saveCancelled: 'Save cancelled',
    jobCancelled: 'Job cancelled',
    presetSaved: (name: string) => `Preset saved: ${name}`,
    presetLoaded: (name: string) => `Preset loaded: ${name}`,
    presetDeleted: (name: string) => `Preset deleted: ${name}`,
    presetsImported: (count: number) => `${count} preset${count === 1 ? '' : 's'} imported`,
    importingUrl: 'Downloading video from URL',
    preparingSource: (name: string) => `Preparing ${name} for repeated clip exports`,
    sourcePrepared: (name: string) => `${name} prepared for clip exports`,
    clipAdded: (name: string) => `${name} added`,
    clipUpdated: (name: string) => `${name} updated`,
    clipLoaded: (name: string) => `${name} loaded into the timeline`,
    clipDeleted: (name: string) => `${name} deleted`,
    submittingClips: (count: number) => `Submitting ${count} clip export${count === 1 ? '' : 's'}`,
    clipJobsSubmitted: 'Clip exports submitted',
    selectionCleared: 'Selection cleared',
    recentCleared: 'Recent outputs cleared'
  },
  target: {
    title: 'Target',
    subtitle: 'Discord-ready size controls',
    ariaPresetGroup: 'Target size preset',
    sizeLabel: 'Target',
    customUnit: 'MB',
    profiles: [
      { id: 'free', label: 'Free 10 MB', targetMb: 10, description: 'Standard account file uploads.' },
      { id: 'nitro-basic', label: 'Basic 50 MB', targetMb: 50, description: 'Nitro Basic file sharing limit.' },
      { id: 'boosted', label: 'Boosted 100 MB', targetMb: 100, description: 'Level 3 server boost upload limit.' },
      { id: 'nitro', label: 'Nitro 500 MB', targetMb: 500, description: 'Full Nitro file sharing limit.' },
      { id: 'emoji', label: 'Emoji 256 KB', targetMb: 256 / 1024, description: 'Custom animated emoji upload ceiling.' },
      { id: 'sticker', label: 'Sticker 512 KB', targetMb: 512 / 1024, description: 'Square 320x320 APNG sticker.' },
      { id: 'avatar', label: 'Icon/avatar 10 MB', targetMb: 10, description: 'Square GIF guidance for avatars and server icons.' },
      { id: 'custom', label: 'Custom', targetMb: 10, description: 'Use a specific byte target.' }
    ]
  },
  presets: {
    savedLabel: 'Saved preset',
    choose: 'Choose preset',
    namePlaceholder: 'Preset name',
    save: 'Save',
    load: 'Load',
    delete: 'Delete',
    exportAll: 'Export presets',
    importFile: 'Import presets'
  },
  settings: {
    sections: {
      target: {
        title: 'Target profile',
        description: 'Choose the Discord ceiling before tuning quality.'
      },
      clip: {
        title: 'Clip and output',
        description: 'Set dimensions, timing, and frame rate.'
      },
      transform: {
        title: 'Advanced transforms',
        description: 'Crop, captions, overlays, rotation, flips, and color treatments.'
      },
      encoding: {
        title: 'Encoding strategy',
        description: 'Control palette quality and fitting behavior.'
      },
      presets: {
        title: 'Saved presets',
        description: 'Store repeatable Discord export setups.'
      }
    },
    width: 'Width',
    fps: 'FPS',
    start: 'Start',
    duration: 'Duration',
    palette: 'Palette',
    dither: 'Dither',
    format: {
      label: 'Output format',
      options: {
        gif: 'Animated GIF',
        apng: 'APNG (sticker)',
        webp: 'Animated WebP',
        mp4: 'MP4 (silent loop)',
        avif: 'Animated AVIF'
      },
      apngNote: 'APNG keeps full color for Discord stickers. gifsicle optimization and the gifski encoder do not apply.',
      webpNote: 'Animated WebP is much smaller than GIF and plays natively in Discord (except animated avatars, which require GIF).',
      mp4Note: 'Discord autoplays muted MP4 inline. This is the smallest, highest-quality option, but is a video file, not an image.',
      avifNote: 'Animated AVIF gives the smallest files but encodes slowly. Discord plays it; avatars still require GIF.'
    },
    bayerScale: {
      label: 'Bayer scale'
    },
    paletteMode: 'Palette mode',
    perFramePalette: {
      label: 'Per-frame palette',
      description: 'Compute a fresh palette for every frame (higher fidelity for fast-cutting clips, larger files). GIF only.'
    },
    encoder: 'Encoder',
    units: {
      px: 'px',
      fps: 'fps',
      seconds: 'sec',
      colors: 'colors'
    },
    ditherOptions: {
      sierra: 'Sierra 2-4A',
      bayer: 'Bayer',
      floydSteinberg: 'Floyd-Steinberg',
      none: 'None'
    },
    paletteModeOptions: {
      diff: 'Scene diff',
      full: 'Full frame',
      single: 'Single palette'
    },
    encoderOptions: {
      ffmpeg: 'FFmpeg palette',
      gifski: 'gifski'
    },
    encoderNotes: {
      ffmpeg: 'Bundled FFmpeg palette encoder.',
      gifski: 'Uses GIFM_GIFSKI_PATH. Confirm gifski licensing before redistributing output workflows.',
      gifskiUnavailable: 'gifski unavailable'
    },
    autoFit: {
      label: 'Auto fit',
      on: 'On',
      off: 'Off',
      description: 'Retry with lower width, FPS, and colors until the GIF fits.'
    },
    allowTrim: {
      label: 'Allow duration trim',
      description: 'Only trims when every visual-quality lever is exhausted.'
    },
    optimize: {
      label: 'Optimize with gifsicle',
      description: 'Run a gifsicle -O3 pass and use lossy compression as an auto-fit lever for smaller GIFs.',
      unavailable: 'gifsicle not detected. Install gifsicle on PATH or set GIFM_GIFSICLE_PATH to enable optimization.'
    },
    gifsicleColorSpace: {
      label: 'Color space',
      srgb: 'sRGB (default)',
      oklab: 'Oklab (perceptual)'
    },
    gifsicleOptDither: {
      label: 'Optimizer dithering',
      none: 'None',
      ordered: 'Ordered',
      atkinson: 'Atkinson'
    },
    gifskiQuality: {
      label: 'gifski quality'
    },
    loop: {
      label: 'Loop',
      options: {
        infinite: 'Infinite',
        once: 'Play once',
        three: 'Loop 3 times',
        five: 'Loop 5 times'
      }
    },
    squareNote: {
      emoji: 'Emoji output is center-cropped to a square 128x128 GIF to meet Discord’s animated emoji requirement.',
      sticker: 'Sticker output is a center-cropped square 320x320 APNG to meet Discord’s sticker requirement.',
      avatar: 'Avatar output is center-cropped to a square GIF for Discord avatars and server icons.'
    },
    speed: {
      label: 'Speed',
      option: (value: number) => `${value}x`
    },
    playback: {
      label: 'Playback',
      options: {
        normal: 'Normal',
        reverse: 'Reverse',
        boomerang: 'Boomerang'
      }
    },
    caption: {
      top: 'Top caption',
      bottom: 'Bottom caption',
      placeholder: 'Optional meme text',
      unavailable: 'Caption font missing. Reinstall GIFM to restore assets/fonts.'
    },
    borderRadius: {
      label: 'Corner radius'
    },
    subtitle: {
      label: 'Subtitle file',
      upload: 'Upload SRT/ASS',
      replace: 'Replace subtitle',
      clear: 'Remove'
    },
    overlay: {
      label: 'Image overlay',
      description: 'Burn a logo, sticker, or watermark onto the output.',
      choose: 'Choose image',
      replace: 'Replace image',
      uploadFailed: 'Could not upload overlay image',
      position: 'Overlay position',
      size: 'Overlay size',
      opacity: 'Overlay opacity',
      positions: {
        topLeft: 'Top left',
        topRight: 'Top right',
        bottomLeft: 'Bottom left',
        bottomRight: 'Bottom right',
        center: 'Center'
      }
    },
    rotate: {
      label: 'Rotate',
      options: {
        none: 'None',
        cw90: '90 clockwise',
        deg180: '180',
        ccw90: '90 counter-clockwise'
      }
    },
    flipH: 'Flip horizontal',
    flipV: 'Flip vertical',
    colorFilter: {
      label: 'Color filter',
      options: {
        none: 'None',
        grayscale: 'Grayscale',
        invert: 'Invert',
        sepia: 'Sepia'
      }
    },
    saturation: {
      label: 'Saturation'
    },
    crop: {
      label: 'Crop',
      description: 'Trim the frame to a region. The preview shows the kept area; sliders set position and size.',
      x: 'Left',
      y: 'Top',
      w: 'Width',
      h: 'Height'
    }
  },
  input: {
    workspaceAria: 'Input and encoding',
    fileAria: 'Choose video or GIF file',
    heading: 'Drop video or GIF',
    description: 'MP4, MOV, WebM, AVI, MKV, and GIF files stay on this machine while GIFM probes, previews, and fits them locally.',
    browse: 'Browse',
    importUrl: 'Import URL',
    urlPlaceholder: 'Paste a video URL (YouTube, Twitch clip, ...)',
    urlAria: 'Video URL to import',
    sourceRatio: 'Source ratio',
    queue: 'Queue',
    startEncoding: 'Start encoding',
    cancel: 'Cancel',
    reset: 'Reset'
  },
  trim: {
    aria: 'Trim timeline',
    probing: 'Probing source',
    title: 'Source trim',
    startAria: 'Trim start',
    endAria: 'Trim end',
    end: 'End',
    useCurrentStart: 'Use current start',
    useCurrentEnd: 'Use current end',
    metadataAria: 'Source metadata',
    duration: 'Duration',
    size: 'Size',
    fps: 'FPS',
    codec: 'Codec',
    rotation: 'Rotation',
    probe: 'Probe',
    clientMetadata: 'Client metadata',
    clientFrame: 'Client frame',
    serverProbe: 'Server probe',
    degrees: (value: number) => `${value} deg`
  },
  timeline: {
    aria: 'Timeline video editor',
    title: 'Timeline editor',
    durationLabel: (clip: string, source: string) => `${clip} clip / ${source} source`,
    playhead: (time: string) => `Playhead ${time}`,
    previewStart: 'Preview start',
    addClip: 'Add clip',
    updateClip: 'Update clip',
    sourceReady: 'Source prepared once',
    sourceReadyBody: (name: string, size: string) => `${name} (${size}) can export saved clips without another upload.`,
    sourceNotReady: 'Source not prepared',
    sourceNotReadyBody: 'Prepare the selected video once before exporting many saved clips.',
    prepareSource: 'Prepare source',
    reprepareSource: 'Prepare again',
    preparingSource: 'Preparing',
    clipListAria: 'Saved GIF clips',
    clipBinTitle: 'Saved GIF cuts',
    clipCount: (count: number) => `${count} cut${count === 1 ? '' : 's'} ready`,
    noClips: 'No cuts saved',
    exportAll: 'Export all cuts',
    exportClip: 'Export',
    exportCsv: 'Export CSV',
    importCsv: 'Import CSV',
    deleteClip: (name: string) => `Delete ${name}`,
    emptyTitle: 'Cut list',
    emptyBody: 'Mark start and end points, then add cuts here before exporting GIFs.',
    defaultClipName: (index: number) => `Clip ${String(index).padStart(2, '0')}`
  },
  preview: {
    aria: 'Preview and output',
    title: 'Preview',
    noFile: 'No file selected',
    selectedGifAlt: 'Selected GIF preview',
    emptyTitle: 'Preview is ready',
    empty: 'Select a video or GIF to inspect the clip before encoding.'
  },
  output: {
    aria: 'Output',
    title: 'Output',
    download: 'Download',
    open: 'Open',
    downloadGif: 'Download GIF',
    downloadFormats: {
      gif: 'Download GIF',
      apng: 'Download APNG',
      webp: 'Download WebP',
      mp4: 'Download MP4',
      avif: 'Download AVIF'
    },
    outputPreviewAlt: 'Encoded output preview',
    openOutput: 'Open output',
    saveAs: 'Save as',
    altText: 'Alt text',
    copyAltText: 'Copy alt text',
    sendToDiscord: 'Send to Discord',
    webhookPlaceholder: 'Discord webhook URL (optional)',
    webhookAria: 'Discord webhook URL',
    failedRecovery: 'Adjust settings and press Start encoding again, or reset the selection.',
    cancelledRecovery: 'The job was cancelled. Press Start encoding to run it again.',
    emptyTitle: 'No export yet',
    empty: 'Finished GIFs appear here with exact byte size, fit status, and save actions.',
    errorCode: (code: string) => `Error code: ${code}`,
    fitsProfile: (profileLabel: string, description: string) => `Fits ${profileLabel}. ${description}`,
    overProfile: (profileLabel: string, lever: string) => `Over ${profileLabel}. Try ${lever}.`,
    levers: {
      width: 'lower width first',
      fps: 'lower FPS',
      colors: 'fewer palette colors',
      trim: 'enabling duration trim',
      shorter: 'a shorter clip',
      smallerTarget: 'a smaller target profile or simpler source motion'
    }
  },
  attempts: {
    aria: 'Encoding attempts',
    title: 'Fit attempts',
    defaultStrategy: 'standard',
    running: 'running',
    rejected: 'rejected',
    emptyTitle: 'Compression trace',
    empty: 'Each fit attempt will show the width, FPS, palette, strategy, and resulting size.'
  },
  recent: {
    aria: 'Recent outputs',
    title: 'Recent outputs',
    clear: 'Clear',
    emptyTitle: 'Session history',
    empty: 'Completed GIFs from this session stay here for quick download or reveal.'
  },
  batch: {
    aria: 'Batch queue',
    title: 'Batch queue',
    downloadAll: (count: number) => `Download all (${count})`,
    attempts: (count: number) => `${count} attempts`,
    failedSubmit: 'Failed to submit',
    pending: 'Pending',
    queued: (position: number) => `Queued #${position}`,
    complete: 'Complete',
    cancelled: 'Cancelled',
    failed: 'Failed'
  },
  progress: {
    aria: 'Encoding progress',
    idle: 'Ready to encode',
    readyBody: 'Progress, warnings, and queue state appear here once an export starts.'
  },
  log: {
    aria: 'Log',
    title: 'Log',
    emptyTitle: 'Encoder log',
    empty: 'FFmpeg output appears here once an encode starts.'
  },
  diagnostics: {
    aria: 'Diagnostics',
    title: 'Diagnostics',
    ffmpeg: 'FFmpeg',
    ffprobe: 'FFprobe',
    encoder: 'Encoder',
    optimizer: 'Optimizer',
    optimizerUnavailable: 'gifsicle not detected',
    platform: 'Platform',
    estimate: 'Estimate',
    unknown: 'Unknown',
    emptyValue: '-',
    latestCommand: 'Latest FFmpeg command',
    noCommand: 'No FFmpeg command has run yet.',
    copyJson: 'Copy JSON',
    downloadJson: 'Download JSON'
  },
  queueStatus: {
    running: 'Running',
    cancelled: 'Cancelled',
    failed: 'Failed',
    done: 'Done'
  },
  alt: {
    default: 'Animated GIF',
    fromName: (name: string) => `${name} animated GIF`
  },
  files: {
    gifDescription: 'GIF image',
    apngDescription: 'APNG image',
    webpDescription: 'WebP image',
    mp4Description: 'MP4 video',
    avifDescription: 'AVIF image'
  },
  format: {
    zeroBytes: '0 B',
    byteUnits: ['B', 'KB', 'MB', 'GB'],
    tinyRatio: '<0.1x',
    zeroSeconds: '0.00s',
    seconds: (value: string) => `${value}s`,
    minuteSeconds: (minutes: number, seconds: string) => `${minutes}:${seconds}`
  }
} as const;

export type UiStrings = typeof en;
export type Locale = 'en' | 'es' | 'fr';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Espanol',
  fr: 'Francais'
};

// Spanish overrides for the visible interface chrome. Any key omitted here falls back to English
// through the deep merge below, so the catalog never has missing strings.
const esOverrides = {
  app: {
    subtitle: (version: string) => `v${version} creador local de GIF`,
    ready: 'Listo para video o GIF',
    localOnly: 'Solo local',
    ffmpegReady: 'FFmpeg listo',
    ffmpegUnavailable: 'FFmpeg no disponible',
    runtimePending: 'Comprobando entorno',
    theme: {
      label: 'Tema',
      options: { dark: 'Oscuro', light: 'Claro', highContrast: 'Alto contraste' }
    }
  },
  input: {
    heading: 'Suelta un video o GIF',
    description: 'Los archivos MP4, MOV, WebM, AVI, MKV y GIF permanecen en este equipo mientras GIFM los analiza, previsualiza y ajusta localmente.',
    browse: 'Examinar',
    queue: 'Cola',
    startEncoding: 'Iniciar codificacion',
    cancel: 'Cancelar',
    reset: 'Restablecer'
  },
  target: {
    title: 'Objetivo',
    subtitle: 'Controles de tamano para Discord'
  },
  settings: {
    width: 'Ancho',
    duration: 'Duracion',
    palette: 'Paleta',
    dither: 'Tramado',
    encoder: 'Codificador',
    speed: { label: 'Velocidad', option: (value: number) => `${value}x` },
    playback: { label: 'Reproduccion', options: { normal: 'Normal', reverse: 'Inverso', boomerang: 'Boomerang' } },
    sections: {
      target: { title: 'Perfil objetivo', description: 'Elige el limite de Discord antes de ajustar la calidad.' },
      clip: { title: 'Clip y salida', description: 'Ajusta dimensiones, tiempo y velocidad de fotogramas.' },
      encoding: { title: 'Estrategia de codificacion', description: 'Controla la calidad de la paleta y el ajuste.' },
      presets: { title: 'Ajustes guardados', description: 'Guarda configuraciones de exportacion reutilizables.' }
    }
  },
  preview: {
    title: 'Vista previa',
    noFile: 'Ningun archivo seleccionado',
    emptyTitle: 'Vista previa lista',
    empty: 'Selecciona un video o GIF para inspeccionar el clip antes de codificar.'
  },
  output: {
    title: 'Salida',
    download: 'Descargar',
    open: 'Abrir',
    downloadGif: 'Descargar GIF',
    saveAs: 'Guardar como',
    emptyTitle: 'Sin exportacion aun',
    empty: 'Los GIF terminados apareceran aqui con su tamano exacto, estado de ajuste y acciones de guardado.'
  },
  diagnostics: {
    title: 'Diagnostico',
    platform: 'Plataforma',
    estimate: 'Estimacion'
  },
  log: {
    title: 'Registro',
    emptyTitle: 'Registro del codificador',
    empty: 'La salida de FFmpeg aparece aqui cuando empieza una codificacion.'
  }
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : DeepPartial<T[K]> };

function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (override as T) ?? base;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const overrideValue = (override as Record<string, unknown>)[key];
    const baseValue = (base as Record<string, unknown>)[key];
    if (overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue) && typeof overrideValue !== 'function') {
      result[key] = deepMerge(baseValue, overrideValue as DeepPartial<typeof baseValue>);
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
}

// French overrides for the visible interface chrome; omitted keys fall back to English.
const frOverrides = {
  app: {
    subtitle: (version: string) => `v${version} createur de GIF local`,
    ready: 'Pret pour une video ou un GIF',
    localOnly: 'Local uniquement',
    ffmpegReady: 'FFmpeg pret',
    theme: {
      label: 'Theme',
      options: { dark: 'Sombre', light: 'Clair', highContrast: 'Contraste eleve' }
    }
  },
  input: {
    heading: 'Deposez une video ou un GIF',
    browse: 'Parcourir',
    importUrl: 'Importer une URL',
    startEncoding: 'Lancer l\'encodage',
    reset: 'Reinitialiser'
  },
  target: { title: 'Cible', subtitle: 'Controles de taille pour Discord' },
  preview: { title: 'Apercu', noFile: 'Aucun fichier selectionne' },
  output: { title: 'Sortie', saveAs: 'Enregistrer sous' },
  settings: {
    width: 'Largeur',
    duration: 'Duree',
    speed: { label: 'Vitesse', option: (value: number) => `${value}x` }
  }
};

const LOCALES: Record<Locale, UiStrings> = {
  en,
  es: deepMerge(en, esOverrides as DeepPartial<UiStrings>),
  fr: deepMerge(en, frOverrides as DeepPartial<UiStrings>)
};

let activeLocale: Locale = 'en';

export function setActiveLocale(locale: Locale) {
  activeLocale = LOCALES[locale] ? locale : 'en';
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

// STRINGS forwards every top-level access to the active locale catalog, so existing `STRINGS.x.y`
// usage switches language at render time without threading a context through every component.
export const STRINGS: UiStrings = new Proxy(en, {
  get(_target, prop: string) {
    return (LOCALES[activeLocale] as Record<string, unknown>)[prop];
  }
}) as UiStrings;
