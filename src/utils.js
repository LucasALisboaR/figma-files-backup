// Caracteres inválidos para nomes de arquivo/diretório no Windows
const WINDOWS_INVALID_CHARS = /[\\/:*?"<>|]/g
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const MAX_NAME_LENGTH = 100

/**
 * Sanitiza um string para uso seguro como nome de arquivo/diretório.
 * Remove caracteres inválidos no Windows e trunca se necessário.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const sanitized = String(name ?? '')
    .replace(WINDOWS_INVALID_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)

  if (!sanitized || sanitized === '.' || sanitized === '..' || WINDOWS_RESERVED_NAMES.test(sanitized)) {
    return 'sem-nome'
  }

  return sanitized
}

/**
 * Aguarda `ms` milissegundos.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Delay aleatório entre `minMs` e `maxMs` milissegundos.
 * @param {number} minMs
 * @param {number} maxMs
 */
export async function randomDelay(minMs = 3000, maxMs = 8000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  log(`  aguardando ${(ms / 1000).toFixed(1)}s antes do próximo...`)
  await sleep(ms)
}

// ──────────────────────────────────────────────
// Helpers de log colorido via ANSI (sem dependência extra)
// ──────────────────────────────────────────────
const COLORS = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
}

function colorize(color, text) {
  // Desabilita cores se não for terminal (ex: pipe para arquivo)
  if (!process.stdout.isTTY) return text
  return `${COLORS[color] ?? ''}${text}${COLORS.reset}`
}

function timestamp() {
  return colorize('gray', `[${new Date().toLocaleTimeString('pt-BR')}]`)
}

export function log(msg) {
  console.log(`${timestamp()} ${msg}`)
}

export function logInfo(msg) {
  console.log(`${timestamp()} ${colorize('cyan', 'INFO')} ${msg}`)
}

export function logSuccess(msg) {
  console.log(`${timestamp()} ${colorize('green', ' OK ')} ${msg}`)
}

export function logWarn(msg) {
  console.warn(`${timestamp()} ${colorize('yellow', 'WARN')} ${msg}`)
}

export function logError(msg) {
  console.error(`${timestamp()} ${colorize('red', 'ERRO')} ${msg}`)
}

export function logSkip(msg) {
  console.log(`${timestamp()} ${colorize('dim', 'SKIP')} ${msg}`)
}

/**
 * Imprime linha de progresso estilo [atual/total] Projeto / Arquivo.
 * @param {number} current
 * @param {number} total
 * @param {string} projectName
 * @param {string} fileName
 * @param {string} [dest]
 */
export function logProgress(current, total, projectName, fileName, dest) {
  const counter = colorize('bold', `[${String(current).padStart(String(total).length)}/${total}]`)
  const proj = colorize('blue', projectName)
  const file = colorize('cyan', fileName)
  const arrow = dest ? ` → ${colorize('dim', dest)}` : ''
  console.log(`${timestamp()} ${counter} ${proj} / ${file}${arrow}`)
}

/**
 * Imprime o resumo final de execução.
 * @param {{ downloaded: number, skipped: number, failed: number, restricted: number }} counts
 */
export function logSummary(counts) {
  const { downloaded, skipped, failed, restricted } = counts
  console.log('')
  console.log(colorize('bold', '══════════════════════════════════════'))
  console.log(colorize('bold', '  Resumo do backup'))
  console.log(colorize('bold', '══════════════════════════════════════'))
  console.log(`  ${colorize('green', '✓')} Baixados:    ${downloaded}`)
  console.log(`  ${colorize('dim',   '–')} Pulados:     ${skipped} (sem alteração)`)
  console.log(`  ${colorize('yellow','!')} Restritos:   ${restricted} (copy restricted)`)
  console.log(`  ${colorize('red',   '✗')} Falhados:    ${failed}`)
  console.log(colorize('bold', '══════════════════════════════════════'))
  console.log('')
}
