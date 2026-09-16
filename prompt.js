/**
 * prompt.js
 * Seleção interativa de pastas/projetos via readline — sem dependências externas.
 */

import readline from 'readline'

/**
 * Faz o parse de uma string de seleção de números e intervalos.
 * Ex: "1,3-5,7" → Set { 1, 3, 4, 5, 7 }
 * Retorna null se nenhum número válido for encontrado.
 * @param {string} input
 * @param {number} max  — número máximo válido
 * @returns {Set<number>|null}
 */
function parseNumbers(input, max) {
  const indices = new Set()

  for (const part of input.split(',')) {
    const trimPart = part.trim()
    if (!trimPart) continue

    const rangeParts = trimPart.split('-')

    if (rangeParts.length === 2) {
      const from = parseInt(rangeParts[0], 10)
      const to   = parseInt(rangeParts[1], 10)
      if (!isNaN(from) && !isNaN(to) && from >= 1 && to <= max) {
        for (let n = from; n <= to; n++) indices.add(n)
      }
    } else {
      const n = parseInt(trimPart, 10)
      if (!isNaN(n) && n >= 1 && n <= max) indices.add(n)
    }
  }

  return indices.size > 0 ? indices : null
}

/**
 * Exibe uma lista numerada de projetos e retorna os nomes selecionados pelo usuário.
 *
 * Exemplos de entrada válida:
 *   all        → todos os projetos
 *   1,3,5      → projetos 1, 3 e 5
 *   1-4        → projetos 1 a 4
 *   1,3-5,7    → combinação
 *   q / quit   → cancela (retorna null)
 *
 * @param {Record<string, number>} projectCounts  — { nomeProjeto: qtdArquivos }
 * @returns {Promise<string[]|null>}  — array de nomes selecionados, ou null se cancelado
 */
export async function selectProjects(projectCounts) {
  const projects = Object.entries(projectCounts).sort(([a], [b]) => a.localeCompare(b))

  if (projects.length === 0) return []

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log('')
  console.log('  ┌─────────────────────────────────────────────────────┐')
  console.log('  │  Selecione as pastas para baixar                    │')
  console.log('  └─────────────────────────────────────────────────────┘')
  console.log('')

  projects.forEach(([name, count], i) => {
    const num    = String(i + 1).padStart(3)
    const label  = name.length > 45 ? name.slice(0, 42) + '...' : name
    const files  = `(${count} arquivo${count !== 1 ? 's' : ''})`
    console.log(`    ${num}.  ${label.padEnd(46)} ${files}`)
  })

  console.log('')
  console.log('  Opções:')
  console.log('    all           — todas as pastas')
  console.log('    1,3,5         — pastas individuais por número')
  console.log('    1-4           — intervalo')
  console.log('    1,3-5,7       — combinação')
  console.log('    all -3,16,19  — todas EXCETO os números indicados')
  console.log('    -3,16,19      — (atalho) igual ao anterior')
  console.log('    q / quit      — cancelar')
  console.log('')

  return new Promise(resolve => {
    rl.question('  Sua seleção: ', answer => {
      rl.close()
      console.log('')

      const trimmed = answer.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'quit' || trimmed === '') {
        resolve(null)
        return
      }

      // ── Modo "excluir": "all -3,16,19" ou "-3,16,19" ──────────────────────
      const excludeMatch = trimmed.match(/^(?:all\s+)?-(.+)$/)
      if (excludeMatch) {
        const excluded = parseNumbers(excludeMatch[1], projects.length)
        if (excluded === null) {
          console.log('  Seleção inválida nos números a excluir. Tente novamente.')
          resolve(null)
          return
        }
        const selected = projects
          .map(([name], i) => ({ name, n: i + 1 }))
          .filter(({ n }) => !excluded.has(n))
          .map(({ name }) => name)
        resolve(selected)
        return
      }

      // ── Modo "incluir todos" ───────────────────────────────────────────────
      if (trimmed === 'all' || trimmed === '*') {
        resolve(projects.map(([name]) => name))
        return
      }

      // ── Modo "incluir específicos": "1,3-5,7" ─────────────────────────────
      const included = parseNumbers(trimmed, projects.length)
      if (!included || included.size === 0) {
        console.log('  Nenhuma seleção válida. Tente novamente.')
        resolve(null)
        return
      }

      const selected = [...included]
        .sort((a, b) => a - b)
        .map(n => projects[n - 1][0])
      resolve(selected)
    })
  })
}

/**
 * Pergunta simples de confirmação (s/n).
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`  ${question} [s/n]: `, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 's')
    })
  })
}
