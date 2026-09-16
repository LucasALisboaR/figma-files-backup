import { chromium } from 'playwright'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import { sanitizeName, randomDelay, logProgress, logSuccess, logSkip, logError, logWarn, logInfo, sleep } from './utils.js'
import { updateEntry } from './manifest.js'

// Erro específico para arquivos que são Team Libraries (não têm canvas de design)
class LibraryFileError extends Error {
  constructor(msg) { super(msg); this.name = 'LibraryFileError' }
}

// Erro para quando o Figma exige captcha: insistir nos arquivos seguintes só
// reforça a detecção de bot, então a execução inteira é abortada.
class CaptchaError extends Error {
  constructor(msg) { super(msg); this.name = 'CaptchaError' }
}

// Seletores do diálogo de captcha ("A Figma precisa verificar que você não é um
// robô" / "verify that you're not a robot"). Evitamos casar com a palavra
// "captcha" solta, que pode aparecer em nome de camada no painel de layers.
const CAPTCHA_SELECTORS = [
  'text=/não é um robô/i',
  'text=/not a robot/i',
  'text=/responda o CAPTCHA/i',
  'text=/complete the CAPTCHA/i',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  '[class*="captcha"]',
  '[id*="captcha"]',
]

/**
 * Verifica se o diálogo de captcha está visível na tela.
 * @returns {Promise<string|null>} o seletor que casou, ou null
 */
async function detectCaptcha(page) {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const el = await page.$(sel)
      if (el && await el.isVisible()) return sel
    } catch { /* seletor inválido no contexto atual */ }
  }
  return null
}

// Pasta de screenshots — relativa ao diretório do script
const SCREENSHOTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots')

// Contador global de screenshots por arquivo (reset a cada downloadFile)
let screenshotCounter = 1

/**
 * Tira screenshot numerado e salvo em screenshots/.
 * @param {import('playwright').Page} page
 * @param {string} label  - ex: "01-editor-ready", "02-menu-open"
 */
async function shot(page, label) {
  try {
    const num  = String(screenshotCounter++).padStart(3, '0')
    const file = path.join(SCREENSHOTS_DIR, `${num}-${label}.png`)
    await page.screenshot({ path: file, fullPage: false })
    logInfo(`  📸 ${num}-${label}.png`)
  } catch { /* não interrompe o fluxo por falha de screenshot */ }
}

/**
 * Limpa a pasta screenshots/ no início de cada download de arquivo.
 */
function clearScreenshots() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
  for (const f of fs.readdirSync(SCREENSHOTS_DIR)) {
    fs.rmSync(path.join(SCREENSHOTS_DIR, f), { force: true })
  }
  screenshotCounter = 1
}

// Padrões de URL que indicam que o arquivo aberto é uma Team Library
// e não um arquivo de design normal (sem canvas de edição regular)
const LIBRARY_URL_PATTERNS = [
  /\/community\//,
  /\/files\/.*\/library/,
]

// Textos de interface por idioma. O Figma usa o idioma configurado na CONTA,
// não o locale do browser, então cada termo precisa ser buscado em inglês e em
// português. Comparações de texto são feitas em minúsculas (exceto MAIN_MENU_FILE).
const UI_TEXTS = {
  // aria-label do botão hamburger
  mainMenu: ['Main menu', 'Menu principal'],
  // item do menu principal que abre o submenu — comparado por igualdade EXATA
  // (por isso o casing importa: evita casar com "Back to files")
  file: ['File', 'Arquivo'],
  // item alvo no submenu e texto digitado no command palette
  saveLocalCopy: ['save local copy', 'salvar cópia local'],
  // item exclusivo do menu principal, usado para confirmar que o dropdown abriu
  actions: ['Actions', 'Ações'],
  // placeholder do campo de busca dentro do dropdown
  search: ['Search', 'Buscar', 'Pesquisar'],
  // placeholder do input do command palette (Ctrl+K)
  searchActions: ['Search actions', 'Actions', 'Pesquisar ações', 'Ações'],
}

/** Monta um seletor Playwright combinando as variantes de idioma de um texto. */
function textSelectors(bases, variants) {
  return bases.flatMap(base => variants.map(t => `${base} >> text=/${t}/i`)).join(', ')
}

