/**
 * scripts/figmaBackup/index.js
 *
 * CLI de backup de arquivos Figma.
 *
 * Uso:
 *   node src/index.js                          # Etapa 1 + seleção interativa + Etapa 2
 *   node src/index.js --map-only               # Só mapeamento (sem browser)
 *   node src/index.js --from-manifest          # Pula mapeamento, usa manifest existente
 *   node src/index.js --project "Nome" --force # Filtra por projeto, força re-download
 *   node src/index.js --headed --limit 10      # Browser visível, máx 10 arquivos
 *   node src/index.js --yes                    # Não interativo: baixa tudo sem perguntar
 *
 * Seleção da fila por status (padrão: pending,failed — os que faltam + os que falharam):
 *   node src/index.js --from-manifest                            # pendentes + falhados
 *   node src/index.js --from-manifest --status failed            # só os que falharam
 *   node src/index.js --from-manifest --status pending           # só os nunca tentados
 *   node src/index.js --from-manifest --status restricted        # revalida os restritos
 *   node src/index.js --from-manifest --status failed --limit 5  # testa 5 antes de soltar tudo
 *
 * Veja README.md para configuração de variáveis de ambiente.
 */

import fs from 'fs'
import config from './config.js'
import { mapAllFiles } from './figmaApi.js'
import { runDownloads } from './downloader.js'
import { loadManifest, populateManifest, getPendingEntries, DEFAULT_QUEUE_STATUSES } from './manifest.js'
import { selectProjects } from './prompt.js'
import { writeRunLog } from './fileLogger.js'
import { logInfo, logSuccess, logWarn, logError, logSummary, log } from './utils.js'

// Proteção global: impede que promises rejeitadas não capturadas derrubem o processo.
// O downloader já trata todos os erros internamente; este handler é a última linha de defesa.
process.on('unhandledRejection', (reason) => {
  logWarn(`[aviso] Promise rejeitada não capturada: ${reason?.message ?? reason}`)
  // Não encerra o processo — permite que o loop de downloads continue
})

