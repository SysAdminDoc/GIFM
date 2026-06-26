import { useEffect, useRef, useState } from 'react';
import { STRINGS } from '../strings';
import type { Job } from '../types';

export function ProgressPanel({ job }: { job: Job | null }) {
  const progress = Math.max(0, Math.min(100, job?.progress ?? 0));
  const isActive = job?.status === 'running' || job?.status === 'queued';
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) { startRef.current = null; setElapsed(0); return undefined; }
    if (!startRef.current) startRef.current = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const eta = isActive && progress > 3 && elapsed > 2
    ? Math.round((elapsed / progress) * (100 - progress))
    : null;

  return (
    <section className="progress-panel" aria-label={STRINGS.progress.aria}>
      <div>
        <strong>{job?.stage ?? STRINGS.progress.idle}</strong>
        <span>
          {Math.round(progress)}%
          {isActive && elapsed > 0 ? ` · ${formatElapsed(elapsed)}` : ''}
          {eta !== null ? ` · ${STRINGS.progress.eta(formatElapsed(eta))}` : ''}
        </span>
      </div>
      {!job ? <p>{STRINGS.progress.readyBody}</p> : null}
      <div
        className="progress-track"
        role="progressbar"
        aria-label={job?.stage ?? STRINGS.progress.aria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      {job?.warnings.length ? (
        <ul className="warnings">
          {job.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function formatElapsed(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