/** Monta um seletor de placeholder combinando as variantes de idioma. */
function placeholderSelectors(variants) {
  return variants.map(t => `[placeholder*="${t}"]`).join(', ')
}

// Quando o Figma abre uma library, ele mostra um painel de componentes/estilos
// em vez do editor de canvas. Esses seletores identificam esse estado.
const LIBRARY_UI_SELECTORS = [
  '[class*="libraryModal"]',
  '[class*="library_panel"]',
  'h2 >> text=/published components/i',
  'h2 >> text=/team library/i',
  'h2 >> text=/componentes publicados/i',
  'h2 >> text=/biblioteca da equipe/i',
  '[data-testid="library-manager"]',
]

// Seletores que indicam que o editor Figma está pronto
// (mais robustos do que esperar <canvas> que às vezes aparece mas ainda carrega)
const EDITOR_READY_SELECTORS = [
  '[data-testid="toolbar"]',           // toolbar principal do editor
  '[class*="toolbar_view"]',           // variante de classe
  '[class*="objectPanelContainer"]',   // painel lateral
  'canvas',                            // fallback: canvas puro
]

const LOGIN_SELECTORS = [
  'input[name="email"]',
  '[data-testid="login-form"]',
  'form[action*="login"]',
  'button >> text=/Log in/i',
  // Ancorado para não casar com botões do editor que contenham "entrar"
  'button >> text=/^(Entrar|Fazer login)$/i',
]

/**
 * Injeta o cookie de sessão no contexto do browser.
 * O prefixo __Host- exige `url` host-only (não `domain`).
 */
async function injectSessionCookie(context, sessionCookie) {
  await context.addCookies([
    {
      name: '__Host-figma.authn',
      value: sessionCookie,
      url: 'https://www.figma.com/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

/**
 * Verifica se a página atual é uma Figma Team Library
 * (editor diferente, sem canvas de design regular).
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isLibraryFile(page) {
  const url = page.url()

  // Checa padrões na URL
  if (LIBRARY_URL_PATTERNS.some(p => p.test(url))) return true

  // Checa seletores específicos da UI de library
  for (const sel of LIBRARY_UI_SELECTORS) {
    try {
      const el = await page.$(sel)
      if (el) return true
    } catch { /* ignora */ }
  }
  return false
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isLoginPage(page) {
  const url = page.url()
  if (url.includes('/login') || url.includes('/auth/enter')) return true

  for (const sel of LOGIN_SELECTORS) {
    try {
      const el = await page.$(sel)
      if (el) return true
    } catch { /* ignore */ }
  }
  return false
}

/**
 * Valida a sessão abrindo a home do Figma.
 * Lança erro descritivo se o cookie não funcionar.
 */
async function validateSession(context, timeoutMs) {
  const page = await context.newPage()
  try {
    await page.goto('https://www.figma.com/files/recents-and-sharing/recent', {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 30000),
    })
    await sleep(1500)

    if (await isLoginPage(page)) {
      throw new Error(
        'FIGMA_SESSION_COOKIE inválido ou expirado — o Figma redirecionou para a tela de login.\n' +
        '  Solução: extraia um novo valor do cookie __Host-figma.authn do seu browser logado\n' +
        '  (DevTools → Application → Cookies → https://www.figma.com → __Host-figma.authn).'
      )
    }
    logInfo('[downloader] Sessão validada com sucesso.')
  } finally {
    await page.close()
  }
}

/**
 * Aguarda o editor Figma ficar pronto tentando múltiplos seletores em paralelo.
 * Também detecta tela de login e reporta erro claro.
 */
async function waitForEditor(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const pollInterval = 1000

  while (Date.now() < deadline) {
    // Verifica login
    if (await isLoginPage(page)) {
      throw new Error(
        'Cookie de sessão inválido: o Figma redirecionou para a tela de login.\n' +
        '  Atualize FIGMA_SESSION_COOKIE no .env com o valor atual do cookie __Host-figma.authn.'
      )
    }

    // Verifica se é uma Team Library (editor diferente — sem canvas de design)
    if (await isLibraryFile(page)) {
      const url = page.url()
      throw new LibraryFileError(
        `Arquivo é uma Figma Team Library (sem canvas de design regular).\n` +
        `  URL: ${url}\n` +
        `  Team Libraries têm uma interface diferente no editor e não permitem "Save local copy" da mesma forma.\n` +
        `  O arquivo será marcado como "library" no manifest e pulado.`
      )
    }

    // Verifica se o editor está pronto
    for (const selector of EDITOR_READY_SELECTORS) {
      try {
        const el = await page.$(selector)
        if (el && await el.isVisible()) {
          logInfo(`  Editor pronto (seletor: ${selector}).`)
          await sleep(2500)
          return
        }
      } catch { /* seletor não existe ainda, continua tentando */ }
    }

    // Loga progresso a cada 10s para não parecer travado
    const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000)
    if (elapsed % 10 === 0 && elapsed > 0) {
      logInfo(`  Aguardando editor... (${elapsed}s / ${Math.round(timeoutMs / 1000)}s) — URL atual: ${page.url()}`)
    }

    await sleep(pollInterval)
  }

  // Timeout expirou — coleta diagnóstico
  const finalUrl = page.url()
  const title = await page.title().catch(() => '(sem título)')
  throw new Error(
    `Editor não carregou em ${Math.round(timeoutMs / 1000)}s.\n` +
    `  URL final: ${finalUrl}\n` +
    `  Título da página: ${title}\n` +
    `  Possíveis causas:\n` +
    `  • WebGL indisponível no modo headless → tente rodar com --headed\n` +
    `  • Arquivo muito grande (timeout baixo) → defina FIGMA_DOWNLOAD_TIMEOUT=300000 no .env\n` +
    `  • Opção "Open in desktop app" ativada no Figma → desative em Settings`
  )
}

