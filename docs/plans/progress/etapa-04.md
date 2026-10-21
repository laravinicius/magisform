> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 04 — Evolução segura do schema e compatibilidade de releases

**Estado:** concluída no escopo de schema/runner e MariaDB isolado. Nenhum upgrade foi executado em banco operacional. O gate de distribuição da release compatível permanece obrigatório antes de atualizar bancos de clientes.

## Dependência e limite

- Etapa 03 concluída conforme `etapa-03.md`.
- Preservadas as alterações preexistentes de etapa 03 no worktree; esta etapa não refatorou regras de negócio nem aplicou migrations históricas.
- `migrations/` não é lido pelo executor. Bootstrap, preflight e upgrade nunca são chamados pelo startup do Electron, pelo pool ou por request.

## Alterações

- ADR-002 substitui somente a decisão de ADR-001 que vedava novos upgrades: `database.sql` continua schema consolidado; upgrades novos ficam em `database/upgrades/`; o histórico em `migrations/` permanece inerte.
- `AGENTS.md` registra os caminhos atuais (`core/db.ts`), a regra de schema e os comandos operacionais.
- `database.sql` representa instalação limpa v1, sem usuário/senha padrão. Senha comporta hash codificado (`VARCHAR(255)`). Sessões incluem `policy`, `expires_at`, `absolute_expires_at` e unicidade por `user_id`.
- `database/upgrades/001-password-session-expansion.sql` amplia a coluna de senha, invalida todas as sessões legadas, acrescenta metadados de política/expiração e índice único por usuário. As instruções são idempotentes para retomada após DDL MariaDB parcialmente confirmado.
- `scripts/database-schema.mjs` oferece os comandos `db:bootstrap`, `db:preflight` e `db:upgrade`. O bootstrap aceita somente banco vazio. O preflight reconhece o schema legado suportado por tabelas, colunas e engines InnoDB; schema desconhecido falha sem DDL. O upgrade registra versão/checksum em `schema_version`/`schema_upgrade_history`, usa `GET_LOCK` exclusivo (timeout padrão de 30 s; configurável para 1–60 s) e só avança a versão após concluir todos os DDL.
- `docker-compose.yml` não monta mais `database.sql` no entrypoint automático do container. `docs/database.md` descreve configuração, backup, restore e retomada.

## Compatibilidade de senha e sessão

- A coluna agora aceita hashes codificados, mas o runtime continua usando SHA-256 e tokens de sessão no formato atual. Rehash Argon2id, digest de token e enforcement de expiração são etapa 05.
- O upgrade encerra as sessões existentes; usuários precisam autenticar novamente após a janela de manutenção.
- Banco atualizado v1 não deve ser aberto durante a alteração, e nenhum cliente antigo deve permanecer conectado durante o DDL.

## Requisitos de release Electron

- A release operacional de upgrade deve incluir a ferramenta explícita e os arquivos de `database/upgrades/`, além de instruções de backup/restore. O empacotamento Electron atual contém apenas `dist` e `dist-electron`; esta etapa não alterou o pacote instalável nem publicou versão.
- Não liberar upgrade de cliente antes de existir uma release Electron coordenada que implemente a transição de senha da etapa 05. O artefato atual é `0.2.2`; a próxima release deve ter versão própria e ser instalada/validada antes da janela de upgrade. **Não declarar `0.2.2` como release compatível com hashes Argon2id.**
- Runbook de release: parar todos os clientes; executar preflight; produzir dump consistente e comprovar restore em banco QA; registrar checksum e versão do executor; rodar upgrade explicitamente; conferir versão/checksum, IDs/relacionamentos/datas/auditoria e ausência de sessões; liberar somente o Electron compatível. Em falha, manter manutenção e retomar após preflight ou restaurar o dump. Não presumir rollback de DDL nem reduzir `users.password` depois do rehash.
- Requisito de distribuição segue pendente para a etapa de release: incluir/utilizar a ferramenta em ambiente do operador sem dependência de execução do DDL durante startup. Nenhuma release foi construída ou distribuída nesta etapa.

## Evidências MariaDB

Executado em container MariaDB 11 efêmero `magisform-etapa04-qa-20261008`, publicado apenas em `127.0.0.1:33367`, sem volume persistente e sem credenciais de cliente.

- **Instalação limpa:** `npm run db:bootstrap` criou schema v1 sem usuários; preflight passou; executar upgrade em bootstrap v1 não aplicou DDL.
- **Upgrade legado:** fixture baseada no schema anterior com usuário sintético id 17, cliente id 31, fórmula id 41 com `delivery_date=2026-10-08`, item de fórmula id 51 (insumo 999), log de auditoria id 61 e duas sessões legadas. A retomada resultou em versão 1, senha `VARCHAR(255)`, três colunas novas de sessão e zero sessões. IDs, data civil, fórmula, relacionamento com cliente/insumo, item e log permaneceram.
- **Interrupção/retomada:** fixture foi deixada no estado de upgrade v0 após DDL persistente de exclusão de sessões e expansão da coluna de senha; o comando `db:upgrade` completou os DDL restantes e avançou a versão.
- **Repetição:** rodar upgrade novamente foi no-op com checksum válido.
- **Incompatibilidade:** banco contendo apenas uma tabela não relacionada foi recusado por preflight e upgrade; ambos retornaram erro sem criar tabelas do MagisForm.
- **Checksum:** adulterar o checksum registrado fez o preflight falhar com orientação de restore.
- **Lock:** manter `GET_LOCK` em outra conexão e iniciar bootstrap resultou em erro por timeout de 1 s; nenhum schema foi inicializado pelo processo concorrente.
- **Backup/restauração:** `mariadb-dump --single-transaction` do banco migrado; drop/recriação e import do dump; consulta confirmou versão 1, usuário, fórmula/data, item/relacionamentos, auditoria, ausência de sessões, senha com tamanho 255 e três campos de sessão.
- O container QA e seu volume anônimo temporário foram removidos após os ensaios.

## Verificações do repositório

- `npm run lint` — passou (`tsc --noEmit`).
- `npm test` — passou: 3 testes de contratos. Os 3 testes de integração existentes ficaram pulados porque o runner deles exige `MARIADB_HOST`; os cenários desta etapa foram exercitados separadamente no MariaDB efêmero descrito acima.
- `git diff --check` — sem erros após remover a linha vazia final de `database.sql`; os avisos LF/CRLF são preexistentes em `src/services/lanDatabase.ts` e `src/types.ts`.
- `npm run build` não executado: nenhum entrypoint, código Electron empacotado ou configuração de build foi alterado; a ferramenta do schema é comando operacional explícito fora do startup.

## Gate e rollback

**Gate da etapa 04:** bootstrap limpo e upgrade legado convergem no schema v1; preflight, versão/checksum, lock, repetição, retomada, recusa de incompatibilidade e restore foram demonstrados em MariaDB isolado. O release gate exige backup/restauração, janela de manutenção, ferramenta distribuída e Electron compatível com Argon2id antes de atualizar banco de cliente.

**Rollback:** não executar downgrade SQL. Em DDL parcial ou incompatibilidade, manter clientes fechados e restaurar o backup ensaiado; depois investigar o schema restaurado. Após rehash de senhas na etapa 05, também é necessário usar release compatível ou restaurar em coordenação, sem reduzir a coluna.

**Etapa 05 permanece pendente.**
