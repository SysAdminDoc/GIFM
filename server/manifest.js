import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_VERSION = 1;

export async function readManifest(manifestPath, {
  fsApi = fs,
  exists = existsSync,
  now = () => new Date()
} = {}) {
  let raw;
  try {
    raw = await fsApi.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        status: 'missing',
        data: null,
        recoveryPath: '',
        message: 'No saved manifest was found.'
      };
    }

    return {
      status: 'unreadable',
      data: null,
      recoveryPath: '',
      message: `The saved manifest could not be read: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return recoverManifest(manifestPath, 'corrupt', 'The saved manifest was corrupt JSON and was preserved for recovery.', { fsApi, exists, now });
  }

  if (!isManifestShape(data) || data.version !== MANIFEST_VERSION) {
    const version = Number.isInteger(data?.version) ? data.version : 'unknown';
    return recoverManifest(
      manifestPath,
      `unsupported-v${version}`,
      `The saved manifest uses unsupported version ${version} and was preserved for recovery.`,
      { fsApi, exists, now }
    );
  }

  return {
    status: 'loaded',
    data,
    recoveryPath: '',
    message: 'Saved manifest loaded.'
  };
}

export function hydrateManifest(data, { exists = existsSync } = {}) {
  if (!isManifestShape(data) || data.version !== MANIFEST_VERSION) {
    return { sources: [], jobs: [] };
  }

  return {
    sources: data.sources.filter((entry) => entry && entry.inputPath && exists(entry.inputPath)),
    jobs: data.jobs.filter((entry) => entry && entry.outputPath && entry.status === 'complete' && exists(entry.outputPath))
  };
}

function isManifestShape(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.sources) && Array.isArray(value.jobs));
}

async function recoverManifest(manifestPath, suffix, message, { fsApi, exists, now }) {
  const recoveryPath = await uniqueRecoveryPath(manifestPath, suffix, { exists, now });
  try {
    await fsApi.rename(manifestPath, recoveryPath);
    return { status: suffix === 'corrupt' ? 'recovered-corrupt' : 'recovered-unsupported', data: null, recoveryPath, message };
  } catch (error) {
    return {
      status: suffix === 'corrupt' ? 'corrupt' : 'unsupported',
      data: null,
      recoveryPath: '',
      message: `${message} Automatic preservation failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function uniqueRecoveryPath(manifestPath, suffix, { exists, now }) {
  const timestamp = now().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '');
  const base = `${manifestPath}.${suffix}-${timestamp}`;
  let candidate = `${base}.json`;
  let counter = 1;
  while (exists(candidate)) {
    candidate = `${base}-${counter}.json`;
    counter += 1;
  }
  return path.resolve(candidate);
}