/**
 * Abre o menu File do Figma e clica em "Save local copy...".
 *
 * Estratégia primária: menu principal (hamburger) → File → Save local copy
 * Estratégia secundária: command palette Ctrl+K → digitar "save local copy"
 *
 * Retorna true se a opção foi encontrada e clicada, false se não existir
 * (arquivo com restrição de cópia ou tipo não suportado).
 */
async function triggerSaveLocalCopy(page) {
  const isMac = os.platform() === 'darwin'
  const modifier = isMac ? 'Meta' : 'Control'

  // Fecha qualquer menu/modal aberto antes de começar
  await page.keyboard.press('Escape')
  await sleep(300)

  // ── Estratégia 1: menu principal (hamburger) → File → Save local copy ───────
  logInfo('  Abrindo menu principal do Figma...')

  // Seletores do botão hamburger/logo. O Figma usa obfuscated class names,
  // então tentamos aria-label primeiro e depois fallbacks estruturais.
  const hamburgerSelectors = [
    ...UI_TEXTS.mainMenu.map(t => `[aria-label="${t}"]`),
    '[data-testid="main-menu-button"]',
    '[class*="hamburger"]',
    '[class*="mainMenu"]',
    // Fallback estrutural: botão/div mais à esquerda da barra de título
    'div[class*="navbar"] > :first-child',
    'div[class*="titlebar"] > :first-child',
  ]

  // Em arquivos grandes a barra de título só é montada depois do canvas aparecer,
  // então os seletores são reavaliados em ciclos até o deadline em vez de uma
  // única passada curta.
  const hamburgerTimeout = parseInt(process.env.FIGMA_MENU_TIMEOUT || '90000', 10)
  const hamburgerDeadline = Date.now() + hamburgerTimeout

  let menuOpened = false
  let lastLoggedWait = 0
  while (!menuOpened && Date.now() < hamburgerDeadline) {
    for (const sel of hamburgerSelectors) {
      const remaining = hamburgerDeadline - Date.now()
      if (remaining <= 0) break
      try {
        const btn = await page.waitForSelector(sel, {
          timeout: Math.min(2000, remaining),
          state: 'visible',
        })
        if (btn) {
          await btn.click()
          await sleep(500)
          menuOpened = true
          logInfo(`  Hamburger aberto via: ${sel}`)
          await shot(page, 'hamburger-open')
          break
        }
      } catch { /* tenta próximo */ }
    }

    if (menuOpened) break

    const waited = Math.round((Date.now() - (hamburgerDeadline - hamburgerTimeout)) / 1000)
    if (waited - lastLoggedWait >= 10) {
      lastLoggedWait = waited
      logInfo(`  Aguardando barra de título carregar... (${waited}s / ${Math.round(hamburgerTimeout / 1000)}s)`)
    }
    await sleep(1000)
  }

  if (menuOpened) {
    try {
      // Aguarda o dropdown do hamburger estar visível esperando por "Actions..."
      // ("Ações..." em pt-BR), que é um item ÚNICO do menu principal
      // (não existe em mais nenhum lugar do DOM).
      const actionsItemSel = UI_TEXTS.actions
        .flatMap(t => [`li:has-text("${t}")`, `[role="menuitem"]:has-text("${t}")`])
        .join(', ')

      await page.waitForSelector(
        `${actionsItemSel}, ${placeholderSelectors(UI_TEXTS.search)}`,
        { timeout: 3000 }
      ).catch(() => {}) // se não achar, tenta mesmo assim

      await sleep(300)

      // Encontra o container do menu hamburger procurando pelo item "Actions..."
      // e subindo na árvore DOM até o elemento pai que contém todos os itens.
      let menuContainer = null
      try {
        const actionsEl = await page.$(actionsItemSel)
        if (actionsEl) {
          menuContainer = await actionsEl.evaluateHandle(el => {
            // Sobe na árvore até encontrar um elemento que pareça ser o container do menu
            let node = el.parentElement
            while (node && node !== document.body) {
              if (node.tagName === 'UL' || node.getAttribute('role') === 'menu' ||
                  node.getAttribute('role') === 'dialog') return node
              node = node.parentElement
            }
            return el.parentElement // fallback: pai imediato
          })
        }
      } catch { /* continua sem container */ }

      // Busca "File" / "Arquivo" — SOMENTE dentro do container do menu, não no
      // DOM todo. Verifica textContent exato para não casar com "Back to files"
      // ou ícones da sidebar.
      let fileItem = null
      const scope = menuContainer ?? page

      const candidateEl = await scope.$$('li, [role="menuitem"], a')
      for (const el of candidateEl) {
        try {
          const txt = (await el.textContent() ?? '').trim()
          if (UI_TEXTS.file.includes(txt)) {
            fileItem = el
            logInfo(`  "${txt}" encontrado por textContent exato no container do menu.`)
            break
          }
        } catch { /* elemento pode ter sumido */ }
      }

      // Fallback: se não achou pelo container, pega via keyboard navigation
      if (!fileItem) {
        logWarn('  Container do menu não encontrado. Tentando navegação por teclado...')
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('ArrowDown')
          await sleep(100)
        }
        await page.keyboard.press('Enter')
        await sleep(500)
        await shot(page, 'file-submenu-keyboard')

        const saveEl = await page.$(
          UI_TEXTS.saveLocalCopy
            .flatMap(t => [`li:has-text("${t}")`, `[role="menuitem"]:has-text("${t}")`])
            .join(', ')
        )
        if (saveEl) {
          await saveEl.click({ force: true })
          return true
        }
        await page.keyboard.press('Escape')
        return false
      }

      await fileItem.click({ force: true })
      await sleep(700)
      await shot(page, 'file-submenu-open')

      // Busca "Save local copy" no submenu pelo texto DIRETO do elemento
      // (sem incluir textContent de filhos, para não casar com containers pai
      //  cujo textContent agrega "Save local copy...Save to version history...").
      const subCandidates = await page.$$('li, [role="menuitem"], span, a, div[tabindex]')
      let saveItem = null

      for (const el of subCandidates) {
        try {
          const ownText = await el.evaluate(node => {
            // Concatena apenas os nós de texto diretos (nodeType === 3)
            let txt = ''
            for (const child of node.childNodes) {
              if (child.nodeType === 3) txt += child.textContent
            }
            return txt.trim().toLowerCase()
          })

          if (UI_TEXTS.saveLocalCopy.some(t => ownText.includes(t))) {
            saveItem = el
            logInfo(`  "Save local copy" encontrado (texto direto: "${ownText}").`)
            break
          }
        } catch { /* elemento pode ter sumido */ }
      }

      // Fallback: se não achou por nó de texto, pega o de menor textContent total
      // (o mais específico/folha que contém o texto)
      if (!saveItem) {
        const withText = []
        for (const el of subCandidates) {
          try {
            const full = (await el.textContent() ?? '').trim().toLowerCase()
            if (UI_TEXTS.saveLocalCopy.some(t => full.includes(t))) withText.push({ el, len: full.length })
          } catch { /* ignore */ }
        }
        if (withText.length > 0) {
          withText.sort((a, b) => a.len - b.len)
          saveItem = withText[0].el
          logInfo(`  "Save local copy" encontrado por menor textContent (fallback).`)
        }
      }

      if (saveItem) {
        await shot(page, 'save-local-copy-found')
        await saveItem.click({ force: true })
        return true
      }

      // Não encontrou "Save local copy" no submenu — arquivo restrito
      await page.keyboard.press('Escape')
      await shot(page, 'save-local-copy-not-found')
      logWarn('  "Save local copy" ausente no submenu File — arquivo com restrição de cópia.')
      return false

    } catch (err) {
      await page.keyboard.press('Escape')
      logWarn(`  Falha ao navegar pelo menu File: ${err.message}`)
      // Cai para a estratégia 2
    }
  } else {
    logWarn(`  Hamburger não encontrado em ${Math.round(hamburgerTimeout / 1000)}s — pulando para estratégia 2.`)
  }

  // ── Estratégia 2: command palette Ctrl+K ─────────────────────────────────
  logWarn('  Menu hamburger não encontrado — tentando command palette (Ctrl+K)...')

  await page.mouse.click(720, 350)
  await sleep(300)
  await page.keyboard.press(`${modifier}+k`)
  await sleep(700)
  await shot(page, 'palette-ctrl-k')

  const paletteInputSel = [
    placeholderSelectors(UI_TEXTS.searchActions),
    '[class*="quickActions"] input',
    '[class*="commandPalette"] input',
  ].join(', ')

  let paletteOpen = false
  try {
    await page.waitForSelector(paletteInputSel, { timeout: 2500 })
    paletteOpen = true
  } catch { /* não abriu */ }

  if (!paletteOpen) {
    // Tenta Ctrl+/ como último recurso
    await page.keyboard.press('Escape')
    await sleep(200)
    await page.keyboard.press(`${modifier}+/`)
    await sleep(700)
    try {
      await page.waitForSelector(paletteInputSel, { timeout: 2000 })
      paletteOpen = true
    } catch { /* desiste */ }
  }

  if (!paletteOpen) {
    logError('  Nenhuma estratégia de acionamento funcionou.')
    return false
  }

  // A palette filtra pelo texto digitado, então o termo precisa estar no idioma
  // da conta: tentamos cada variante, limpando o input entre as tentativas.
  const resultSelectors = [
    '[role="option"]',
    '[role="menuitem"]',
    '[class*="result"]',
    '[class*="quickAction"]',
    'li',
  ].map(base => textSelectors([base], UI_TEXTS.saveLocalCopy))

  for (const term of UI_TEXTS.saveLocalCopy) {
    logInfo(`  Buscando "${term}" na command palette...`)
    await page.keyboard.press(`${modifier}+a`)
    await page.keyboard.type(term, { delay: 80 })
    await sleep(1000)

    for (const sel of resultSelectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 2500 })
        if (el) {
          logInfo(`  "${term}" encontrado via command palette.`)
          await el.click()
          return true
        }
      } catch { /* tenta próximo */ }
    }
  }

  await page.keyboard.press('Escape')
  return false
}

