# figma-backup

Script Node.js híbrido para backup completo dos arquivos `.fig`.

- **Etapa 1 (REST API):** mapeia todos os projetos e arquivos dos times via API do Figma.
- **Etapa 2 (Playwright):** abre cada arquivo no editor web e aciona "Save local copy" via command palette.

O resultado é um diretório `backups/` na raiz do repo com subpastas por projeto, e um `manifest.json` que permite retomar downloads interrompidos.

---

## Pré-requisitos

### 1. Node.js 20+

Este script usa `playwright@latest`, que exige **Node 20+**.

### 2. Instalar dependências e o browser Chromium

```bash
npm install
npx playwright install chromium
```

### 3. Configurar variáveis de ambiente

Copie o arquivo de exemplo e preencha:

```bash
cp .env.example .env
```

Edite o `.env` com os valores reais (veja as seções abaixo para obter cada um).

---

## Obtendo as variáveis de ambiente

### `FIGMA_ACCESS_TOKEN`

1. Acesse **figma.com → Seu perfil → Settings → Security → Personal access tokens**.
2. Clique em **Generate new token**.
3. Dê um nome (ex: `backup`) e marque os escopos:
   - **Folders (read)** — para listar pastas e arquivos dos times *(escopo atual; `projects:read` foi descontinuado)*
   - **File content (read)** — para acessar o conteúdo dos arquivos
4. Copie o token gerado (começa com `figd_`).

> **Atenção:** Se o seu token foi criado antes de 2025 com o escopo `projects:read`, ele ainda funciona com o endpoint legado. Tokens **novos** precisam do escopo `folders:read` — o script já usa os endpoints v2 corretos automaticamente.

### `FIGMA_TEAM_IDS`

1. Acesse o Figma e abra qualquer projeto de time.
2. Observe a URL: `figma.com/files/team/`**`123456789`**`/nome-do-time`.
3. O número em negrito é o Team ID.
4. Para múltiplos times, separe por vírgula: `123456789,987654321`.

### `FIGMA_SESSION_COOKIE`

Este cookie é necessário para que o Playwright acesse o editor como usuário autenticado.

> **Importante:** use a conta do usuário que tem permissão de cópia em todos os arquivos. Se um arquivo tiver restrição de cópia, ele será pulado automaticamente.

1. Abra o Figma no Chrome/Edge.
2. Abra as **Ferramentas do desenvolvedor** (F12) → aba **Application** → **Storage → Cookies → https://www.figma.com**.
3. Localize o cookie chamado **`__Host-figma.authn`**.
4. Copie o **valor** (campo Value) e cole em `FIGMA_SESSION_COOKIE`.

### Desabilitar abertura no app desktop (OBRIGATÓRIO)

Se o Figma baixado e configurado para abrir links no app desktop, o browser será redirecionado e os downloads falharão.

1. Acesse **figma.com → Seu perfil → Settings → Open links in desktop app**.
2. **Desmarque** essa opção.

---

## Uso

### Execução completa (Etapa 1 + Etapa 2)

```bash
node index.js
```

### Apenas mapeamento (sem abrir browser)

Útil para validar o token e ver quantos arquivos serão baixados antes de iniciar:

```bash
node index.js --map-only
```

### Retomar downloads interrompidos

O manifest registra o status de cada arquivo. Por padrão, entradas com status `pending` (os que faltam) ou `failed` (os que falharam) voltam para a fila automaticamente:

```bash
npm run download        # = node index.js --from-manifest
```

No início da execução o script imprime a contagem por status no manifest e a composição da fila, para você saber exatamente o que vai ser processado.

Para escolher o que reenfileirar, use `--status`:

```bash
npm run retry                                  # só os que falharam
npm run resume                                 # só os que nunca foram tentados
node index.js --from-manifest --status restricted        # revalida os restritos
node index.js --from-manifest --status failed --limit 5  # testa 5 antes de soltar tudo
```

Ao contrário do `--force`, o `--status` não reenfileira os arquivos já baixados.

