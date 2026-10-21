# Banco de dados

MariaDB é acessado por `mysql2/promise` através de `Db` em `core/db.ts`. `database.sql` descreve o schema consolidado para instalação limpa e não cria usuário padrão.

O ADR-002 define o contrato operacional: bootstrap e upgrade explícitos (`npm run db:bootstrap`, `npm run db:preflight`, `npm run db:upgrade`), upgrades novos somente em `database/upgrades/`, e `migrations/` permanece histórico inerte. A conexão automática do aplicativo nunca executa DDL. Configure `MAGISFORM_DB_HOST`, `MAGISFORM_DB_PORT`, `MAGISFORM_DB_NAME`, `MAGISFORM_DB_USER` e `MAGISFORM_DB_PASSWORD` antes de invocar os comandos. Bootstrap só aceita banco vazio; upgrade exige backup e parada dos clientes.

Versão atual do schema: v3. O upgrade 001 amplia `users.password` para formatos codificados, invalida sessões existentes, adiciona política/expiração e impõe unicidade por usuário. O upgrade 002 adiciona `idx_formulas_created_id(created_at,id)` para a navegação estável e paginada de fórmulas; ele é idempotente e retomável. O upgrade 003 adiciona autoria em fórmulas e modelos salvos, amplia as unidades de orçamento para VARCHAR(16) e recupera autoria antiga somente com um único log de criação válido. Ele também é idempotente e retomável. A etapa 05 usa Argon2id e transita SHA-256 legado após autenticação válida; o enforcement aceita somente a política `hosted`; o valor `desktop_local` permanece apenas no schema histórico, sem permitir autenticação. Os metadados e checksums dos upgrades residem no próprio schema (`schema_version`, `schema_upgrade_history`). DDL parcial não tem rollback transacional garantido: em falha, mantenha manutenção, execute preflight e retome o upgrade idempotente ou restaure o backup ensaiado.

Para instalação nova, use um banco MariaDB vazio e execute `npm run db:bootstrap`. Para banco legado, execute `npm run db:preflight`, faça backup com restauração ensaiada, feche todos os clientes, então rode `npm run db:upgrade` e repita o preflight. Não aplique `database.sql` sobre banco existente.

## Entidades

- `users`: usuários e roles `employee`, `pharmacist`, `manager` e `admin`, nessa ordem de acesso.
- `customers`: clientes, com telefone único.
- `insumos`: matérias-primas.
- `formulas`: cliente, orçamento, pagamento, entrega e status.
- `formula_items` e `formula_budget_items`: composição e opções de orçamento.
- `saved_formulas`, `saved_formula_items`, `saved_formula_budget_items`: modelos reutilizáveis.
- `sessions`: token e `last_seen`.
- `action_logs`: auditoria.

Fórmulas pertencem a clientes; seus itens referenciam insumos; modelos salvos também referenciam insumos. Itens dependentes usam cascata, enquanto insumos em uso são protegidos por `RESTRICT` e validação da aplicação.

Uma mudança de schema normalmente exige revisar `database.sql`, `src/types.ts`, queries/payloads em `db.ts`, service HTTP e endpoint. Consulte `database.sql` para tipos e constraints, sem duplicá-lo aqui.

## Entrega efetiva e total mensal

`formulas.delivery_date` é a previsão preenchida no formulário. `formulas.delivered_at` registra automaticamente a entrega efetiva pelo backend como `DATETIME` no fuso `America/Sao_Paulo`. O histórico usa o mês e o ano de `delivered_at`. O filtro de pagamento soma os orçamentos selecionados para pagas, não pagas (vazio ou `nao_pago`) e na retirada; para parciais, soma apenas `partial_payment_amount`. A agregação ocorre no banco, independentemente da paginação da lista. Entrega não exige pagamento quitado. Edições e operações repetidas preservam essa data; sair do andamento `entregue` limpa o registro, e uma nova entrega registra uma nova data.

Fórmulas antigas sem `delivered_at` continuam no histórico, mas não entram no total mensal. Não há recuperação automática pelos logs nem uso da previsão como aproximação. Para um banco de teste já inicializado, adicionar a coluna com `ALTER TABLE formulas ADD COLUMN IF NOT EXISTS delivered_at DATETIME NULL COMMENT 'Entrega efetiva no fuso America/Sao_Paulo, registrada pelo backend';`. Antes da implantação em produção, validar a atualização do schema e definir o tratamento das entregas antigas, preservando os dados existentes.

Não copie credenciais, hashes ou valores de configuração sensíveis para documentação. Senhas legadas SHA-256 sem salt são migradas para Argon2id após autenticação bem-sucedida.

## Autoria e pagamento no histórico (schema v3)

`created_by_name` em `formulas` e `saved_formulas` registra o nome da sessão validada no primeiro salvamento. Não integra os inputs e não muda com edições, renomeação ou exclusão do usuário. Repetições/modelos criam registros com a autoria do novo salvamento. A recuperação do upgrade 003 usa exatamente um log `add` da entidade/ID, com nome não vazio e diferente de `Configuração`, preservando `updated_at`; registros sem evidência mostram “Não identificado”.

`formulas.updatePayment` atravessa HTTP (`PATCH /api/v1/formulas/:id/payment`) e usa a transação da sessão com `SELECT ... FOR UPDATE`. Aceita apenas fórmulas entregues ainda não pagas. Quantias parciais devem ser positivas, ter até duas casas decimais e não exceder o único orçamento selecionado. A operação não altera composição, autoria, status ou data de entrega; a auditoria participa da mesma transação. O resumo aceita `paymentStatus` opcional, com `pago` como padrão, em `GET /api/v1/formulas-summary`.

Bancos instalados precisam do upgrade explícito antes desta aplicação. Faça backup com restauração ensaiada, feche os clientes, execute `db:preflight`, `db:upgrade` e novamente `db:preflight` para cada banco/empresa. A API só fica pronta com schema v3. Bootstrap continua exclusivo para bancos vazios. Nenhum DDL é executado no runtime.
