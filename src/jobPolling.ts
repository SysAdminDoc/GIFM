import { useEffect, useRef } from 'react';
import type { Job } from './types';

export async function fetchJob(id: string): Promise<Job> {
  const response = await fetch(`/api/jobs/${id}`);
  if (!response.ok) {
    throw new Error(`Job status request failed (${response.status})`);
  }
  return response.json() as Promise<Job>;
}

// Polls the given job ids on an interval and applies any successful updates. Shared by the single-job
// view and the batch queue so there is one polling loop instead of two duplicated effects.
export function usePollJobs(ids: string[], onUpdates: (jobs: Job[]) => void, intervalMs = 800) {
  const idsKey = ids.join(',');
  const callbackRef = useRef(onUpdates);
  callbackRef.current = onUpdates;
  useEffect(() => {
    if (!idsKey) return undefined;
    const pollIds = idsKey.split(',');
    const interval = window.setInterval(async () => {
      const updates = (await Promise.all(pollIds.map((id) => fetchJob(id).catch(() => null)))).filter((value): value is Job => Boolean(value));
      if (updates.length) callbackRef.current(updates);
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [idsKey, intervalMs]);
}