/**
 * Faz o download de um único arquivo Figma via "Save local copy".
 * O download pode ser acionado na página atual OU em uma nova aba aberta pelo Figma —
 * por isso escutamos o evento no contexto inteiro (via newPage) além da página atual.
 */
async function downloadFile(context, entry, outDir, timeoutMs) {
  const page = await context.newPage()
  clearScreenshots() // limpa pasta e reseta contador para este arquivo

  try {
    logInfo(`  Navegando para ${entry.url}`)
    await page.goto(entry.url, {
      waitUntil: 'load',
      timeout: Math.min(timeoutMs, 60000),
    }).catch(() => {})

    logInfo(`  URL pós-redirect: ${page.url()}`)
    await shot(page, 'page-loaded')

    await waitForEditor(page, timeoutMs)
    await shot(page, 'editor-ready')

    // ── Download: escutamos no CONTEXTO inteiro, não só na página ──────────
    // O Figma às vezes abre uma nova aba para iniciar o download,
    // e se ouvirmos só na `page` atual a promise rejeita quando a aba fecha.
    // Registrar no contexto captura downloads de qualquer aba criada a partir dele.
    //
    // Além disso, criamos o handler ANTES do Enter e aplicamos .catch(() => {})
    // IMEDIATAMENTE para que, caso a promise rejeite antes do nosso await,
    // o Node.js não trate isso como "unhandled rejection" e derrube o processo.
    let resolveDownload, rejectDownload
    const downloadPromise = new Promise((res, rej) => {
      resolveDownload = res
      rejectDownload  = rej
    })

    // O timer só é armado depois do Enter (ver abaixo): abrir o menu em arquivos
    // grandes pode levar minutos e não deve consumir o orçamento do download.
    let timer = null
    let downloadStarted = false

    // Listener no contexto: captura qualquer download de qualquer página
    const onDownload = dl => {
      downloadStarted = true
      if (timer) clearTimeout(timer)
      resolveDownload(dl)
    }
    context.on('page', newPage => newPage.on('download', onDownload))
    page.on('download', onDownload)

    // Aciona "Save local copy" — a função já clica no item ao encontrá-lo
    const optionFound = await triggerSaveLocalCopy(page)

    if (!optionFound) {
      context.removeAllListeners('page')
      page.removeListener('download', onDownload)
      await shot(page, 'restricted-no-save-option')
      return { status: 'restricted' }
    }

    await shot(page, 'download-triggered')
    await page.keyboard.press('Enter')

    // Print 2s após o clique em salvar: é nessa janela que aparecem captcha,
    // modal de erro ou diálogo de confirmação que travam o download.
    await sleep(2000)
    await shot(page, 'after-save-click')

    // Captcha na tela: não há como seguir em modo automatizado e tentar os
    // próximos arquivos só piora o bloqueio — aborta a execução inteira.
    const captchaSel = await detectCaptcha(page)
    if (captchaSel) {
      context.removeAllListeners('page')
      page.removeListener('download', onDownload)
      throw new CaptchaError(
        `O Figma exigiu captcha após o clique em "Save local copy" (detectado por: ${captchaSel}).`
      )
    }

    // Em arquivos grandes o Figma serializa o .fig no servidor antes de emitir o
    // download, o que pode passar de vários minutos. Esse orçamento é contado a
    // partir daqui e é independente do FIGMA_DOWNLOAD_TIMEOUT (navegação/editor).
    const startTimeout = parseInt(process.env.FIGMA_DOWNLOAD_START_TIMEOUT || '180000', 10)
    if (!downloadStarted) {
      logInfo(`  Aguardando o Figma gerar o arquivo (até ${Math.round(startTimeout / 1000)}s)...`)
      timer = setTimeout(() => {
        rejectDownload(new Error(
          `Download não iniciou em ${Math.round(startTimeout / 1000)}s. ` +
          `Se o arquivo for muito grande, aumente FIGMA_DOWNLOAD_START_TIMEOUT no .env.`
        ))
      }, startTimeout)
    }

    // Aguarda o download (já está sendo capturado pelo listener acima)
    let download
    try {
      download = await downloadPromise
    } catch (err) {
      throw new Error(`Download falhou: ${err.message}`)
    } finally {
      if (timer) clearTimeout(timer)
      // Limpa listeners independente do resultado
      try { page.removeListener('download', onDownload) } catch { /* ignore */ }
    }

    // Extensão real (.fig, .jam, .deck)
    const suggested = download.suggestedFilename()
    const ext = path.extname(suggested) || '.fig'

    // Salva em backups/<Projeto>/<Arquivo>.<ext>
    const projDir = path.join(outDir, sanitizeName(entry.projectName))
    fs.mkdirSync(projDir, { recursive: true })
    const destFileName = `${sanitizeName(entry.fileName)}${ext}`
    const destPath = path.join(projDir, destFileName)

    logInfo(`  Download iniciado (${suggested}) — transferindo...`)
    await download.saveAs(destPath)
    await shot(page, 'download-complete')

    const savedAs = path.relative(outDir, destPath)
    return { status: 'downloaded', savedAs }
  } finally {
    try { await page.close() } catch { /* página já fechada */ }
  }
}

