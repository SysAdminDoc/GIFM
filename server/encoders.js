// Encoder functions extracted from index.js.
// All module-scope state (ffmpegPath, fontPath, etc.) is accessed through the shared ctx object.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError, formatBytes } from './encoding.js';
import { ctx } from './context.js';

export function log(job, message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 200) job.logs.shift();
}

export function checkCancelled(job) {
  if (job.cancelRequested || job.status === 'cancelled') {
    throw cancelError();
  }
}

export function cancelError() {
  return new ApiError(499, 'JOB_CANCELLED', 'Job was cancelled.');
}

export function isCancellationError(error) {
  return error instanceof ApiError && error.code === 'JOB_CANCELLED';
}

export function trackChild(job, child) {
  if (!job) return;
  if (!job.activeChildren) job.activeChildren = new Set();
  job.activeChildren.add(child);
  job.activeChild = child;
}

export function clearTrackedChild(job, child) {
  if (!job) return;
  job.activeChildren?.delete(child);
  if (job.activeChild === child) {
    job.activeChild = job.activeChildren?.values().next().value;
  }
}

export function killActiveChild(job) {
  const children = job.activeChildren?.size ? [...job.activeChildren] : job.activeChild ? [job.activeChild] : [];
  for (const child of children) {
    killChild(child);
  }
}

export function killChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2500);
  killTimer.unref?.();
}

export function videoFilterChain({ width, fps, dedupeFrames, frameDropModulo, square = false, speed = 1, playback = 'normal', crop = null, caption = null, fontFile = '', rotate = 0, flipH = false, flipV = false, colorFilter = 'none', saturation = 1, overlay = null, overlayPath = '', lilliputCrush = false, subtitlePath = '', borderRadius = 0 }) {
  const filters = [];
  if (crop?.enabled) {
    // Crop the source region first so every downstream filter works on the selected rectangle.
    filters.push(`crop='iw*${crop.w}':'ih*${crop.h}':'iw*${crop.x}':'ih*${crop.y}'`);
  }
  // Orientation (before scaling, since 90/270 swap width and height).
  if (rotate === 90) filters.push('transpose=1');
  else if (rotate === 270) filters.push('transpose=2');
  else if (rotate === 180) filters.push('transpose=1', 'transpose=1');
  if (flipH) filters.push('hflip');
  if (flipV) filters.push('vflip');
  // Color filters.
  if (colorFilter === 'grayscale') filters.push('hue=s=0');
  else if (colorFilter === 'invert') filters.push('negate');
  else if (colorFilter === 'sepia') filters.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
  if (saturation !== 1) filters.push(`eq=saturation=${saturation}`);
  if (dedupeFrames) {
    filters.push('mpdecimate', 'setpts=N/FRAME_RATE/TB');
  }
  if (frameDropModulo > 0) {
    filters.push(`select='not(eq(mod(n\\,${frameDropModulo})\\,0))'`, 'setpts=N/FRAME_RATE/TB');
  }
  if (speed && speed !== 1) {
    // Rescale presentation timestamps before resampling so fps sampling sees the new playback rate.
    filters.push(`setpts=PTS/${speed}`);
  }
  filters.push(`fps=${fps}`);
  if (square) {
    // Center-crop to a square, then scale to the locked dimension (Discord emoji/avatar are square).
    filters.push("crop='min(iw,ih)':'min(iw,ih)'", `scale=${width}:${width}:flags=lanczos`);
  } else {
    filters.push(`scale=${width}:-2:flags=lanczos`);
  }
  let chain = filters.join(',');
  const captionChain = captionFilters({ caption, fontFile, width });
  if (captionChain) chain += `,${captionChain}`;
  if (subtitlePath) {
    const escaped = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    chain += `,subtitles='${escaped}'`;
  }
  if (playback === 'reverse') {
    chain += ',reverse';
  } else if (playback === 'boomerang') {
    // Play forward, then the reversed clip, as a seamless bounce. Doubles the frame count, so auto-fit compensates.
    chain += ',split[fwd][bwd];[bwd]reverse[rev];[fwd][rev]concat=n=2';
  }
  // Burn a user image overlay on top of the finished frames via the movie filter source.
  if (overlay?.enabled && overlayPath) {
    const overlayWidth = Math.max(8, Math.round(width * overlay.scale));
    chain += `[ovbase];movie=${overlayPath},scale=${overlayWidth}:-1,format=rgba,colorchannelmixer=aa=${overlay.opacity}[ovwm];[ovbase][ovwm]overlay=${overlayPosition(overlay.position)}`;
  }
  if (lilliputCrush) {
    const lut = "clip(floor(val/8)*8+4\\,4\\,252)";
    chain += `,lutrgb=r='${lut}':g='${lut}':b='${lut}'`;
  }
  if (borderRadius > 0) {
    const r = borderRadius;
    chain += `,format=rgba,geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':a='if(gt(abs(X-W/2)-W/2+${r}\\,0)*gt(abs(Y-H/2)-H/2+${r}\\,0)\\,if(gt(hypot(abs(X-W/2)-W/2+${r}\\,abs(Y-H/2)-H/2+${r})\\,${r})\\,0\\,255)\\,255)'`;
  }
  return chain;
}

