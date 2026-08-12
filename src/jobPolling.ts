import { useEffect, useRef } from 'react';
import type { Job, UrlImportJob } from './types';

export async function fetchJob(id: string): Promise<Job> {
  const response = await fetch(`/api/jobs/${id}`);
  if (!response.ok) {
    throw new Error(`Job status request failed (${response.status})`);
  }
  return response.json() as Promise<Job>;
}

export function usePollJobs(ids: string[], onUpdates: (jobs: Job[]) => void, intervalMs = 800) {
  const idsKey = ids.join(',');
  const callbackRef = useRef(onUpdates);
  callbackRef.current = onUpdates;
  useEffect(() => {
    if (!idsKey) return undefined;
    const pollIds = idsKey.split(',');

    const source = new EventSource(`/api/jobs/events?ids=${encodeURIComponent(idsKey)}`);
    let sseActive = false;

    source.onopen = () => { sseActive = true; };
    source.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data) as Job;
        callbackRef.current([job]);
      } catch {
        // Ignore malformed events.
      }
    };
    source.onerror = () => { sseActive = false; };

    const interval = window.setInterval(async () => {
      if (sseActive) return;
      const updates = (await Promise.all(pollIds.map((id) => fetchJob(id).catch(() => null)))).filter((value): value is Job => Boolean(value));
      if (updates.length) callbackRef.current(updates);
    }, intervalMs);

    return () => {
      source.close();
      window.clearInterval(interval);
    };
  }, [idsKey, intervalMs]);
}

export async function fetchUrlImport(id: string): Promise<UrlImportJob> {
  const response = await fetch(`/api/import-url/${id}`);
  if (!response.ok) {
    throw new Error(`URL import status request failed (${response.status})`);
  }
  return response.json() as Promise<UrlImportJob>;
}

export function usePollUrlImport(id: string, onUpdate: (job: UrlImportJob) => void, intervalMs = 500) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;
  useEffect(() => {
    if (!id) return undefined;
    let stopped = false;
    let interval: number | undefined;

    const poll = async () => {
      try {
        const job = await fetchUrlImport(id);
        if (stopped) return;
        callbackRef.current(job);
        if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
          stopped = true;
          if (interval !== undefined) window.clearInterval(interval);
        }
      } catch {
        // Keep polling; transient WebView/network errors should not lose an active import.
      }
    };

    void poll();
    interval = window.setInterval(() => { void poll(); }, intervalMs);
    return () => {
      stopped = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [id, intervalMs]);
}
