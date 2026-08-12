import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { MANIFEST_VERSION, hydrateManifest, readManifest } from './manifest.js';

export function createManifestStore({ manifestPath, sources, jobs, fsApi = fs, exists = existsSync }) {
  let manifestWritePending = false;
  let manifestWriteQueued = false;
  const state = {
    status: 'missing',
    recoveryPath: '',
    message: 'No saved manifest was found.'
  };

  async function load() {
    const result = await readManifest(manifestPath, { fsApi, exists });
    state.status = result.status;
    state.recoveryPath = result.recoveryPath;
    state.message = result.message;

    if (!result.data) return;

    const restored = hydrateManifest(result.data, { exists });
    for (const entry of restored.sources) {
      sources.set(entry.id, { ...entry, outputCandidates: new Set() });
    }
    for (const entry of restored.jobs) {
      jobs.set(entry.id, {
        ...entry,
        outputCandidates: new Set(),
        logs: entry.logs ?? [],
        commands: entry.commands ?? [],
        warnings: entry.warnings ?? [],
        attempts: entry.attempts ?? []
      });
    }
  }

  function save() {
    if (manifestWritePending) {
      manifestWriteQueued = true;
      return Promise.resolve();
    }
    manifestWritePending = true;
    return flush();
  }

  async function flush() {
    try {
      const persistedSources = [];
      for (const source of sources.values()) {
        if (source.inputPath && exists(source.inputPath)) {
          persistedSources.push({
            id: source.id,
            inputPath: source.inputPath,
            inputName: source.inputName,
            inputSize: source.inputSize,
            sourceKind: source.sourceKind,
            createdAt: source.createdAt,
            lastUsedAt: source.lastUsedAt,
            metadata: source.metadata
          });
        }
      }
      const persistedJobs = [];
      for (const job of jobs.values()) {
        if (job.status === 'complete' && job.outputPath && exists(job.outputPath)) {
          persistedJobs.push({
            id: job.id,
            status: job.status,
            inputName: job.inputName,
            inputSize: job.inputSize,
            outputPath: job.outputPath,
            outputBytes: job.outputBytes,
            targetBytes: job.targetBytes,
            downloadUrl: job.downloadUrl,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            warnings: job.warnings,
            attempts: job.attempts,
            settings: job.settings,
            outputMeta: job.outputMeta,
            discordChecks: job.discordChecks
          });
        }
      }
      const tempPath = `${manifestPath}.tmp`;
      await fsApi.writeFile(tempPath, JSON.stringify({ version: MANIFEST_VERSION, sources: persistedSources, jobs: persistedJobs }, null, 2));
      await fsApi.rename(tempPath, manifestPath);
    } catch {
      // Non-fatal — manifest is a convenience, not a hard requirement.
    } finally {
      manifestWritePending = false;
      if (manifestWriteQueued) {
        manifestWriteQueued = false;
        await save();
      }
    }
  }

  return { state, load, save, flush };
}