export function overlayPosition(position) {
  const margin = 'min(main_w\\,main_h)*0.03';
  if (position === 'top-left') return `${margin}:${margin}`;
  if (position === 'top-right') return `main_w-overlay_w-${margin}:${margin}`;
  if (position === 'bottom-left') return `${margin}:main_h-overlay_h-${margin}`;
  if (position === 'center') return '(main_w-overlay_w)/2:(main_h-overlay_h)/2';
  return `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
}

export function escapeMoviePath(filePath) {
  // The movie= source needs forward slashes and a double-backslash-escaped drive colon inside a filtergraph.
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

export function resolveOverlayPath(id) {
  if (!id || !/^[a-f0-9-]+\.(png|jpe?g|webp|gif)$/i.test(id)) return '';
  const resolved = path.join(ctx.overlayDir, id);
  if (path.dirname(resolved) !== ctx.overlayDir || !existsSync(resolved)) return '';
  return resolved;
}

export function resolveSubtitlePath(id) {
  if (!id || !/^sub-[a-f0-9-]+\.(srt|ass|ssa|vtt)$/i.test(id)) return '';
  const resolved = path.join(ctx.workDir, id);
  if (path.dirname(resolved) !== ctx.workDir || !existsSync(resolved)) return '';
  return resolved;
}

export function captionFilters({ caption, fontFile, width }) {
  if (!fontFile || !caption || (!caption.top && !caption.bottom)) return '';
  const borderw = Math.max(2, Math.round(width / 120));
  const base = `fontfile=${fontFile}:expansion=none:fontcolor=white:bordercolor=black:borderw=${borderw}:fontsize=h/9:x=(w-text_w)/2`;
  const parts = [];
  if (caption.top) parts.push(`drawtext=${base}:text='${escapeDrawtextText(caption.top)}':y=h*0.05`);
  if (caption.bottom) parts.push(`drawtext=${base}:text='${escapeDrawtextText(caption.bottom)}':y=h*0.95-text_h`);
  return parts.join(',');
}

export function escapeDrawtextPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

export function escapeDrawtextText(text) {
  // Single-quoted drawtext value with expansion=none: escape backslashes first,
  // then semicolons/colons (filter-graph delimiters), then close/reopen quotes around apostrophes.
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

export function strategyLabel({ width, fps, colors, dedupeFrames, frameDropModulo, gifsicleLossy = 0, optimizeEnabled = false, square = false }) {
  const parts = [square ? `${width}x${width} square` : `${width}px`, `${fps}fps`, `${colors} colors`];
  if (dedupeFrames) parts.push('dedupe frames');
  if (frameDropModulo > 0) parts.push(`drop every ${frameDropModulo}th frame`);
  parts.push('transparency rectangles');
  if (optimizeEnabled) parts.push(gifsicleLossy > 0 ? `gifsicle -O3 --lossy=${gifsicleLossy}` : 'gifsicle -O3');
  return parts.join(' / ');
}

export function ditherFilter(mode, bayerScale = 5) {
  if (mode === 'bayer') return `dither=bayer:bayer_scale=${bayerScale}`;
  if (mode === 'floyd_steinberg') return 'dither=floyd_steinberg';
  if (mode === 'none') return 'dither=none';
  return 'dither=sierra2_4a';
}

export function trimArgs(startSec, durationSec) {
  const args = [];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-t', String(durationSec));
  return args;
}

export function buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square = false, lilliputCrush = false }) {
  return {
    width, fps, dedupeFrames, frameDropModulo, square,
    speed: job.settings.speed, playback: job.settings.playback, crop: job.settings.crop,
    caption: job.settings.caption, fontFile: ctx.runtimeInfo.font.available ? escapeDrawtextPath(ctx.fontPath) : '',
    rotate: job.settings.rotate, flipH: job.settings.flipH, flipV: job.settings.flipV,
    colorFilter: job.settings.colorFilter, saturation: job.settings.saturation,
    overlay: job.settings.overlay, overlayPath: job.settings.overlay.enabled ? escapeMoviePath(resolveOverlayPath(job.settings.overlay.id)) : '',
    lilliputCrush, subtitlePath: resolveSubtitlePath(job.settings.subtitleId),
    borderRadius: job.settings.borderRadius ?? 0
  };
}

export function runFfmpeg(args, job, stage, progressStart, progressEnd, durationSec) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const child = spawn(ctx.ffmpegPath, ['-hide_banner', '-protocol_whitelist', 'file,pipe', ...args], { windowsHide: true });
    recordCommand(job, stage, ['-hide_banner', '-protocol_whitelist', 'file,pipe', ...args]);
    trackChild(job, child);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.trim();
      if (line) {
        const compact = line.split(/\r?\n/).slice(-2).join(' | ');
        if (/frame=|time=|speed=|palette|Output|Input/.test(compact)) {
          log(job, compact);
        }
      }

      const seconds = parseFfmpegTime(text);
      if (seconds !== null && durationSec > 0) {
        const percent = Math.min(1, seconds / durationSec);
        const prev = job.progress;
        job.progress = Math.max(job.progress, progressStart + percent * (progressEnd - progressStart));
        job.stage = stage;
        if (Math.floor(job.progress) > Math.floor(prev)) ctx.notifyJobUpdate(job);
      }
    });

    child.on('error', (error) => {
      clearTrackedChild(job, child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      if (job.cancelRequested || job.status === 'cancelled') {
        reject(cancelError());
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `ffmpeg exited with code ${code}`));
        return;
      }
      job.progress = Math.max(job.progress, progressEnd);
      resolve();
    });
  });
}

export function runFfmpegToGifski(ffmpegArgs, gifskiArgs, job, stage, progressStart, progressEnd, durationSec) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const ffmpeg = spawn(ctx.ffmpegPath, ['-hide_banner', '-protocol_whitelist', 'file,pipe', ...ffmpegArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const gifski = spawn(ctx.runtimeInfo.gifski.path, gifskiArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });
    recordCommand(job, `${stage}: ffmpeg pipe`, ['-hide_banner', '-protocol_whitelist', 'file,pipe', ...ffmpegArgs]);
    recordCommand(job, stage, gifskiArgs, ctx.runtimeInfo.gifski.path);
    trackChild(job, ffmpeg);
    trackChild(job, gifski);

    let ffmpegStderr = '';
    let gifskiStderr = '';
    let ffmpegDone = false;
    let gifskiDone = false;
    let ffmpegCode = 0;
    let gifskiCode = 0;
    let settled = false;

    ffmpeg.stdout.pipe(gifski.stdin);
    gifski.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') finish(error);
    });

    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      ffmpegStderr += text;
      const line = text.trim();
      if (line) {
        const compact = line.split(/\r?\n/).slice(-2).join(' | ');
        if (/frame=|time=|speed=|Output|Input/.test(compact)) {
          log(job, compact);
        }
      }

      const seconds = parseFfmpegTime(text);
      if (seconds !== null && durationSec > 0) {
        const percent = Math.min(1, seconds / durationSec);
        job.progress = Math.max(job.progress, progressStart + percent * (progressEnd - progressStart) * 0.65);
        job.stage = stage;
      }
    });

    gifski.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      gifskiStderr += text;
      const line = text.trim();
      if (line) log(job, line.split(/\r?\n/).slice(-2).join(' | '));
    });

    ffmpeg.on('error', finish);
    gifski.on('error', finish);
    ffmpeg.on('close', (code) => {
      clearTrackedChild(job, ffmpeg);
      ffmpegCode = code ?? 0;
      ffmpegDone = true;
      maybeResolve();
    });
    gifski.on('close', (code) => {
      clearTrackedChild(job, gifski);
      gifskiCode = code ?? 0;
      gifskiDone = true;
      maybeResolve();
    });

    function maybeResolve() {
      if (!ffmpegDone || !gifskiDone || settled) return;
      if (job.cancelRequested || job.status === 'cancelled') {
        finish(cancelError());
        return;
      }

      if (ffmpegCode !== 0) {
        finish(new Error(ffmpegStderr.trim().split(/\r?\n/).slice(-8).join('\n') || `ffmpeg exited with code ${ffmpegCode}`));
        return;
      }

      if (gifskiCode !== 0) {
        finish(new Error(gifskiStderr.trim().split(/\r?\n/).slice(-8).join('\n') || `gifski exited with code ${gifskiCode}`));
        return;
      }

      settled = true;
      job.progress = Math.max(job.progress, progressEnd);
      resolve();
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      ffmpeg.stdout.destroy();
      gifski.stdin.destroy();
      killChild(ffmpeg);
      killChild(gifski);
      clearTrackedChild(job, ffmpeg);
      clearTrackedChild(job, gifski);
      reject(error);
    }
  });
}

export function runGifsicle(inputPath, outputPath, lossy, job, stage) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequested || job.status === 'cancelled') {
      reject(cancelError());
      return;
    }

    const args = ['-O3'];
    if (lossy > 0) args.push(`--lossy=${Math.round(lossy)}`);
    if (job.settings.gifsicleColorSpace === 'oklab') args.push('--gamma=oklab');
    if (job.settings.gifsicleOptDither === 'ordered') args.push('--dither=ordered');
    else if (job.settings.gifsicleOptDither === 'atkinson') args.push('--dither=atkinson');
    args.push(inputPath, '-o', outputPath);
    const child = spawn(ctx.runtimeInfo.gifsicle.path, args, { windowsHide: true });
    recordCommand(job, stage, args, ctx.runtimeInfo.gifsicle.path);
    trackChild(job, child);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTrackedChild(job, child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTrackedChild(job, child);
      if (job.cancelRequested || job.status === 'cancelled') {
        reject(cancelError());
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-4).join('\n') || `gifsicle exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

export async function encodeWithFfmpeg({ job, attempt, palettePattern, palettePath, outputPath, startSec, durationSec, width, fps, colors, dedupeFrames, frameDropModulo, square = false }) {
  const chainOpts = buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square, lilliputCrush: job.settings.targetPreset !== 'custom' });
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      `${videoFilterChain(chainOpts)},palettegen=max_colors=${colors}:stats_mode=${job.settings.perFramePalette ? 'single' : job.settings.paletteMode}`,
      '-frames:v',
      '1',
      '-y',
      palettePattern
    ],
    job,
    `Attempt ${attempt}: palette`,
    5,
    26,
    durationSec
  );
  checkCancelled(job);

  job.stage = `Attempt ${attempt}: encode`;
  const dither = ditherFilter(job.settings.dither, job.settings.bayerScale);
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-i',
      palettePath,
      '-lavfi',
      `${videoFilterChain(chainOpts)}[x];[x][1:v]paletteuse=${dither}:diff_mode=rectangle${job.settings.perFramePalette ? ':new=1' : ''}`,
      '-loop',
      String(job.settings.loopCount),
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: encode`,
    26,
    95,
    durationSec
  );
}

export async function encodeWithApng({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false }) {
  // APNG keeps full colour, so no palette pass is needed; -plays maps the loop convention (0 = infinite, 1 = once).
  const plays = job.settings.loopCount === 0 ? 0 : job.settings.loopCount === -1 ? 1 : job.settings.loopCount;
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain(buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square })),
      '-f',
      'apng',
      '-plays',
      String(plays),
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: apng`,
    5,
    95,
    durationSec
  );
}

