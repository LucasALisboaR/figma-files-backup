import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRunLog } from '../fileLogger.js'

test('writeRunLog creates a report with the manifest summary', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-backup-log-'))
  const logPath = writeRunLog({
    outDir,
    manifest: {
      'file-1': {
        projectName: 'Design System',
        fileName: 'Atoms',
        status: 'downloaded',
        savedAs: 'Design System/Atoms.fig',
      },
    },
    teamIds: ['team-1'],
    startedAt: new Date('2026-09-16T10:00:00Z'),
  })

  assert.equal(path.dirname(logPath), path.join(outDir, 'logs'))
  assert.match(fs.readFileSync(logPath, 'utf8'), /Design System \/ Atoms/)
  assert.match(fs.readFileSync(logPath, 'utf8'), /Atoms\.fig/)
})