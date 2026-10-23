# Auditoria e gate local Cloudflare

Estado verificado em 2026-10-23. Esta matriz descreve a implementação local; não comprova configuração, proteção ou publicação de recursos remotos.

## Cobertura das operações

| Área / operação | Contrato e rota | Autorização/tenant | Auditoria/atomicidade | Cobertura e lacunas |
|---|---|---|---|---|
| Identidade, CSRF, login, sessão, heartbeat, logout | `httpAdapter.ts`; `/t/:slug/api/v1/auth/*` em `worker.ts` | JWT Access validado; usuário ativo associado por issuer+subject; sessão limitada ao tenant resolvido pelo slug | Aceite de convite usa `D1.batch`; login troca sessão; GET CSRF não altera convite | Integração cobre convite, CSRF, conflito/força de login, expiração e rejeição de reassociação por e-mail. Faltam testes negativos de assinatura/JWKS, `aud`, `iss`, `nbf`, expiração/revogação e inatividade/expiração absoluta. |
| Usuários e convites | `BusinessOperations.users`; `/users` | Perfis não employee gerenciam; não admin não pode atribuir/admin editar admin; consulta e mutação limitadas por `tenant_id` resolvido | Convite/edição/exclusão e log no mesmo batch; último admin protegido também por trigger | Não há matriz completa por papel, colisões concorrentes de convite, revogação e teste rollback dedicado. GET também não filtra `active=1`, necessário para esclarecer contrato de usuários inativos. |
| Clientes e insumos | `BusinessOperations.customers/insumos`; `/customers`, `/insumos` | Leitura autenticada; escrita bloqueia employee; delete somente admin; SQL inclui tenant | Mutação e log em batch; FK/restrições tratam referências | Cobertura exercita cliente, insumo, isolamento e ID estrangeiro. Faltam tabela sistemática de papéis e testes de rollback/auditoria por CRUD. |
| Fórmulas, lista, detalhe e resumo | `BusinessOperations.formulas`; `/formulas`, `/formulas/:id`, `/formulas-summary` | Tenant aplicado a query e filhos; escrita bloqueia employee | Criação/edição com itens, registro de número e log agrupados em batch | Cobertura cobre criação, filhos, resumo parcial e referência cross-tenant sem gravação. Faltam todos os filtros/cursor, payloads-limite, edição e comparação integral de DTOs. |
| Status, entrega, pagamento e verificação | Contrato `formulas.*`; rotas `/status`, `/delivery-status`, `/payment`, `/verification`, `/delivery-status-batch` | Employee bloqueado em mudanças; somente manager verifica; somente admin exclui fórmula | Cada atualização usa `D1.batch` com log; batch de entregas registra por fórmula | Teste cobre status, entrega, pagamento parcial, mas não concorrência em pagamento, rollback, acesso por cada perfil ou batch com IDs de outra farmácia. |
| Modelos salvos | `BusinessOperations.savedFormulas`; `/saved-formulas` | Checagem tenant no Worker; escrita segue regra de perfil | Operações usam batch e log nas rotas implementadas | Sem cobertura direta no teste de integração; comparar todos os campos/referências do contrato antes do release. |
| Auditoria | `BusinessOperations.logs`; `/logs` | Consulta vinculada ao tenant | Logs das mutações de negócio são batch com a mutação | Cobertura confirma log e isolamento básico; filtros, paginação, limites e autorização não estão exaustivamente testados. |
| Seleção e gestão da plataforma | `TenantSelector`, `PlatformManagement`; `/api/platform/v1/tenants`, `/auth/*`, `/installations*` | Seleção lista somente tenants associados à identidade; demais rotas exigem sessão de platform admin; sessão administrativa separada | Gestão e log global em batch; suspensão apaga sessões do tenant | Teste cobre bootstrap por convite, criação/suspensão, bloqueio do tenant e separação de papéis. Faltam gestão de participantes, reativação, isolamento de IDs, expiração/CSRF e matriz de erros. |

