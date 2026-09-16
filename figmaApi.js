import { sleep, logInfo, logWarn, logError } from './utils.js'

const FIGMA_API_BASE = 'https://api.figma.com'

// Delay base entre chamadas à API para não estourar rate limit (300 req/min no Figma)
const BETWEEN_CALLS_MS = 250

/**
 * Wrapper de fetch com retry/backoff para 429 e 5xx.
 * Respeita o header Retry-After quando presente.
 * @param {string} url
 * @param {string} token
 * @param {number} [retries=4]
 * @returns {Promise<any>} JSON da resposta
 */
async function figmaFetch(url, token, retries = 4) {
  let attempt = 0
  let backoff = 1000

  while (true) {
    const res = await fetch(url, {
      headers: { 'X-Figma-Token': token },
    })

    if (res.ok) return res.json()

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfterHeader = res.headers.get('Retry-After')
      const wait = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : backoff

      logWarn(`[figmaApi] ${url} → HTTP ${res.status}. Tentando novamente em ${(wait / 1000).toFixed(1)}s...`)
      await sleep(wait)
      backoff = Math.min(backoff * 2, 30000)
      attempt++
      continue
    }

    // Erros permanentes (403, 404, etc.) — lança para o chamador tratar
    let body = ''
    try { body = await res.text() } catch { /* ignore */ }
    const err = new Error(`HTTP ${res.status} em ${url}: ${body}`)
    err.status = res.status
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API v2 (folders:read) — endpoints atuais do Figma após a migração de
// "Projects" para "Folders" (2025/2026). Tokens novos NÃO possuem mais
// o escopo projects:read; use folders:read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca as pastas de nível superior de um time.
 * Requer escopo: folders:read
 * GET /v2/teams/:team_id/folders
 * @param {string} teamId
 * @param {string} token
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listTeamFolders(teamId, token) {
  const url = `${FIGMA_API_BASE}/v2/teams/${teamId}/folders`
  const data = await figmaFetch(url, token)
  return data.folders ?? []
}

/**
 * Busca subpastas de uma pasta.
 * Requer escopo: folders:read
 * GET /v2/folders/:folder_id/subfolders
 * @param {string} folderId
 * @param {string} token
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listSubfolders(folderId, token) {
  const url = `${FIGMA_API_BASE}/v2/folders/${folderId}/subfolders`
  const data = await figmaFetch(url, token)
  return data.folders ?? []
}

/**
 * Busca os arquivos de uma pasta (equivalente ao antigo listProjectFiles).
 * Requer escopo: folders:read
 * GET /v2/folders/:folder_id/files
 * @param {string} folderId
 * @param {string} token
 * @returns {Promise<Array<{ key: string, name: string, last_modified: string }>>}
 */
export async function listFolderFiles(folderId, token) {
  const url = `${FIGMA_API_BASE}/v2/folders/${folderId}/files`
  const data = await figmaFetch(url, token)
  return data.files ?? []
}

// ─────────────────────────────────────────────────────────────────────────────
// Aliases para compatibilidade com o restante do código
// ─────────────────────────────────────────────────────────────────────────────
export const listTeamProjects  = listTeamFolders
export const listProjectFiles  = listFolderFiles

// ─────────────────────────────────────────────────────────────────────────────
// Traversal recursivo de pastas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coleta recursivamente todos os arquivos dentro de uma pasta e suas subpastas.
 * @param {string} folderId
 * @param {string} folderName  - nome acumulado (ex: "UI / Components")
 * @param {string} teamId
 * @param {string} token
 * @param {object[]} acc        - acumulador de resultados
 * @param {number} depth        - profundidade atual (evita loops infinitos)
 */
async function collectFolderFiles(folderId, folderName, teamId, token, acc, depth = 0) {
  if (depth > 10) {
    logWarn(`[figmaApi] Profundidade máxima de pastas atingida em "${folderName}". Pulando subpastas.`)
    return
  }

  // Arquivos desta pasta
  await sleep(BETWEEN_CALLS_MS)
  let files = []
  try {
    files = await listFolderFiles(folderId, token)
  } catch (err) {
    logWarn(`[figmaApi] Erro ao listar arquivos da pasta "${folderName}" (${folderId}): ${err.message}`)
  }

  for (const file of files) {
    acc.push({
      teamId,
      projectId: folderId,
      projectName: folderName,
      fileKey: file.key,
      fileName: file.name,
      lastModified: file.last_modified,
      url: `https://www.figma.com/file/${file.key}`,
    })
  }

  // Subpastas
  await sleep(BETWEEN_CALLS_MS)
  let subfolders = []
  try {
    subfolders = await listSubfolders(folderId, token)
  } catch (err) {
    // Endpoint pode retornar 404 em pastas sem subpastas em versões antigas — não é fatal
    if (err.status !== 404) {
      logWarn(`[figmaApi] Erro ao listar subpastas de "${folderName}": ${err.message}`)
    }
  }

  for (const sub of subfolders) {
    const subName = `${folderName} / ${sub.name}`
    logInfo(`[figmaApi]     Subpasta: "${subName}"`)
    await collectFolderFiles(sub.id, subName, teamId, token, acc, depth + 1)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento completo (entrada principal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeia todos os arquivos de todos os times fornecidos.
 * Usa os endpoints v2 com escopo folders:read.
 * Erros por time ou pasta são logados e não abortam o restante.
 *
 * @param {string[]} teamIds
 * @param {string}   token
 * @returns {Promise<Array<{
 *   teamId: string,
 *   projectId: string,
 *   projectName: string,
 *   fileKey: string,
 *   fileName: string,
 *   lastModified: string,
 *   url: string
 * }>>}
 */
export async function mapAllFiles(teamIds, token) {
  const result = []

  for (const teamId of teamIds) {
    logInfo(`[figmaApi] Buscando pastas do time ${teamId}...`)

    let folders
    try {
      folders = await listTeamFolders(teamId, token)
    } catch (err) {
      if (err.status === 403) {
        logError(
          `[figmaApi] Acesso negado ao time ${teamId} (403).\n` +
          `  Verifique:\n` +
          `  1. O token tem o escopo "folders:read" (não "projects:read" — foi descontinuado).\n` +
          `  2. O usuário dono do token é membro desse time.\n` +
          `  3. O TEAM_ID está correto (extraído de figma.com/files/team/<TEAM_ID>/...).`
        )
      } else if (err.status === 404) {
        logError(`[figmaApi] Time ${teamId} não encontrado (404). Verifique o TEAM_ID.`)
      } else {
        logError(`[figmaApi] Erro ao buscar time ${teamId}: ${err.message}`)
      }
      continue
    }

    logInfo(`[figmaApi]   ${folders.length} pasta(s) de nível superior no time ${teamId}.`)

    for (const folder of folders) {
      logInfo(`[figmaApi]   Pasta: "${folder.name}"`)
      await collectFolderFiles(folder.id, folder.name, teamId, token, result)
    }
  }

  logInfo(`[figmaApi] Mapeamento concluído: ${result.length} arquivo(s) encontrado(s).`)
  return result
}