export async function encodeWithWebp({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false, gifsicleLossy = 0 }) {
  // libwebp encodes animated WebP directly (no palette). The auto-fit lossy lever maps to -quality,
  // and the loop convention (0 = infinite, -1 = play once) maps to -loop.
  const quality = Math.max(15, Math.min(90, Math.round(80 - gifsicleLossy * 0.4)));
  const loops = job.settings.loopCount === 0 ? 0 : job.settings.loopCount === -1 ? 1 : job.settings.loopCount;
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain(buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square })),
      '-c:v',
      'libwebp',
      '-loop',
      String(loops),
      '-quality',
      String(quality),
      '-compression_level',
      '6',
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: webp`,
    5,
    95,
    durationSec
  );
}

export async function encodeWithMp4({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false, gifsicleLossy = 0 }) {
  // Discord autoplays muted MP4 inline, so a silent faststart H.264 is the smallest "GIF-like" deliverable.
  // The auto-fit lossy lever maps to CRF (higher = smaller); loop count does not apply to MP4.
  const crf = Math.max(20, Math.min(40, Math.round(26 + gifsicleLossy * 0.1)));
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain(buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square })),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: mp4`,
    5,
    95,
    durationSec
  );
}

export async function encodeWithAvif({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false, gifsicleLossy = 0 }) {
  // Animated AVIF via libaom. cpu-used 8 keeps the slow reference encoder usable; the lossy lever drives CRF.
  const crf = Math.max(20, Math.min(50, Math.round(30 + gifsicleLossy * 0.12)));
  await runFfmpeg(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain(buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square })),
      '-c:v',
      'libaom-av1',
      '-crf',
      String(crf),
      '-b:v',
      '0',
      '-cpu-used',
      '8',
      '-pix_fmt',
      'yuv420p',
      '-y',
      outputPath
    ],
    job,
    `Attempt ${attempt}: avif`,
    5,
    95,
    durationSec
  );
}