async function main() {
  const startedAt = new Date()

  log('')
  log('═══════════════════════════════════════════════════')
  log('  Figma Backup — ' + startedAt.toLocaleString('pt-BR'))
  log('═══════════════════════════════════════════════════')
  log('')

  fs.mkdirSync(config.outDir, { recursive: true })

  let manifest = loadManifest(config.manifestPath)
  logInfo(`Diretório de saída: ${config.outDir}`)
  logInfo(`Manifest:           ${config.manifestPath}`)
  log('')

  // ─── Etapa 1: Mapeamento via REST API ─────────────────────────────────────
  if (!config.fromManifest) {
    logInfo('Etapa 1 — Mapeamento via Figma REST API')
    logInfo(`Times configurados: ${config.teamIds.join(', ')}`)
    log('')

    const files = await mapAllFiles(config.teamIds, config.accessToken)

    if (files.length === 0) {
      logWarn('Nenhum arquivo encontrado. Verifique os TEAM_IDS e o FIGMA_ACCESS_TOKEN.')
      writeRunLog({ outDir: config.outDir, manifest, teamIds: config.teamIds, counts: {}, startedAt, runMode: 'full' })
      process.exit(0)
    }

    manifest = populateManifest(config.manifestPath, manifest, files, config.force)
  } else {
    logInfo('--from-manifest: pulando Etapa 1, usando manifest existente.')
    if (Object.keys(manifest).length === 0) {
      logError('Manifest vazio ou não encontrado. Execute sem --from-manifest primeiro.')
      process.exit(1)
    }
    log('')
  }

  // ─── Resumo por projeto ────────────────────────────────────────────────────
  const byProject = {}
  for (const entry of Object.values(manifest)) {
    byProject[entry.projectName] = (byProject[entry.projectName] ?? 0) + 1
  }

  log('')
  log('  Pastas encontradas:')
  for (const [proj, count] of Object.entries(byProject).sort()) {
    log(`    ${String(count).padStart(4)}  ${proj}`)
  }
  log('')
  logInfo(`Total: ${Object.keys(manifest).length} arquivo(s) em ${Object.keys(byProject).length} pasta(s).`)

  // ─── Resumo por status ─────────────────────────────────────────────────────
  const byStatus = {}
  for (const entry of Object.values(manifest)) {
    const st = entry.status ?? 'sem status'
    byStatus[st] = (byStatus[st] ?? 0) + 1
  }

  log('')
  log('  Status no manifest:')
  for (const [st, count] of Object.entries(byStatus).sort()) {
    log(`    ${String(count).padStart(4)}  ${st}`)
  }
  log('')

  // ─── Sai se --map-only ─────────────────────────────────────────────────────
  if (config.mapOnly) {
    const logPath = writeRunLog({
      outDir: config.outDir,
      manifest,
      teamIds: config.teamIds,
      counts: {},
      startedAt,
      runMode: 'map-only',
    })
    logSuccess(`--map-only: ${Object.keys(manifest).length} arquivo(s) mapeados.`)
    logInfo(`Log salvo em: ${logPath}`)
    log('Execute sem --map-only para baixar os arquivos.')
    process.exit(0)
  }

  // ─── Seleção interativa de projetos ───────────────────────────────────────
  // Ignorada se: --yes, --project já foi passado, ou --from-manifest (assume seleção anterior)
  let selectedProjects = config.projects.length > 0 ? config.projects : []
  const skipPrompt = config.yes || config.projects.length > 0 || config.fromManifest

  if (!skipPrompt) {
    const chosen = await selectProjects(byProject)

    if (chosen === null) {
      log('  Operação cancelada pelo usuário.')
      process.exit(0)
    }

    selectedProjects = chosen
    log('')
    logInfo(`Pastas selecionadas: ${selectedProjects.join(', ')}`)
    log('')
  } else if (selectedProjects.length > 0) {
    logInfo(`Filtro por projeto: ${selectedProjects.join(', ')}`)
  } else {
    logInfo('Todas as pastas serão baixadas (--yes / --from-manifest).')
  }

  // ─── Etapa 2: Download via Playwright ─────────────────────────────────────
  log('')
  logInfo('Etapa 2 — Download via Playwright')

  const queueStatuses = config.statuses.length > 0 ? config.statuses : DEFAULT_QUEUE_STATUSES

  const unknownStatuses = config.statuses.filter(s => !Object.keys(byStatus).includes(s))
  if (unknownStatuses.length > 0) {
    logWarn(`--status: nenhum arquivo com status "${unknownStatuses.join('", "')}" no manifest.`)
  }

  const pending = getPendingEntries(manifest, {
    force: config.force,
    // Se o usuário selecionou pastas na tela interativa, usa isso como filtro
    projects: selectedProjects,
    statuses: config.statuses,
  })

  const alreadyDone = Object.values(manifest).filter(e =>
    e.status === 'downloaded' || e.status === 'restricted'
  ).length

  if (pending.length === 0) {
    logSuccess(`Nada na fila para os status: ${queueStatuses.join(', ')} (${alreadyDone} já processados).`)
    logInfo('Use --status <lista> para escolher outros status ou --force para re-baixar tudo.')
    const logPath = writeRunLog({
      outDir: config.outDir, manifest, selectedProjects,
      teamIds: config.teamIds, counts: { downloaded: 0, skipped: alreadyDone, failed: 0, restricted: 0 },
      startedAt, runMode: config.fromManifest ? 'from-manifest' : 'full',
    })
    logInfo(`Log salvo em: ${logPath}`)
    process.exit(0)
  }

  // Composição da fila, para deixar claro o que será retentado
  const queueByStatus = {}
  for (const entry of pending) {
    const st = entry.status ?? 'sem status'
    queueByStatus[st] = (queueByStatus[st] ?? 0) + 1
  }
  const queueDetail = Object.entries(queueByStatus)
    .sort()
    .map(([st, n]) => `${n} ${st}`)
    .join(' + ')

  logInfo(`${pending.length} arquivo(s) na fila: ${queueDetail}.`)
  if (config.force) logInfo('--force: todos os status foram reenfileirados.')
  else logInfo(`Filtro de status: ${queueStatuses.join(', ')}.`)
  if (config.limit < Infinity) logInfo(`Limite por execução: ${config.limit} arquivos.`)
  if (config.headed) logInfo('Modo headed: o browser vai aparecer na tela.')
  log('')

  const counts = await runDownloads(pending, config.manifestPath, manifest, config.outDir, {
    sessionCookie: config.sessionCookie,
    headed: config.headed,
    downloadTimeout: config.downloadTimeout,
    limit: config.limit,
  })

  // Recarrega manifest após os downloads (updateEntry persiste em tempo real)
  manifest = loadManifest(config.manifestPath)

  counts.skipped = Object.values(manifest).filter(e =>
    e.status === 'downloaded' && !pending.find(p => p.fileKey === e.fileKey)
  ).length

  // ─── Resumo no console ────────────────────────────────────────────────────
  logSummary(counts)

  // ─── Log em arquivo ───────────────────────────────────────────────────────
  const logPath = writeRunLog({
    outDir: config.outDir,
    manifest,
    selectedProjects,
    teamIds: config.teamIds,
    counts,
    startedAt,
    runMode: config.fromManifest ? 'from-manifest' : 'full',
  })
  logInfo(`Log detalhado salvo em: ${logPath}`)

  if (counts.abortedByCaptcha) {
    log('')
    logError('Execução abortada: o Figma exigiu captcha após o clique em "Save local copy".')
    logInfo('O arquivo em que parou voltou para a fila como "pending" — nada foi perdido.')
    logInfo('Veja screenshots/007-after-save-click.png para confirmar o diálogo.')
    logInfo('Para resolver o captcha na mão, rode com --headed e clique em "Verificar".')
    process.exit(1)
  }

  if (counts.failed > 0) {
    logWarn(`${counts.failed} arquivo(s) falharam. Execute novamente — entradas "failed" são retentadas automaticamente.`)
    process.exit(1)
  }
}

main().catch(err => {
  logError(`Erro fatal: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