### Outras flags

| Flag | Descrição |
|------|-----------|
| `--map-only` | Só Etapa 1: mapeia e grava o manifest, sem baixar |
| `--from-manifest` | Pula a Etapa 1 e usa o manifest existente |
| `--force` | Re-baixa tudo, ignorando status do manifest |
| `--status <lista>` | Status que entram na fila, separados por vírgula (padrão: `pending,failed`) |
| `--headed` | Exibe o browser na tela (útil para debug) |
| `--project <nome\|id>` | Filtra por projeto (repetível) |
| `--limit <n>` | Baixa no máximo N arquivos nesta execução |
| `--out <dir>` | Diretório de saída (padrão: `../../backups`) |

Exemplos:

```bash
# Baixar apenas arquivos de um projeto específico
node index.js --project "Design System"

# Baixar com browser visível, limitando a 5 arquivos
node index.js --headed --limit 5

# Forçar re-download de tudo
node index.js --force
```

---

## Estrutura de saída

```
backups/
  manifest.json                        # estado de todos os arquivos
  Design System/
    Atoms.fig
    Molecules.fig
  Produto/
    Tela de Login.fig
    Dashboard.fig
  Marketing/
    Landing Page.jam                   # FigJam exporta como .jam
```

O `manifest.json` guarda por `fileKey`:

```json
{
  "AbCdEfGh": {
    "fileKey": "AbCdEfGh",
    "fileName": "Atoms",
    "projectName": "Design System",
    "lastModified": "2026-09-10T14:30:00Z",
    "status": "downloaded",
    "savedAs": "Design System/Atoms.fig",
    "downloadedAt": "2026-09-14T08:00:00.000Z"
  }
}
```

Statuses possíveis: `pending`, `downloaded`, `skipped`, `failed`, `restricted`.

---
## Limitações conhecidas

- **Drafts não são incluídos**: a API `/v1/teams/:id/projects` retorna apenas projetos de time, não os Drafts pessoais dos membros.
- **Arquivos com restrição de cópia**: se um arquivo tiver a opção "Restrict copying and sharing" ativada, a opção "Save local copy" / "Salvar cópia local" não aparece e o arquivo é marcado como `restricted` no manifest. Esse status também pode ser um falso negativo (menu ainda carregando, UI em outro idioma, captcha já ativo). Para revalidar: `node index.js --from-manifest --status restricted`.
- **Dependência do texto da UI**: o script busca os itens de menu por texto, em inglês e em português (`UI_TEXTS` em `downloader.js`). O idioma vem da configuração da **conta** do Figma, não do browser. Se o Figma alterar os textos da interface ou a conta usar outro idioma, o gatilho quebrará e o arquivo é logado como `failed` — o erro não é silenciado.
- **Canvas WebGL**: ambientes sem aceleração gráfica podem ter dificuldade em renderizar o canvas headless. Use a flag `--headed` nesses casos.
- **Limite diário de export da conta**: o Figma impõe um teto diário de "Save local copy" por conta (não é um limite do script). Na prática, o teto observado ficou em torno de **~47 arquivos no mesmo dia**. Depois disso o Figma primeiro pede captcha ("verificar que você não é um robô") e, se o limite já estourou, o botão de download **some** — inclusive no browser logado, mesmo resolvendo o captcha na mão. Não há como desativar nem um cooldown publicado; a expectativa razoável é o ciclo resetar no dia seguinte. Fatie a fila com `--limit` (por exemplo 25–40 por dia) em vez de tentar baixar tudo de uma vez.
- **Captcha**: se o diálogo de verificação aparecer após o clique em salvar, o script aborta a execução inteira (não tenta os arquivos seguintes, o que só reforçaria o bloqueio). O arquivo atual volta para `pending` no manifest. O print `screenshots/007-after-save-click.png` mostra o estado da tela nesse momento.
- **Rate limiting da API e intervalo entre downloads**: a Etapa 1 adiciona 250 ms entre chamadas à REST API. A Etapa 2 espera um intervalo aleatório de **5–60 s** entre um arquivo e o próximo (`FIGMA_DELAY_MIN` / `FIGMA_DELAY_MAX` no `.env`), para não parecer tráfego automatizado. Esse intervalo **não evita** o teto diário de export: só reduz a chance de o captcha disparar cedo. O timeout de espera pelo início do download é de 3 min (`FIGMA_DOWNLOAD_START_TIMEOUT`); a espera pelo hamburger, até 90 s (`FIGMA_MENU_TIMEOUT`).

