export const STRINGS = {
  app: {
    name: 'GIFM',
    subtitle: (version: string) => `v${version} local GIF maker`,
    ready: 'Ready for video or GIF',
    sourceSize: (size: string) => `${size} source`,
    filesSelected: (count: number) => `${count} files selected`,
    runtimeAria: 'Local runtime status',
    localOnly: 'Local only',
    ffmpegReady: 'FFmpeg ready',
    ffmpegUnavailable: 'FFmpeg unavailable',
    runtimePending: 'Checking runtime',
    targetStatus: (label: string, size: string) => label === 'Custom' ? `Custom target ${size}` : `${label} target`
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
    cancelFailed: 'Cancel failed',
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
    saveCancelled: 'Save cancelled',
    jobCancelled: 'Job cancelled',
    presetSaved: (name: string) => `Preset saved: ${name}`,
    presetLoaded: (name: string) => `Preset loaded: ${name}`,
    presetDeleted: (name: string) => `Preset deleted: ${name}`,
    selectionCleared: 'Selection cleared'
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
      { id: 'nitro', label: 'Nitro 500 MB', targetMb: 500, description: 'Full Nitro file sharing limit.' },
      { id: 'emoji', label: 'Emoji 256 KB', targetMb: 256 / 1024, description: 'Custom animated emoji upload ceiling.' },
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
    delete: 'Delete'
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
    paletteMode: 'Palette mode',
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
    }
  },
  input: {
    workspaceAria: 'Input and encoding',
    fileAria: 'Choose video or GIF file',
    heading: 'Drop video or GIF',
    description: 'MP4, MOV, WebM, AVI, MKV, and GIF files stay on this machine while GIFM probes, previews, and fits them locally.',
    browse: 'Browse',
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
    openOutput: 'Open output',
    saveAs: 'Save as',
    altText: 'Alt text',
    copyAltText: 'Copy alt text',
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
    idle: 'Idle'
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
    gifDescription: 'GIF image'
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

export type UiStrings = typeof STRINGS;
