# MagisForm — Agent Instructions

Use este arquivo como mapa curto de navegação. Consulte os documentos vinculados somente quando a tarefa tocar aquela área; não faça uma varredura completa do repositório para uma mudança localizada quando o mapa for suficiente. Expanda a investigação se imports, rotas, schema ou evidências de runtime revelarem dependências não documentadas.

## Projeto e navegação

MagisForm é uma aplicação web para fluxo de manipulação farmacêutica: React 19, Vite, TypeScript, Tailwind CSS v4, Fastify e MariaDB. O navegador nunca acessa MariaDB diretamente.

```text
server/app.ts         → API HTTP, autenticação, validação e CSRF
core/db.ts            → queries MariaDB, sessões, autorização e auditoria
src/App.tsx           → autenticação, navegação e composição
src/components/       → telas e módulos de negócio
src/services/lanDatabase.ts → facade tipada HTTP
src/hooks/useData.ts   → carregamento, polling e atualização
management/           → painel web de gerenciamento
manager/              → API do painel e executor de provisionamento Docker
deploy/tenant-template/ → instalação Docker isolada por cliente
database.sql          → schema consolidado de instalação limpa
database/upgrades/    → upgrades versionados aplicados somente por comando explícito
```

Detalhes: [architecture.md](docs/architecture.md), [modules.md](docs/modules.md), [database.md](docs/database.md), [authentication.md](docs/authentication.md) e [decisions](docs/decisions/).

Interface e comentários novos devem permanecer em português brasileiro. Todos os dados fluem pelo MariaDB; não há cache local nem sincronização offline documentada.

---

## Architecture & Data Flow (Critical)

**O navegador nunca acessa o banco.** Dados seguem `lanDatabase.ts` → `httpAdapter.ts` → `server/app.ts` → `core/db.ts`. Sessão em cookie HttpOnly; mutações exigem Origin e CSRF.

**Mutações** notificam os assinantes do adapter HTTP; `useData` também faz polling a cada 10 segundos.

**Path alias**: `@/*` resolves to repo **root**, not `src/`.

---

## Database Schema

- `database.sql` = schema consolidado atual para bootstrap limpo. **Sempre atualize-o.**
- Upgrades novos e versionados ficam exclusivamente em `database/upgrades/`; `migrations/` é histórico e nunca deve ser executado pelo bootstrap, upgrade ou runtime.
- Bootstrap e upgrade são comandos explícitos. É proibido executar DDL automaticamente ao abrir a janela, conectar o pool ou atender requests.
- Comandos operacionais: `npm run db:bootstrap`, `npm run db:preflight` e `npm run db:upgrade`; consulte `docs/database.md` e ADR-002.
- Upgrade exige preflight estrutural, versão/checksum e lock exclusivo; schema desconhecido deve falhar sem alteração. Mudanças DDL devem permitir retomada ou exigir restore ensaiado.
- Não incluir senha administrativa padrão em `database.sql`; criação do primeiro administrador pertence ao provisionamento explícito.
- Coluna `users.password` comporta hash codificado. A transição de SHA-256 legado e o rehash ficam sujeitos à compatibilidade de release registrada na etapa correspondente.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Frontend web em `127.0.0.1:3002`, proxy da API em 3001 |
| `npm run build` | Build web, painel e backend; não publica |
| `npm run lint` | `tsc --noEmit` (only verification; no test framework) |
| `npm run clean` | Remove somente `dist-web/`, `dist-server/` e `dist-manager/` |

---

## Key Implementation Details

- **Sessão**: uma sessão ativa por usuário, exclusivamente `hosted`. Prazos são definidos em `server/config.ts`; heartbeat passivo não renova inatividade. O frontend encerra por inatividade em 5 minutos.
- **Login forçado**: conflito exige confirmação; `force: true` revoga a sessão anterior.
- **Provisionamento**: administrador inicial somente pelo comando explícito. Configuração de banco fica no servidor, fora do navegador.
- **Saída**: logout exige confirmação; rascunhos usam `beforeunload` ao fechar a aba.

---

## Conventions

- UI strings and new comments: **Brazilian Portuguese**.
- Never commit: `dist-web/`, `dist-server/`, `dist-manager/`, `att.txt`, `db.txt`.

---

## Identidade visual

A identidade segue `website/brand/GUIDE.md`. A fonte de cores do aplicativo é `config/branding.ts`; `applyBrandTheme()` disponibiliza os mesmos tokens ao CSS. Os estilos de apresentação compartilhados estão em `src/index.css`.

- Verde: `#173E35`; fundo: `#F4F1E9`; superfície creme: `#FFFDF8`.
- Coral: `#D95C4F`, com texto `#101814`; apoio sálvia: `#DCE8E1`.
- Texto: `#17201D`; secundário: `#5F6965`; bordas: `#DCDDD4`.
- Títulos principais: Vollkorn; controles, tabelas e corpo: Atkinson Hyperlegible Next. Fontes e licenças locais em `public/fonts/`.
- Logos vetoriais aprovados em `public/brand/`; branco sobre verde e verde sobre superfícies claras, sem distorções, sombras ou gradientes.
- Use tokens semânticos de sucesso, atenção e erro; coral não representa erro por padrão.
- Use classes semânticas (`ui-panel`, `ui-field`, `ui-button-primary`, `ui-button-secondary`, `ui-dialog`) e utilitários do tema. Não sobrescreva classes Tailwind globais nem introduza cores avulsas por tela.
- Preserve escala de fonte, menus, campos, permissões, fluxo de dados e rolagem horizontal necessária a tabelas.

---

## Adding a Data Feature (Checklist)

1. Update `database.sql` if schema changes
2. Defina contratos compartilhados e regras em `core/db.ts`.
3. Adicione rota autenticada/validada em `server/app.ts`.
4. Exponha o método HTTP tipado em `src/services/httpAdapter.ts` e na facade.
5. Use `db.*` nos componentes via `useData`.

## Fluxo para novas tarefas

1. Identifique a área em `docs/modules.md`.
2. Consulte o documento de arquitetura, banco ou autenticação correspondente.
3. Inspecione somente os entrypoints e dependências indicados.
4. Faça a menor alteração consistente; novo acesso a dados segue a cadeia service HTTP → API → core.
5. Execute `npm run lint` e, quando bundling/empacotamento for afetado, `npm run build`.
6. Atualize a documentação somente se uma fronteira arquitetural ou decisão mudar.
