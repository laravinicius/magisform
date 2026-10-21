# MagisForm

Sistema exclusivamente web para o fluxo de manipulação farmacêutica, do orçamento à entrega. React 19, Vite, TypeScript, Tailwind CSS v4, API Fastify e MariaDB. O acesso é pelo navegador; não há aplicativo Electron, instalador Windows ou atualizador desktop.

Cada cliente possui uma instalação Docker isolada, com aplicação, banco, volume, segredos e redes próprios. O painel central gerencia o provisionamento e as ações de iniciar, parar e reiniciar. O Nginx Proxy Manager publica os endereços HTTPS.

## Desenvolvimento

Use Node.js 22 e instale as dependências com `npm ci`.

1. Use `.env.example` como referência e exporte as variáveis no terminal da API; o backend não carrega `.env` automaticamente. Configure `MAGISFORM_SERVER_DB_HOST`, `MAGISFORM_SERVER_DB_PORT`, `MAGISFORM_SERVER_DB_NAME`, `MAGISFORM_SERVER_DB_USER` e `MAGISFORM_SERVER_DB_PASSWORD` (ou `MAGISFORM_SERVER_DB_PASSWORD_FILE`), conforme `server/config.ts`.
2. No ambiente da API, defina também `MAGISFORM_SERVER_ORIGIN=http://127.0.0.1:3002` para aceitar as requisições do frontend. Inicie a API com `npm run dev:server` em `127.0.0.1:3001`.
3. Em outro terminal, execute `npm run dev` e abra `http://127.0.0.1:3002`. O Vite encaminha `/api` para a API.

Bootstrap e upgrades de banco são operações explícitas. Consulte [banco](docs/database.md) antes de executá-los; iniciar o servidor nunca aplica DDL.

## Comandos

| Comando | Resultado |
|---|---|
| `npm run dev` / `npm run dev:web` | Frontend web na porta 3002 |
| `npm run dev:server` | API em desenvolvimento |
| `npm run build` | Aplicação web, painel e backend |
| `npm run build:web` | `dist-web` e auditoria de bundle |
| `npm run build:server` | Backend em `dist-server` |
| `npm run build:manager` | Painel em `dist-manager` e backend |
| `npm run start:server` | API compilada, servindo `dist-web` na mesma origem |
| `npm run manager:setup` / `npm run manager:api` | Configuração explícita e execução do painel |
| `npm run tenant:provision -- <id> <host> --image <imagem-aprovada>` | Preparação de instalação isolada; `--apply` executa o provisionamento |
| `npm run lint` / `npm run lint:server` | Verificação TypeScript |
| `npm test` | Testes unitários; integrações exigem MariaDB configurado |
| `npm run test:integration` | MariaDB Docker descartável e testes de integração |
| `npm run test:docker` | QA com dois clientes descartáveis e ações reais do painel; compila a imagem QA local e exige Docker disponível |
| `npm run clean` | Remove somente `dist-web`, `dist-server` e `dist-manager` |

## Arquitetura e implantação

| Pasta | Responsabilidade |
|---|---|
| `src/`, `public/`, `config/` | Aplicação React, recursos públicos e identidade visual |
| `server/`, `core/`, `shared/` | API HTTP, persistência e contratos compartilhados |
| `management/`, `manager/` | Interface e API/executor do painel de gerenciamento |
| `database/`, `database.sql` | Upgrades versionados e schema de instalação limpa |
| `deploy/`, `scripts/`, `tests/` | Implantação, ferramentas operacionais e validações |
| `docs/`, `website/` | Documentação e site institucional independente |

`React → lanDatabase.ts → httpAdapter.ts → /api/v1 → core/db.ts → MariaDB`.

O navegador usa cookie HttpOnly e CSRF. Não recebe credenciais MariaDB nem token de sessão em JSON. Cada cliente acessa seu próprio domínio; banco e volumes não são compartilhados.

- [Arquitetura](docs/architecture.md) e [módulos](docs/modules.md).
- [Autenticação e permissões](docs/authentication.md).
- [Instalações por cliente](docs/deployment/tenant-installations.md).
- [Painel de gerenciamento](docs/deployment/management-console.md) e [instalação do gerenciador](docs/deployment/manager-installation-runbook.md).
- [Operação e recuperação](docs/deployment/operations.md).

`Dockerfile` gera a imagem web/API; `Dockerfile.manager` gera a imagem do painel/executor. Os builds não publicam imagens. Segredos, catálogos operacionais e volumes não devem entrar no Git.

O site institucional independente está em `website/`. A identidade visual usa `config/branding.ts`, fontes locais e os vetores aprovados em `public/brand/`.

As únicas saídas de compilação atuais são `dist-web/`, `dist-server/` e `dist-manager/`, todas ignoradas pelo Git. Evidências de QA em `output/`, caches e configurações operacionais também ficam fora do versionamento. Os registros de etapas em `docs/plans/progress/` e o ADR-002 preservam o histórico anterior à migração web; consulte os mapas de arquitetura e módulos para o estado atual.
