import fs from 'fs'
import path from 'path'
import { logInfo, logWarn } from './utils.js'

/**
 * @typedef {Object} ManifestEntry
 * @property {string} fileKey
 * @property {string} fileName
 * @property {string} projectId
 * @property {string} projectName
 * @property {string} teamId
 * @property {string} lastModified   - ISO string vindo da API
 * @property {string} url
 * @property {'pending'|'downloaded'|'skipped'|'failed'|'restricted'|'library'} status
 * @property {string} [savedAs]      - caminho relativo do arquivo salvo
 * @property {string} [downloadedAt] - ISO string da data do download
 * @property {string} [error]        - mensagem de erro se status === 'failed'
 */

/**
 * Carrega o manifest existente ou retorna objeto vazio.
 * @param {string} manifestPath
 * @returns {Record<string, ManifestEntry>}
 */
export function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return {}
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    logWarn(`Não foi possível ler o manifest (${err.message}). Iniciando do zero.`)
    return {}
  }
}

/**
 * Persiste o manifest em disco (cria o diretório se necessário).
 * @param {string} manifestPath
 * @param {Record<string, ManifestEntry>} manifest
 */
export function saveManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
}

/**
 * Atualiza uma entrada no manifest e persiste imediatamente.
 * @param {string} manifestPath
 * @param {Record<string, ManifestEntry>} manifest
 * @param {string} fileKey
 * @param {Partial<ManifestEntry>} updates
 */
export function updateEntry(manifestPath, manifest, fileKey, updates) {
  manifest[fileKey] = { ...(manifest[fileKey] ?? {}), ...updates }
  saveManifest(manifestPath, manifest)
}

/**
 * Popula o manifest com os arquivos descobertos na Etapa 1,
 * preservando entradas já existentes (para não perder status de downloads anteriores).
 * @param {string} manifestPath
 * @param {Record<string, ManifestEntry>} manifest
 * @param {ManifestEntry[]} files  - array vindo de figmaApi.mapAllFiles
 * @param {boolean} force          - se true, reseta status de tudo para 'pending'
 */
export function populateManifest(manifestPath, manifest, files, force = false) {
  let added = 0
  let updated = 0

  for (const file of files) {
    const existing = manifest[file.fileKey]

    if (!existing) {
      manifest[file.fileKey] = { ...file, status: 'pending' }
      added++
    } else {
      const changed = existing.lastModified !== file.lastModified
      if (force || changed) {
        manifest[file.fileKey] = {
          ...existing,
          ...file,
          status: 'pending',
          // limpa dados do download anterior se o arquivo mudou
          savedAs: undefined,
          downloadedAt: undefined,
          error: undefined,
        }
        updated++
      }
      // se não mudou e não é force, mantém o status existente (ex: 'downloaded')
    }
  }

  saveManifest(manifestPath, manifest)
  logInfo(`Manifest atualizado: ${added} novos, ${updated} atualizados, ${Object.keys(manifest).length} total.`)
  return manifest
}

// Status que entram na fila quando --status não é informado:
// "os que faltam" (nunca tentados) + "os que falharam".
export const DEFAULT_QUEUE_STATUSES = ['pending', 'failed']

/**
 * Retorna as entradas do manifest que ainda precisam ser baixadas.
 * @param {Record<string, ManifestEntry>} manifest
 * @param {{ force?: boolean, projects?: string[], statuses?: string[] }} opts
 * @returns {ManifestEntry[]}
 */
export function getPendingEntries(manifest, { force = false, projects = [], statuses = [] } = {}) {
  const wanted = statuses.length > 0 ? statuses : DEFAULT_QUEUE_STATUSES

  const entries = Object.values(manifest).filter(entry => {
    // filtro por projeto (nome ou id)
    if (projects.length > 0) {
      const match = projects.some(p =>
        p === entry.projectId ||
        entry.projectName?.toLowerCase().includes(p.toLowerCase())
      )
      if (!match) return false
    }

    if (force) return true
    return wanted.includes(entry.status)
  })

  // Ordena: pendentes primeiro (nunca tentados), falhados por último.
  // Isso evita que um arquivo problemático bloqueie os demais no início da fila.
  return entries.sort((a, b) => {
    const order = { pending: 0, restricted: 1, library: 2, downloaded: 3, failed: 4 }
    const oa = order[a.status] ?? 0
    const ob = order[b.status] ?? 0
    if (oa !== ob) return oa - ob
    return a.projectName.localeCompare(b.projectName) || a.fileName.localeCompare(b.fileName)
  })
}
