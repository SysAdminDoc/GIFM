export type ClientProbeMeta = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string;
  rotation: number;
  probeSource: 'client';
  frameSampled: boolean;
};

const CLIENT_PROBE_TIMEOUT_MS = 4000;
const CLIENT_FRAME_TIMEOUT_MS = 2500;

export async function probeClientMedia(file: File, objectUrl: string, signal: AbortSignal): Promise<ClientProbeMeta | null> {
  if (signal.aborted) throw abortError();

  if (isGif(file)) {
    return probeImage(file, objectUrl, signal);
  }

  if (!isLikelyBrowserVideo(file)) {
    return null;
  }

  return probeVideo(file, objectUrl, signal);
}

async function probeImage(file: File, objectUrl: string, signal: AbortSignal): Promise<ClientProbeMeta | null> {
  const image = new Image();
  try {
    await waitForMediaEvent({
      target: image,
      loadEvent: 'load',
      errorEvent: 'error',
      signal,
      timeoutMs: CLIENT_PROBE_TIMEOUT_MS,
      start: () => {
        image.src = objectUrl;
      }
    });

    return {
      durationSec: null,
      width: image.naturalWidth || null,
      height: image.naturalHeight || null,
      fps: null,
      codec: clientCodecLabel(file),
      rotation: 0,
      probeSource: 'client',
      frameSampled: Boolean(image.naturalWidth && image.naturalHeight)
    };
  } catch {
    return null;
  } finally {
    image.removeAttribute('src');
  }
}

async function probeVideo(file: File, objectUrl: string, signal: AbortSignal): Promise<ClientProbeMeta | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  try {
    await waitForMediaEvent({
      target: video,
      loadEvent: 'loadedmetadata',
      errorEvent: 'error',
      signal,
      timeoutMs: CLIENT_PROBE_TIMEOUT_MS,
      start: () => {
        video.src = objectUrl;
        void video.load();
      }
    });

    const width = video.videoWidth || null;
    const height = video.videoHeight || null;
    if (!width || !height) return null;

    return {
      durationSec: Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration.toFixed(3)) : null,
      width,
      height,
      fps: null,
      codec: clientCodecLabel(file),
      rotation: 0,
      probeSource: 'client',
      frameSampled: await sampleVideoFrame(video, signal)
    };
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function sampleVideoFrame(video: HTMLVideoElement, signal: AbortSignal) {
  try {
    if (signal.aborted) throw abortError();
    const targetTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(0.1, video.duration / 2) : 0;
    if (targetTime > 0 && Math.abs(video.currentTime - targetTime) > 0.01) {
      await waitForMediaEvent({
        target: video,
        loadEvent: 'seeked',
        errorEvent: 'error',
        signal,
        timeoutMs: CLIENT_FRAME_TIMEOUT_MS,
        start: () => {
          video.currentTime = targetTime;
        }
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(video, 0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function waitForMediaEvent({
  target,
  loadEvent,
  errorEvent,
  signal,
  timeoutMs,
  start
}: {
  target: EventTarget;
  loadEvent: string;
  errorEvent: string;
  signal: AbortSignal;
  timeoutMs: number;
  start: () => void;
}) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Client media preflight timed out.'));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Client media preflight failed.'));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      target.removeEventListener(loadEvent, onLoad);
      target.removeEventListener(errorEvent, onError);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    target.addEventListener(loadEvent, onLoad, { once: true });
    target.addEventListener(errorEvent, onError, { once: true });
    start();
  });
}

function isGif(file: File) {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

function isLikelyBrowserVideo(file: File) {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|webm|ogv)$/i.test(file.name);
}

function clientCodecLabel(file: File) {
  if (file.type) return file.type.replace(/^video\//, '').replace(/^image\//, '');
  const extension = file.name.split('.').pop();
  return extension ? extension.toLowerCase() : 'browser';
}

function abortError() {
  return new DOMException('Client media preflight aborted.', 'AbortError');
}
