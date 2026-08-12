import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hydrateManifest, readManifest } from './manifest.js';

test('loads current manifests and hydrates entries with existing media paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gifm-manifest-'));
  try {
    const sourcePath = path.join(directory, 'source.mp4');
    const outputPath = path.join(directory, 'output.gif');
    const manifestPath = path.join(directory, 'manifest.json');
    await fs.writeFile(sourcePath, 'source');
    await fs.writeFile(outputPath, 'output');
    await fs.writeFile(manifestPath, JSON.stringify({
      version: 1,
      sources: [{ id: 'source-1', inputPath: sourcePath }],
      jobs: [{ id: 'job-1', status: 'complete', outputPath }]
    }));

    const result = await readManifest(manifestPath);
    assert.equal(result.status, 'loaded');
    assert.equal(result.data.version, 1);
    const restored = hydrateManifest(result.data);
    assert.deepEqual(restored.sources.map((entry) => entry.id), ['source-1']);
    assert.deepEqual(restored.jobs.map((entry) => entry.id), ['job-1']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('skips manifest entries whose source or output path no longer exists', async () => {
  const result = hydrateManifest({
    version: 1,
    sources: [
      { id: 'present', inputPath: 'present.mp4' },
      { id: 'missing', inputPath: 'missing.mp4' }
    ],
    jobs: [
      { id: 'present-job', status: 'complete', outputPath: 'present.gif' },
      { id: 'missing-job', status: 'complete', outputPath: 'missing.gif' },
      { id: 'failed-job', status: 'failed', outputPath: 'present.gif' }
    ]
  }, { exists: (value) => value.startsWith('present') });

  assert.deepEqual(result.sources.map((entry) => entry.id), ['present']);
  assert.deepEqual(result.jobs.map((entry) => entry.id), ['present-job']);
});

test('reports a missing manifest without creating recovery files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gifm-manifest-'));
  try {
    const result = await readManifest(path.join(directory, 'manifest.json'));
    assert.equal(result.status, 'missing');
    assert.equal(result.recoveryPath, '');
    assert.match(result.message, /No saved manifest/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('renames corrupt manifests and reports the recovery file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gifm-manifest-'));
  try {
    const manifestPath = path.join(directory, 'manifest.json');
    await fs.writeFile(manifestPath, '{not valid json');

    const result = await readManifest(manifestPath, { now: () => new Date('2026-08-12T01:02:03.000Z') });
    assert.equal(result.status, 'recovered-corrupt');
    assert.equal(result.data, null);
    assert.equal(await fileExists(manifestPath), false);
    assert.equal(await fileExists(result.recoveryPath), true);
    assert.match(path.basename(result.recoveryPath), /corrupt-20260812T010203000/);
    assert.match(result.message, /preserved for recovery/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('renames unsupported future manifests without discarding their contents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gifm-manifest-'));
  try {
    const manifestPath = path.join(directory, 'manifest.json');
    const futureManifest = { version: 9, sources: [{ id: 'future' }], jobs: [] };
    await fs.writeFile(manifestPath, JSON.stringify(futureManifest));

    const result = await readManifest(manifestPath, { now: () => new Date('2026-08-12T01:02:03.000Z') });
    assert.equal(result.status, 'recovered-unsupported');
    assert.equal(await fileExists(manifestPath), false);
    assert.equal(await fileExists(result.recoveryPath), true);
    assert.deepEqual(JSON.parse(await fs.readFile(result.recoveryPath, 'utf8')), futureManifest);
    assert.match(path.basename(result.recoveryPath), /unsupported-v9-20260812T010203000/);
    assert.match(result.message, /unsupported version 9/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
