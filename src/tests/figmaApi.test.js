import test from 'node:test'
import assert from 'node:assert/strict'
import { listFolderFiles, listSubfolders, listTeamFolders } from '../figmaApi.js'

test('Figma API helpers call the expected endpoints and return collections', async () => {
  const originalFetch = globalThis.fetch
  const requests = []

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    const payload = url.includes('/teams/')
      ? { folders: [{ id: 'folder-1', name: 'Design System' }] }
      : url.includes('/subfolders')
        ? { folders: [{ id: 'folder-2', name: 'Components' }] }
        : { files: [{ key: 'file-1', name: 'Atoms', last_modified: '2026-09-10' }] }
    return new Response(JSON.stringify(payload), { status: 200 })
  }

  try {
    assert.deepEqual(await listTeamFolders('team-1', 'token'), [{ id: 'folder-1', name: 'Design System' }])
    assert.deepEqual(await listSubfolders('folder-1', 'token'), [{ id: 'folder-2', name: 'Components' }])
    assert.deepEqual(await listFolderFiles('folder-1', 'token'), [{ key: 'file-1', name: 'Atoms', last_modified: '2026-09-10' }])
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(requests.map(request => request.url), [
    'https://api.figma.com/v2/teams/team-1/folders',
    'https://api.figma.com/v2/folders/folder-1/subfolders',
    'https://api.figma.com/v2/folders/folder-1/files',
  ])
  assert.equal(requests[0].options.headers['X-Figma-Token'], 'token')
})