/**
 * Espera entre um download e o próximo. A faixa é ampla e aleatória de propósito:
 * intervalos curtos e regulares parecem tráfego automatizado e aumentam a chance
 * de o Figma disparar captcha.
 */
function delayBetweenDownloads() {
  const min = parseInt(process.env.FIGMA_DELAY_MIN || '5000', 10)
  const max = parseInt(process.env.FIGMA_DELAY_MAX || '60000', 10)
  return randomDelay(min, Math.max(min, max))
}

/**
 * Executa o download em lote de todos os arquivos pendentes.
 */
export async function runDownloads(entries, manifestPath, manifest, outDir, opts = {}) {
  const {
    sessionCookie,
    headed = false,
    downloadTimeout = 120000,
    limit = Infinity,
  } = opts

  const counts = { downloaded: 0, skipped: 0, failed: 0, restricted: 0 }

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  })

  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    // User-agent de browser real para evitar detecção de bot
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  })

  await injectSessionCookie(context, sessionCookie)

  // Valida a sessão antes de começar o loop de downloads
  try {
    await validateSession(context, downloadTimeout)
  } catch (err) {
    await context.close()
    await browser.close()
    throw err
  }

  const total = Math.min(entries.length, limit)
  logInfo(`Iniciando downloads: ${total} arquivo(s) a processar.`)

  try {
    for (let i = 0; i < total; i++) {
      const entry = entries[i]
      logProgress(i + 1, total, entry.projectName, entry.fileName)

      updateEntry(manifestPath, manifest, entry.fileKey, { status: 'pending' })

      let result
      try {
        result = await downloadFile(context, entry, outDir, downloadTimeout)
      } catch (err) {
        if (err.name === 'CaptchaError') {
          logError(`  ${err.message}`)
          logWarn(`  "${entry.fileName}" volta para a fila como "pending" — nada foi perdido.`)
          logWarn(`  Abortando a execução: insistir agora só reforça o bloqueio.`)
          updateEntry(manifestPath, manifest, entry.fileKey, {
            status: 'pending',
            error: err.message,
          })
          counts.abortedByCaptcha = true
          break
        }

        if (err.name === 'LibraryFileError') {
          logSkip(`  "${entry.fileName}" — Team Library (sem canvas de design). Marcado como "library".`)
          logWarn(`  ${err.message.split('\n')[0]}`)
          updateEntry(manifestPath, manifest, entry.fileKey, {
            status: 'restricted',
            error: err.message,
          })
          counts.restricted++
          if (i < total - 1) await delayBetweenDownloads()
          continue
        }

        logError(`  Falha em "${entry.fileName}": ${err.message}`)
        updateEntry(manifestPath, manifest, entry.fileKey, {
          status: 'failed',
          error: err.message,
        })
        counts.failed++

        if (i < total - 1) await delayBetweenDownloads()
        continue
      }

      if (result.status === 'restricted') {
        logSkip(`  "${entry.fileName}" — sem permissão de cópia (copy restricted).`)
        updateEntry(manifestPath, manifest, entry.fileKey, { status: 'restricted' })
        counts.restricted++
      } else if (result.status === 'downloaded') {
        logSuccess(`  Salvo em: ${result.savedAs}`)
        updateEntry(manifestPath, manifest, entry.fileKey, {
          status: 'downloaded',
          savedAs: result.savedAs,
          downloadedAt: new Date().toISOString(),
          error: undefined,
        })
        counts.downloaded++
      }

      if (i < total - 1) await delayBetweenDownloads()
    }
  } finally {
    await context.close()
    await browser.close()
  }

  return counts
}
