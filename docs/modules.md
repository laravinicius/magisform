# Mapa de módulos

| Área | Localização | Responsabilidade | Verificar junto |
|---|---|---|---|
| Shell | `src/App.tsx`, `src/main.tsx` | Login, navegação, saída e composição | `AuthContext`, componentes, service |
| Pedidos | `OrdersWorkspace.tsx`, `PartnerManager.tsx` | Cadastro de farmácias, envio de fórmulas, atendimento e aprovação de propostas | `orders`, `partners`, sessão, isolamento |
| Insumos | `InsumoManager.tsx` | Catálogo compartilhado para a criação de pedidos | `useData`, `core/db.ts`, tabelas |
| Administração | `UserManager.tsx`, `AuditLogs.tsx` | Usuários, permissões e auditoria | autenticação, `action_logs`, config |
| Estado | `src/context/`, `src/hooks/useData.ts` | Sessão, rascunho, polling e refresh | `App.tsx`, `lanDatabase.ts` |
| Dados web | `server/app.ts`, `src/services/httpAdapter.ts`, `core/db.ts` | API, pool, queries, sessão, autorização e auditoria | `database.sql`, UI |
| Gerenciamento | `management/`, `manager/`, `deploy/` | Painel, executor e instalações Docker isoladas | provisionamento, proxy e segredos |

## Caminhos rápidos

- Tela ou pedido: componente da tela → `lanDatabase.ts` → HTTP → método em `core/db.ts` → schema.
- Nova operação: contrato compartilhado, endpoint HTTP, adapter e facade.
- Campo persistido: `shared/contracts.ts`, `OrdersWorkspace.tsx`, `core/db.ts` e `database.sql`.
- Login/permissões: [authentication.md](authentication.md), `AuthContext.tsx`, `server/app.ts` e `core/db.ts`.

O código permanece a fonte da verdade para detalhes de funções e payloads; esta página registra relações e pontos de investigação.