## Lacunas priorizadas

1. **P0 — testes de autorização e isolamento completos:** executar cada rota de escrita com `employee`, `pharmacist`, `manager` e `admin`, incluindo IDs de outro tenant e assegurar resposta uniforme sem revelar existência.
2. **P0 — regressão transacional:** falhar propositalmente a última instrução de cada lote e comprovar rollback de dados e auditoria; cobrir concorrência para convites, último admin e pagamento.
3. **P1 — autenticação e sessões:** validar assinatura/JWKS, issuer, audience, `nbf`, validade, rotação, identidade reassociada, logout, revogação, suspensão e inatividade. O modelo deve ser alinhado à política de sessão efetivamente aprovada antes de alterar prazos.
4. **P1 — paridade dos contratos:** comparar saída/payload para todas as operações, com foco em usuários inativos, modelos, detalhes de fórmula, filtros de auditoria e erros.
5. **P1 — navegador:** não há dependência, configuração ou suíte de navegador no package/CI; as 4 verificações atuais rodam em `workerd`, sem comprovar jornadas na UI.
6. **P2 — CI/runtime:** CI ainda instala e valida Fastify/MariaDB, manager e Docker (workflow `ci.yml`). Manter esse runtime até os itens P0/P1 e jornadas de navegador passarem; portanto, sua remoção não é segura agora.

## Schema, configuração e evidências locais

- Migrations ativas: `cloudflare/migrations/0001_initial.sql`; snapshot: `cloudflare/schema.sql`; teste aplica migrations em D1 isolado. `database.sql` e `database/upgrades/` permanecem trilha MariaDB independente.
- Requests não aplicam DDL. `wrangler.jsonc` mantém `REPLACE_WITH_*`; o teste usa `wrangler.test.jsonc` e identidades fictícias.
- `npm run lint:cloudflare`: aprovado.
- `npm run test:workers`: aprovado, 1 arquivo / 5 testes. O runtime instalado alertou que a maior data de compatibilidade suportada é `2026-01-16` e executou com essa data; logo, a configuração `2026-10-23` ainda não foi validada pelo runtime local atual.
- `npm run lint`, `npm run lint:server`, `npm run lint:cloudflare`: aprovados.
- `npm test`: 24 aprovados; 23 testes de integração MariaDB/API ignorados porque dependem dos ambientes correspondentes.
- `npm run build`: aprovado para web e painel; bundle web emite aviso de chunk JavaScript acima de 500 kB.
- `npm run build:cloudflare`: build e `wrangler deploy --dry-run` aprovados; placeholders de conta/D1/Access preservados.
- `npm audit --omit=dev`: 2 achados no runtime legado ainda instalado: Fastify 5.12.5 (baixo, correção disponível) e `ip-address` 10.7.3 (moderado, correção disponível). Ambos estão ausentes do bundle produzido em `.wrangler/deploy`, portanto não são alcançáveis pelo Worker; continuam relevantes aos serviços Fastify enquanto o runtime antigo existir.
- `npm audit fix --dry-run` sinaliza ainda problemas em ferramentas de desenvolvimento/teste, incluindo Vitest/tinypool e dependências do pool Cloudflare, e indica correções disruptivas com `--force`. Nenhuma atualização foi aplicada por esse dry-run. Investigar/atualizar essas dependências e repetir o gate continua pendente.
- Instalação limpa e testes reais em navegador ainda não fazem parte deste gate.
- Nenhuma conta Cloudflare, banco remoto, migration remota ou deployment foi acessado nesta etapa.

## Próxima ordem de trabalho

Fechar matriz de permissões e paridade; adicionar testes de rollback/concorrência; completar testes Access e sessões; implementar e executar jornadas de navegador; atualizar dependências vulneráveis sem upgrades breaking não revisados; então executar instalação limpa e gate local completo. Só depois de aprovação explícita do gate pode começar a preparação remota.
