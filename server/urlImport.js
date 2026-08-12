import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function createUrlImportController({
  uploadDir,
  maxUploadBytes,
  timeoutMs,
  ytdlpPath,
  ApiError,
  isPrivateHost,
  normalizeError,
  registerPreparedSource,
  publicSource,
  removeFile,
  notifyUpdate = () => {}
}) {
  const imports = new Map();

  function validateImportUrl(value) {
    const url = typeof value === 'string' ? value.trim() : '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(400, 'INVALID_URL', 'Enter a valid http(s) video URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'INVALID_URL', 'Only http and https URLs can be imported.');
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new ApiError(400, 'INVALID_URL', 'URLs pointing to private or loopback addresses are not allowed.');
    }
    return url;
  }

  function createUrlImport(url) {
    const job = {
      id: randomUUID(),
      url,
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSec: null,
      etaSec: null,
      stage: 'Starting URL import',
      source: null,
      error: '',
      errorCode: '',
      startedAt: new Date().toISOString(),
      completedAt: ''
    };
    imports.set(job.id, job);
    return job;
  }

  function getUrlImport(id) {
    return imports.get(id);
  }

  function startUrlImport(job) {
    void runUrlImport(job);
  }

  function cancelUrlImport(job) {
    if (isTerminalUrlImport(job.status)) return;
    job.cancelRequested = true;
    job.stage = 'Cancelling download';
    if (job.abortDownload) job.abortDownload(new ApiError(499, 'URL_IMPORT_CANCELLED', 'URL import cancelled.'));
    else if (job.child) {
      try { job.child.kill(); } catch { /* the process may already be exiting */ }
    }
  }

  function publicUrlImport(job) {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      speedBytesPerSec: job.speedBytesPerSec,
      etaSec: job.etaSec,
      stage: job.stage,
      source: job.source,
      error: job.error || undefined,
      errorCode: job.errorCode || undefined,
      startedAt: job.startedAt,
      completedAt: job.completedAt || undefined
    };
  }

  async function runUrlImport(job) {
    let downloadedPath = '';
    job.status = 'running';
    job.stage = 'Downloading video';
    notifyUpdate(job);

    try {
      downloadedPath = await downloadWithYtDlp(job.url, job);
      if (job.cancelRequested) throw new ApiError(499, 'URL_IMPORT_CANCELLED', 'URL import cancelled.');

      job.stage = 'Preparing downloaded video';
      job.progress = Math.max(job.progress, 98);
      notifyUpdate(job);
      const prepared = await registerPreparedSource({ filePath: downloadedPath, inputName: path.basename(downloadedPath) });
      downloadedPath = '';
      job.status = 'complete';
      job.progress = 100;
      job.stage = 'URL import complete';
      job.source = publicSource(prepared);
      job.completedAt = new Date().toISOString();
      notifyUpdate(job);
    } catch (error) {
      if (job.cancelRequested || error?.code === 'URL_IMPORT_CANCELLED') {
        job.status = 'cancelled';
        job.stage = 'URL import cancelled';
        job.error = '';
        job.errorCode = 'URL_IMPORT_CANCELLED';
      } else {
        const apiError = normalizeError(error);
        job.status = 'failed';
        job.stage = 'URL import failed';
        job.error = apiError.message;
        job.errorCode = apiError.code;
      }
      job.completedAt = new Date().toISOString();
      notifyUpdate(job);
    } finally {
      if (downloadedPath) await removeFile(downloadedPath);
      if (job.status !== 'complete') await cleanupUrlImportFiles(job.id);
      job.child = undefined;
      job.abortDownload = undefined;
    }
  }

  function downloadWithYtDlp(url, job) {
    return new Promise((resolve, reject) => {
      const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(ytdlpPath);
      const outputTemplate = path.join(uploadDir, `url-${job.id}.${isWindowsScript ? 'mp4' : '%(ext)s'}`);
      const progressArgs = isWindowsScript
        ? ['--newline']
        : [
          '--newline',
          '--progress-template',
          'download:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._percent_str)s|%(progress.eta)s|%(progress.speed)s'
        ];
      const args = [
        '--no-playlist',
        '--no-warnings',
        ...progressArgs,
        '-f',
        'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
        '--max-filesize',
        String(maxUploadBytes),
        '-o',
        outputTemplate,
        url
      ];
      const child = spawn(ytdlpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindowsScript
      });
      job.child = child;
      let stderr = '';
      let timeoutTriggered = false;
      let settled = false;
      let timeout;

      const finish = (error, filePath) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else resolve(filePath);
      };

      job.abortDownload = (error) => {
        try { child.kill(); } catch { /* the process may already be exiting */ }
        finish(error);
      };
      timeout = setTimeout(() => {
        timeoutTriggered = true;
        job.stage = 'URL download timed out';
        job.abortDownload(new ApiError(408, 'URL_DOWNLOAD_TIMEOUT', 'The download took too long and was cancelled. Try a shorter video or a direct file URL.'));
      }, timeoutMs);

      const handleOutput = (chunk) => {
        const text = chunk.toString();
        stderr = `${stderr}${text}`.slice(-65536);
        for (const line of text.split(/\r?\n/)) updateUrlImportProgress(job, line);
      };
      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);
      child.on('error', (error) => {
        if (error?.code === 'ENOENT') {
          finish(new ApiError(400, 'YTDLP_UNAVAILABLE', 'yt-dlp was not found. Install yt-dlp on PATH or set GIFM_YTDLP_PATH to enable URL import.'));
          return;
        }
        finish(error);
      });
      child.on('close', async (code) => {
        if (timeoutTriggered) {
          finish(new ApiError(408, 'URL_DOWNLOAD_TIMEOUT', 'The download took too long and was cancelled. Try a shorter video or a direct file URL.'));
          return;
        }
        if (job.cancelRequested) {
          finish(new ApiError(499, 'URL_IMPORT_CANCELLED', 'URL import cancelled.'));
          return;
        }
        if (code !== 0) {
          finish(new ApiError(422, 'URL_DOWNLOAD_FAILED', stderr.trim().split(/\r?\n/).slice(-3).join(' ') || 'Could not download the video from that URL.'));
          return;
        }
        const names = await fs.readdir(uploadDir).catch(() => []);
        const match = names.find((name) => name.startsWith(`url-${job.id}.`) && !name.endsWith('.part'));
        if (!match) {
          finish(new ApiError(422, 'URL_DOWNLOAD_FAILED', 'The download produced no file.'));
          return;
        }
        finish(null, path.join(uploadDir, match));
      });
    });
  }

  function updateUrlImportProgress(job, line) {
    const match = line.match(/^download:\s*([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)/i);
    if (!match) return;
    const [, status, downloaded, total, percent, eta, speed] = match;
    const downloadedBytes = parseProgressNumber(downloaded);
    const totalBytes = parseProgressNumber(total);
    const percentValue = parseProgressPercent(percent);
    if (downloadedBytes !== null) job.downloadedBytes = downloadedBytes;
    if (totalBytes !== null) job.totalBytes = totalBytes;
    if (percentValue !== null) job.progress = Math.min(99, Math.max(0, percentValue));
    else if (job.totalBytes > 0) job.progress = Math.min(99, Math.round((job.downloadedBytes / job.totalBytes) * 100));
    job.etaSec = parseProgressNumber(eta);
    job.speedBytesPerSec = parseProgressRate(speed);
    job.stage = status.trim().toLowerCase() === 'finished' ? 'Download finished' : 'Downloading video';
    notifyUpdate(job);
  }

  function parseProgressNumber(value) {
    const number = Number(String(value).trim());
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function parseProgressPercent(value) {
    const match = String(value).match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }

  function parseProgressRate(value) {
    const text = String(value).trim();
    const match = text.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)?\/s$/i);
    if (!match) return parseProgressNumber(text);
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;
    const units = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
    return Math.round(number * (units[match[2]?.toLowerCase() ?? 'b'] ?? 1));
  }

  async function cleanupUrlImportFiles(id) {
    const names = await fs.readdir(uploadDir).catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith(`url-${id}.`)).map((name) => removeFile(path.join(uploadDir, name))));
  }

  return {
    validateImportUrl,
    createUrlImport,
    getUrlImport,
    startUrlImport,
    cancelUrlImport,
    publicUrlImport,
    isTerminalUrlImport
  };
}

function isTerminalUrlImport(status) {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}