export async function encodeWithGifski({ job, attempt, outputPath, startSec, durationSec, width, fps, dedupeFrames, frameDropModulo, square = false }) {
  if (!ctx.runtimeInfo.gifski.available) {
    throw new ApiError(400, 'GIFSKI_UNAVAILABLE', 'Set GIFM_GIFSKI_PATH to use the gifski encoder backend.');
  }

  const gifskiArgs = ['--quality', String(job.settings.gifskiQuality)];
  if (job.settings.gifskiMotionQuality !== job.settings.gifskiQuality) {
    gifskiArgs.push('--motion-quality', String(job.settings.gifskiMotionQuality));
  }
  if (job.settings.loopCount !== 0) gifskiArgs.push('--repeat', String(job.settings.loopCount));
  gifskiArgs.push('--output', outputPath, '-');

  await runFfmpegToGifski(
    [
      ...trimArgs(startSec, durationSec),
      '-i',
      job.inputPath,
      '-vf',
      videoFilterChain(buildChainOpts(job, { width, fps, dedupeFrames, frameDropModulo, square })),
      '-pix_fmt',
      'yuv420p',
      '-f',
      'yuv4mpegpipe',
      '-'
    ],
    gifskiArgs,
    job,
    `Attempt ${attempt}: gifski`,
    5,
    95,
    durationSec
  );
}