---

## Segurança

- O cookie de sessão é equivalente à senha: trate-o com o mesmo cuidado.
- Rotacione o Personal Access Token periodicamente.

---

# figma-backup (English)

Hybrid Node.js script for complete backup of `.fig` files.

- **Step 1 (REST API):** maps all team projects and files through the Figma API.
- **Step 2 (Playwright):** opens each file in the web editor and triggers "Save local copy" through the command palette.

The result is a `backups/` directory at the repository root, with subfolders for each project, and a `manifest.json` file that allows interrupted downloads to be resumed.

---

## Prerequisites

### 1. Node.js 20+

This script uses `playwright@latest`, which requires **Node 20+**.

### 2. Install dependencies and the Chromium browser

```bash
npm install
npx playwright install chromium
```

### 3. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Edit `.env` with the real values (see the sections below to obtain each one).

---

## Obtaining the environment variables

### `FIGMA_ACCESS_TOKEN`

1. Go to **figma.com -> Your profile -> Settings -> Security -> Personal access tokens**.
2. Click **Generate new token**.
3. Give it a name (for example, `backup`) and select the scopes:
   - **Folders (read)** - to list team folders and files *(current scope; `projects:read` has been deprecated)*
   - **File content (read)** - to access file contents
4. Copy the generated token (it starts with `figd_`).

> **Note:** If your token was created before 2025 with the `projects:read` scope, it still works with the legacy endpoint. **New** tokens need the `folders:read` scope - the script already uses the correct v2 endpoints automatically.

### `FIGMA_TEAM_IDS`

1. Open Figma and open any team project.
2. Look at the URL: `figma.com/files/team/`**`123456789`**`/team-name`.
3. The bold number is the Team ID.
4. For multiple teams, separate the IDs with commas: `123456789,987654321`.

### `FIGMA_SESSION_COOKIE`

This cookie is required for Playwright to access the editor as an authenticated user.

> **Important:** use the account that has permission to copy all files. If a file has copy restrictions, it will be skipped automatically.

1. Open Figma in Chrome/Edge.
2. Open **Developer Tools** (F12) -> **Application** tab -> **Storage -> Cookies -> https://www.figma.com**.
3. Find the cookie named **`__Host-figma.authn`**.
4. Copy its **value** (the Value field) and paste it into `FIGMA_SESSION_COOKIE`.

### Disable opening links in the desktop app (REQUIRED)

If Figma is installed and configured to open links in the desktop app, the browser will be redirected and downloads will fail.

1. Go to **figma.com -> Your profile -> Settings -> Open links in desktop app**.
2. **Turn off** this option.

---

## Usage

### Full run (Step 1 + Step 2)

```bash
node index.js
```

### Mapping only (without opening the browser)

Useful for validating the token and seeing how many files will be downloaded before starting:

```bash
node index.js --map-only
```

### Resume interrupted downloads

The manifest records the status of each file. By default, entries with `pending` status (not yet downloaded) or `failed` status (download failed) are automatically added back to the queue:

```bash
npm run download        # = node index.js --from-manifest
```

At the beginning of the run, the script prints the count for each manifest status and the queue composition, so you know exactly what will be processed.

To choose which statuses to enqueue again, use `--status`:

```bash
npm run retry                                  # failed files only
npm run resume                                 # files that have never been attempted
node index.js --from-manifest --status restricted        # revalidate restricted files
node index.js --from-manifest --status failed --limit 5  # test 5 before processing everything
```

Unlike `--force`, `--status` does not re-enqueue files that have already been downloaded.

