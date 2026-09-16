import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getPendingEntries,
  loadManifest,
  populateManifest,
  saveManifest,
  updateEntry,
} from '../manifest.js'

function temporaryManifestPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-backup-test-'))
  return path.join(dir, 'manifest.json')
}

function entry(overrides = {}) {
  return {
    fileKey: 'file-1',
    fileName: 'Atoms',
    projectId: 'project-1',
    projectName: 'Design System',
    teamId: 'team-1',
    lastModified: '2026-09-10T14:30:00Z',
    url: 'https://www.figma.com/file/file-1',
    status: 'pending',
    ...overrides,
  }
}

test('manifest persists and loads entries', () => {
  const manifestPath = temporaryManifestPath()
  const manifest = { 'file-1': entry() }

  saveManifest(manifestPath, manifest)

  assert.deepEqual(loadManifest(manifestPath), manifest)
})

test('updateEntry merges updates and persists them', () => {
  const manifestPath = temporaryManifestPath()
  const manifest = { 'file-1': entry() }

  updateEntry(manifestPath, manifest, 'file-1', { status: 'downloaded', savedAs: 'Atoms.fig' })

  assert.equal(loadManifest(manifestPath)['file-1'].status, 'downloaded')
  assert.equal(manifest['file-1'].savedAs, 'Atoms.fig')
})

test('populateManifest preserves unchanged entries and resets changed files', () => {
  const manifestPath = temporaryManifestPath()
  const unchanged = entry({ status: 'downloaded', savedAs: 'Atoms.fig' })
  const changed = entry({ fileKey: 'file-2', lastModified: 'old', status: 'downloaded', savedAs: 'Old.fig' })
  const manifest = { 'file-1': unchanged, 'file-2': changed }

  populateManifest(manifestPath, manifest, [
    entry(),
    entry({ fileKey: 'file-2', lastModified: 'new', fileName: 'New' }),
    entry({ fileKey: 'file-3', fileName: 'New file' }),
  ])

  assert.equal(manifest['file-1'].status, 'downloaded')
  assert.equal(manifest['file-2'].status, 'pending')
  assert.equal(manifest['file-2'].savedAs, undefined)
  assert.equal(manifest['file-3'].status, 'pending')
})

test('getPendingEntries filters by status and project, then sorts', () => {
  const manifest = {
    failed: entry({ fileKey: 'failed', fileName: 'Zeta', status: 'failed' }),
    pending: entry({ fileKey: 'pending', fileName: 'Alpha', status: 'pending' }),
    other: entry({ fileKey: 'other', projectName: 'Other', status: 'pending' }),
  }

  const result = getPendingEntries(manifest, { projects: ['design'] })

  assert.deepEqual(result.map(item => item.fileKey), ['pending', 'failed'])
})