import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Carrega o .env local do próprio diretório (não polui o .env.example da raiz)
const envPath = path.resolve(__dirname, '.env')
if (!fs.existsSync(envPath)) {
  const examplePath = path.resolve(__dirname, '.env.example')
  throw new Error(
    `Arquivo .env não encontrado em ${envPath}\n` +
    `Copie ${examplePath} para ${envPath} e preencha as variáveis.`
  )
}

// Reimportar com path explícito para garantir que o .env local seja usado
const { default: dotenv } = await import('dotenv')
dotenv.config({ path: envPath })

// Raiz do repo (dois níveis acima de scripts/figmaBackup)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

function require_env(name) {
  const val = process.env[name]
  if (!val || val.trim() === '') {
    throw new Error(`Variável de ambiente obrigatória não definida: ${name}`)
  }
  return val.trim()
}

function optional_env(name, defaultValue) {
  const val = process.env[name]
  if (!val || val.trim() === '') return defaultValue
  return val.trim()
}

// Parse de flags da CLI (args passados via process.argv)
function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {
    mapOnly: args.includes('--map-only'),
    fromManifest: args.includes('--from-manifest'),
    force: args.includes('--force'),
    headed: args.includes('--headed') || optional_env('FIGMA_HEADED', 'false') === 'true',
    // --yes: pula a seleção interativa e baixa tudo (útil em automações/CI)
    yes: args.includes('--yes') || args.includes('-y'),
  }

  // --out <dir>
  const outIdx = args.indexOf('--out')
  flags.outDir = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.resolve(REPO_ROOT, optional_env('BACKUP_OUT_DIR', 'backups'))

  // --limit <n>
  const limitIdx = args.indexOf('--limit')
  flags.limit = limitIdx !== -1 && args[limitIdx + 1]
    ? parseInt(args[limitIdx + 1], 10)
    : Infinity

  // --status <lista>: quais status do manifest entram na fila
  // Ex: --status failed | --status pending,failed | --status restricted
  // Sem a flag, o padrão é pending,failed (os que faltam + os que falharam)
  const statusIdx = args.indexOf('--status')
  flags.statuses = statusIdx !== -1 && args[statusIdx + 1]
    ? args[statusIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : []

  // --project <nome|id> (repetível)
  flags.projects = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      flags.projects.push(args[i + 1])
      i++
    }
  }

  return flags
}

// Configuração principal exportada
const args = parseArgs()

const config = {
  accessToken: require_env('FIGMA_ACCESS_TOKEN'),
  teamIds: require_env('FIGMA_TEAM_IDS').split(',').map(id => id.trim()).filter(Boolean),
  sessionCookie: args.mapOnly ? '' : (() => {
    try { return require_env('FIGMA_SESSION_COOKIE') }
    catch { return '' }
  })(),
  downloadTimeout: parseInt(optional_env('FIGMA_DOWNLOAD_TIMEOUT', '120000'), 10),
  outDir: args.outDir,
  manifestPath: path.join(args.outDir, 'manifest.json'),
  ...args,
}

// Em --map-only o cookie não é necessário
if (!config.mapOnly && !config.sessionCookie) {
  throw new Error('FIGMA_SESSION_COOKIE é obrigatório para o download dos arquivos. Use --map-only para apenas mapear.')
}

export default config