### Other flags

| Flag | Description |
|------|-------------|
| `--map-only` | Step 1 only: map files and write the manifest without downloading |
| `--from-manifest` | Skip Step 1 and use the existing manifest |
| `--force` | Re-download everything, ignoring manifest status |
| `--status <list>` | Statuses to add to the queue, separated by commas (default: `pending,failed`) |
| `--headed` | Show the browser window (useful for debugging) |
| `--project <name\|id>` | Filter by project (repeatable) |
| `--limit <n>` | Download at most N files in this run |
| `--out <dir>` | Output directory (default: `../../backups`) |

Examples:

```bash
# Download files from only one specific project
node index.js --project "Design System"

# Download with a visible browser, limiting the run to 5 files
node index.js --headed --limit 5

# Force a re-download of everything
node index.js --force
```

---

## Output structure

```
backups/
  manifest.json                        # status of all files
  Design System/
    Atoms.fig
    Molecules.fig
  Produto/
    Tela de Login.fig
    Dashboard.fig
  Marketing/
    Landing Page.jam                   # FigJam exports as .jam
```

The `manifest.json` file stores entries by `fileKey`:

```json
{
  "AbCdEfGh": {
    "fileKey": "AbCdEfGh",
    "fileName": "Atoms",
    "projectName": "Design System",
    "lastModified": "2026-09-10T14:30:00Z",
    "status": "downloaded",
    "savedAs": "Design System/Atoms.fig",
    "downloadedAt": "2026-09-14T08:00:00.000Z"
  }
}
```

Possible statuses: `pending`, `downloaded`, `skipped`, `failed`, `restricted`.

---

## Known limitations

- **Drafts are not included**: the `/v1/teams/:id/projects` API returns only team projects, not members' personal Drafts.
- **Files with copy restrictions**: if a file has **Restrict copying and sharing** enabled, the **Save local copy** option does not appear and the file is marked as `restricted` in the manifest. This status can also be a false negative (the menu is still loading, the UI is in another language, or a captcha is already active). To revalidate: `node index.js --from-manifest --status restricted`.
- **UI text dependency**: the script finds menu items by text in English and Portuguese (`UI_TEXTS` in `downloader.js`). The language comes from the Figma **account** settings, not the browser. If Figma changes its interface text or the account uses another language, the trigger will break and the file will be logged as `failed` - the error is not silenced.
- **WebGL canvas**: environments without hardware acceleration may have trouble rendering the headless canvas. Use the `--headed` flag in those cases.
- **Account export daily limit**: Figma imposes a daily limit on **Save local copy** per account (this is not a script limit). In practice, the observed limit was around **~47 files on the same day**. After that, Figma first asks for a captcha ("verify that you are not a robot") and, if the limit has already been reached, the download button **disappears** - even in the logged-in browser, including after solving the captcha manually. There is no way to disable this or a published cooldown; the reasonable expectation is that the limit resets the following day. Split the queue with `--limit` (for example, 25-40 per day) instead of trying to download everything at once.
- **Captcha**: if the verification dialog appears after clicking save, the script aborts the entire run (it does not try subsequent files, which would only reinforce the block). The current file returns to `pending` in the manifest. The screenshot `screenshots/007-after-save-click.png` shows the screen state at that moment.
- **API rate limiting and delay between downloads**: Step 1 adds 250 ms between REST API calls. Step 2 waits a random interval of **5-60 s** between one file and the next (`FIGMA_DELAY_MIN` / `FIGMA_DELAY_MAX` in `.env`) to avoid looking like automated traffic. This interval **does not prevent** the daily export limit; it only reduces the chance of the captcha being triggered early. The timeout for waiting for the download to start is 3 minutes (`FIGMA_DOWNLOAD_START_TIMEOUT`); the wait for the hamburger menu is up to 90 seconds (`FIGMA_MENU_TIMEOUT`).

---

## Security

- The session cookie is equivalent to a password: handle it with the same care.
- Rotate the Personal Access Token periodically.
