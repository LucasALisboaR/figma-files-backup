import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSavedPathOwners,
  claimBackupDestination,
  resolveBackupDestination,
  sanitizeName,
} from '../utils.js'

test('sanitizeName removes invalid Windows filename characters', () => {
  assert.equal(sanitizeName('Design/System:Final?'), 'Design_System_Final_')
})

test('sanitizeName prevents path segments and reserved device names', () => {
  assert.equal(sanitizeName('.'), 'sem-nome')
  assert.equal(sanitizeName('..'), 'sem-nome')
  assert.equal(sanitizeName('CON.txt'), 'sem-nome')
})

test('sanitizeName normalizes whitespace, truncates, and handles empty values', () => {
  assert.equal(sanitizeName('  Design   System  '), 'Design System')
  assert.equal(sanitizeName(''), 'sem-nome')
  assert.equal(sanitizeName('a'.repeat(120)).length, 100)
})

test('resolveBackupDestination preserves files with identical names', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-backup-destination-'))
  const owners = new Map()
  const common = {
    outDir,
    projectName: 'Produto',
    fileName: 'Dashboard',
    extension: '.fig',
    pathOwners: owners,
  }

  const first = resolveBackupDestination({ ...common, fileKey: 'abcdefgh-first' })
  fs.mkdirSync(path.dirname(first), { recursive: true })
  fs.writeFileSync(first, 'first')
  claimBackupDestination(owners, first, 'abcdefgh-first')

  const second = resolveBackupDestination({ ...common, fileKey: 'ijklmnop-second' })

  assert.equal(path.basename(first), 'Dashboard.fig')
  assert.equal(path.basename(second), 'Dashboard [ijklmnop].fig')
  assert.notEqual(first, second)
})

test('resolveBackupDestination reuses the path owned by the same Figma file', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-backup-owner-'))
  const savedAs = path.join('Produto', 'Dashboard.fig')
  const manifest = {
    first: { fileKey: 'file-1', savedAs },
  }
  const owners = buildSavedPathOwners(manifest, outDir)

  const destination = resolveBackupDestination({
    outDir,
    projectName: 'Produto',
    fileName: 'Dashboard',
    extension: '.fig',
    fileKey: 'file-1',
    pathOwners: owners,
  })

  assert.equal(destination, path.resolve(outDir, savedAs))
})

test('duplicate paths from an old manifest are separated on the next download', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-backup-legacy-'))
  const savedAs = path.join('Produto', 'Dashboard.fig')
  const manifest = {
    first: { fileKey: 'file-1', savedAs },
    second: { fileKey: 'file-2', savedAs },
  }
  const owners = buildSavedPathOwners(manifest, outDir)

  const destination = resolveBackupDestination({
    outDir,
    projectName: 'Produto',
    fileName: 'Dashboard',
    extension: '.fig',
    fileKey: 'file-2',
    pathOwners: owners,
  })

  assert.equal(path.basename(destination), 'Dashboard [file-2].fig')
})