export async function optimizeOutput({ job, attempt, outputPath, lossy }) {
  const stage = `Attempt ${attempt}: optimize`;
  job.stage = stage;
  const tempPath = `${outputPath}.opt.gif`;
  try {
    await runGifsicle(outputPath, tempPath, lossy, job, stage);
    const optimized = await fs.stat(tempPath).catch(() => null);
    if (optimized && optimized.size > 0) {
      await fs.rm(outputPath, { force: true });
      await fs.rename(tempPath, outputPath);
      log(job, `Attempt ${attempt}: gifsicle -O3${lossy > 0 ? ` --lossy=${lossy}` : ''} -> ${formatBytes(optimized.size)}`);
      return;
    }
    await removeFileLocal(tempPath);
  } catch (error) {
    if (isCancellationError(error)) {
      await removeFileLocal(tempPath);
      throw error;
    }
    // A failed optimization must never fail the encode; keep the unoptimized GIF.
    await removeFileLocal(tempPath);
    log(job, `Attempt ${attempt}: gifsicle optimization skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

// Local helper for optimizeOutput — mirrors the removeFile from index.js.
async function removeFileLocal(filePath) {
  if (!filePath) return true;
  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
    throw error;
  }
}

export function recordCommand(job, stage, args, tool = ctx.ffmpegPath) {
  job.commands.push({
    stage,
    tool,
    args,
    command: [tool, ...args].map(commandToken).join(' ')
  });
  if (job.commands.length > 20) job.commands.shift();
}

export function commandToken(value) {
  const text = String(value);
  if (!/[\s"']/g.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function parseFfmpegTime(text) {
  const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
