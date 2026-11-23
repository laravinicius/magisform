# Banco de dados

MariaDB é acessado por `mysql2/promise` através de `Db` em `core/db.ts`. `database.sql` descreve o schema consolidado de instalação limpa e não cria usuário administrativo. O schema atual é v5.

O ADR-002 define as operações explícitas `npm run db:bootstrap`, `npm run db:preflight` e `npm run db:upgrade`. Configure `MAGISFORM_DB_HOST`, `MAGISFORM_DB_PORT`, `MAGISFORM_DB_NAME`, `MAGISFORM_DB_USER` e `MAGISFORM_DB_PASSWORD` ou `MAGISFORM_DB_PASSWORD_FILE` para os comandos. O bootstrap aceita somente banco vazio; upgrades são versionados em `database/upgrades/`. Os arquivos de `migrations/` são históricos e não são executados automaticamente. Abrir a aplicação, conectar o pool ou atender requests não executa DDL.

Antes de atualizar uma instalação existente, faça backup com restauração ensaiada, feche os clientes e execute o preflight; em seguida rode o upgrade e repita o preflight. Não aplique `database.sql` sobre um banco existente. **O upgrade 005 descarta as tabelas de clientes, fórmulas e modelos anteriores, bem como o catálogo antigo de insumos e seus logs de negócio.** Pedidos existentes, seus eventos e cópias dos dados, farmácias, vínculos e usuários são preservados. Execute-o apenas quando essa remoção estiver autorizada.

Os upgrades usam lock exclusivo e conferência de versão, estrutura e checksum. O progresso da etapa 005 é registrado em `schema_upgrade_progress` antes das mudanças. Como DDL não tem rollback transacional garantido, em caso de interrupção mantenha a aplicação em manutenção, execute o preflight e retome o upgrade explícito ou restaure o backup. A API só fica pronta com schema v5.

## Entidades atuais

- `users` e `sessions`: usuários, perfis e sessões hospedadas.
- `insumos`: catálogo de matérias-primas para os pedidos.
- `action_logs`: auditoria de acesso e das operações atuais.
- `partner_pharmacies`, `partner_memberships` e `partner_patients`: farmácias solicitantes, seus usuários e pacientes.
- `orders` e `order_events`: solicitação original, dados atuais, proposta pendente e histórico de decisões.
- `schema_version`, `schema_upgrade_history` e `schema_upgrade_progress`: controle operacional dos upgrades.

Os pedidos preservam cópias dos dados enviados, inclusive nomes de insumos, independentes de alterações posteriores no catálogo. Consulte `database.sql` para tipos e constraints. Uma alteração de schema exige revisar os contratos compartilhados, queries, endpoint HTTP, adapter e UI. Não inclua credenciais ou hashes na documentação.
