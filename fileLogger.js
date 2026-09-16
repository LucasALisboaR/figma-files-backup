/**
 * fileLogger.js
 * Grava um log detalhado em backups/logs/<timestamp>.log
 * ao final de cada execução.
 */

import fs from 'fs'
import path from 'path'

/**
 * Monta e grava o relatório final da execução.
 *
 * @param {object} opts
 * @param {string}   opts.outDir        - diretório raiz dos backups
 * @param {object}   opts.manifest      - manifest completo (Record<fileKey, ManifestEntry>)
 * @param {string[]} opts.selectedProjects - projetos que foram selecionados para download
 * @param {string[]} opts.teamIds       - IDs dos times processados
 * @param {object}   opts.counts        - { downloaded, skipped, failed, restricted }
 * @param {Date}     opts.startedAt     - momento de início da execução
 * @param {string}   [opts.runMode]     - 'full' | 'map-only' | 'from-manifest'
 * @returns {string} caminho do arquivo de log gerado
 */
export function writeRunLog(opts) {
  const {
    outDir,
    manifest,
    selectedProjects = [],
    teamIds = [],
    counts = {},
    startedAt = new Date(),
    runMode = 'full',
  } = opts

  const finishedAt = new Date()
  const elapsed    = ((finishedAt - startedAt) / 1000).toFixed(0)

  // Garante que o diretório de logs existe
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  // Nome do arquivo: YYYY-MM-DD_HH-MM-SS.log
  const stamp = startedAt.toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .slice(0, 19)
  const logPath = path.join(logsDir, `${stamp}.log`)

  // ─── Agrupa entradas por status ──────────────────────
  const entries = Object.values(manifest)
  const byStatus = {
    downloaded: entries.filter(e => e.status === 'downloaded'),
    failed:     entries.filter(e => e.status === 'failed'),
    restricted: entries.filter(e => e.status === 'restricted'),
    pending:    entries.filter(e => e.status === 'pending'),
    skipped:    entries.filter(e => e.status === 'skipped'),
  }
  // ─── Agrupa todos os arquivos por projeto ─────────────
  const byProject = {}
  for (const entry of entries) {
    if (!byProject[entry.projectName]) byProject[entry.projectName] = []
    byProject[entry.projectName].push(entry)
  }

  // ─── Monta texto do log ───────────────────────────────
  const lines = []

  const h = (title) => {
    lines.push('')
    lines.push('═'.repeat(60))
    lines.push(`  ${title}`)
    lines.push('═'.repeat(60))
  }

  const row = (label, value) => {
    lines.push(`  ${label.padEnd(22)} ${value}`)
  }

  // Cabeçalho
  lines.push('╔══════════════════════════════════════════════════════════╗')
  lines.push('║            FIGMA BACKUP — RELATÓRIO DE EXECUÇÃO          ║')
  lines.push('╚══════════════════════════════════════════════════════════╝')
  lines.push('')
  row('Início:',       startedAt.toLocaleString('pt-BR'))
  row('Término:',      finishedAt.toLocaleString('pt-BR'))
  row('Duração:',      `${elapsed}s`)
  row('Modo:',         runMode)
  row('Times:',        teamIds.join(', ') || '—')
  row('Selecionados:', selectedProjects.length > 0 ? selectedProjects.join(', ') : 'todos')

  // Resumo de contagens
  h('RESUMO')
  row('Total mapeados:',  String(entries.length))
  row('✓ Baixados:',      String(byStatus.downloaded.length))
  row('– Já existiam:',   String(counts.skipped ?? 0))
  row('! Restritos:',     String(byStatus.restricted.length))
  row('✗ Falhados:',      String(byStatus.failed.length))
  row('⏳ Pendentes:',    String(byStatus.pending.length))
  // Arquivos baixados com sucesso
  if (byStatus.downloaded.length > 0) {
    h('BAIXADOS COM SUCESSO')
    for (const e of byStatus.downloaded.sort(sortByProject)) {
      lines.push(`  [OK] ${e.projectName} / ${e.fileName}`)
      if (e.savedAs) lines.push(`       → ${e.savedAs}`)
      if (e.downloadedAt) lines.push(`       em ${new Date(e.downloadedAt).toLocaleString('pt-BR')}`)
    }
  }

  // Arquivos falhados
  if (byStatus.failed.length > 0) {
    h('FALHADOS')
    for (const e of byStatus.failed.sort(sortByProject)) {
      lines.push(`  [ERRO] ${e.projectName} / ${e.fileName}`)
      if (e.error) lines.push(`         ${e.error}`)
    }
  }

  // Arquivos com restrição de cópia
  if (byStatus.restricted.length > 0) {
    h('RESTRITOS (copy restricted)')
    for (const e of byStatus.restricted.sort(sortByProject)) {
      lines.push(`  [REST] ${e.projectName} / ${e.fileName}`)
    }
  }

  // Arquivos ainda pendentes (não processados)
  if (byStatus.pending.length > 0) {
    h('PENDENTES (não processados nesta execução)')
    for (const e of byStatus.pending.sort(sortByProject)) {
      lines.push(`  [PEND] ${e.projectName} / ${e.fileName}`)
    }
  }

  // Inventário completo por projeto
  h('INVENTÁRIO COMPLETO POR PROJETO')
  for (const [projName, projEntries] of Object.entries(byProject).sort()) {
    const total  = projEntries.length
    const done   = projEntries.filter(e => e.status === 'downloaded').length
    const failed = projEntries.filter(e => e.status === 'failed').length
    lines.push('')
    lines.push(`  ▶ ${projName}  (${done}/${total} baixados${failed ? `, ${failed} falhados` : ''})`)
    for (const e of projEntries.sort((a, b) => a.fileName.localeCompare(b.fileName))) {
      const icon = statusIcon(e.status)
      lines.push(`      ${icon} ${e.fileName}  [${e.status}]`)
    }
  }

  lines.push('')
  lines.push('─'.repeat(60))
  lines.push(`  Log gerado em: ${logPath}`)
  lines.push('─'.repeat(60))
  lines.push('')

  // Escreve o arquivo
  fs.writeFileSync(logPath, lines.join('\n'), 'utf-8')

  return logPath
}

function sortByProject(a, b) {
  const proj = a.projectName.localeCompare(b.projectName)
  return proj !== 0 ? proj : a.fileName.localeCompare(b.fileName)
}

function statusIcon(status) {
  const icons = {
    downloaded: '✓',
    failed:     '✗',
    restricted: '!',
    pending:    '⏳',
    skipped:    '–',
    library:    '📚',
  }
  return icons[status] ?? '?'
}
