# figma-backup

Script Node.js híbrido para backup completo dos arquivos `.fig` da empresa.

- **Etapa 1 (REST API):** mapeia todos os projetos e arquivos dos times via API do Figma.
- **Etapa 2 (Playwright):** abre cada arquivo no editor web e aciona "Save local copy" via command palette.

O resultado é um diretório `backups/` na raiz do repo com subpastas por projeto, e um `manifest.json` que permite retomar downloads interrompidos.

---

## Pré-requisitos

### 1. Node.js 20+

Este script usa `playwright@latest`, que exige **Node 20+**. O backend principal roda em Node 16, então gerencie versões com [nvm](https://github.com/nvm-sh/nvm) (Linux/macOS) ou [nvm-windows](https://github.com/coreybutler/nvm-windows):

```bash
nvm install 20
nvm use 20
node -v   # deve mostrar v20.x.x ou superior
```

### 2. Instalar dependências e o browser Chromium

Dentro do diretório do script:

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
3. Dê um nome (ex: `backup-empresa`) e marque os escopos:
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

Se o Figma estiver configurado para abrir links no app desktop, o browser será redirecionado e os downloads falharão.

1. Acesse **figma.com → Seu perfil → Settings → Open links in desktop app**.
2. **Desmarque** essa opção.

---

## Uso

Todos os comandos devem ser executados de dentro de `scripts/figmaBackup/` com Node 20+.

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
- **Arquivos com restrição de cópia**: se um arquivo tiver a opção "Restrict copying and sharing" ativada, a opção "Save local copy" não aparece na command palette e o arquivo é marcado como `restricted` no manifest.
- **Dependência do texto da UI**: o script busca os itens de menu por texto, em inglês e em português (`UI_TEXTS` em `downloader.js`). O idioma vem da configuração da **conta** do Figma, não do browser. Se o Figma alterar os textos da interface ou a conta usar outro idioma, o gatilho quebrará e o arquivo é logado como `failed` — o erro não é silenciado.
- **Canvas WebGL**: ambientes sem aceleração gráfica podem ter dificuldade em renderizar o canvas headless. Use a flag `--headed` nesses casos.
- **Rate limiting**: a Etapa 1 adiciona delay entre chamadas à API (250ms). A Etapa 2 adiciona delay aleatório de 3–8s entre downloads para evitar bloqueios.

---

## Segurança

- O cookie de sessão é equivalente à senha: trate-o com o mesmo cuidado.
- Rotacione o Personal Access Token periodicamente.
