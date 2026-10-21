# Mapa de módulos

| Área | Localização | Responsabilidade | Verificar junto |
|---|---|---|---|
| Shell | `src/App.tsx`, `src/main.tsx` | Login, modo setup, abas, saída e composição | `AuthContext`, componentes, service |
| Fórmulas | `RecipeForm.tsx`, `FormulaList.tsx`, `Dashboard.tsx` | Criar, editar, confirmar, acompanhar e listar | `db.formulas`, clientes, insumos, schema |
| Cadastros | `CustomerManager.tsx`, `InsumoManager.tsx`, `SavedFormulaManager.tsx` | Clientes, insumos e modelos salvos | `useData`, `core/db.ts`, tabelas |
| Administração | `UserManager.tsx`, `AdminUserManager.tsx`, `AuditLogs.tsx`, `SettingsManager.tsx` | Usuários, permissões, logs e conexão | autenticação, `action_logs`, config |
| Estado | `src/context/`, `src/hooks/useData.ts` | Sessão, rascunho, polling e refresh | `App.tsx`, `lanDatabase.ts` |
| Dados web | `server/app.ts`, `src/services/httpAdapter.ts`, `core/db.ts` | API, pool, queries, sessão, autorização e auditoria | `database.sql`, UI |
| Gerenciamento | `management/`, `manager/`, `deploy/` | Painel, executor e instalações Docker isoladas | provisionamento, proxy e segredos |

## Caminhos rápidos

- Tela ou fórmula: componente da tela → `lanDatabase.ts` → HTTP → método em `core/db.ts` → schema.
- Nova operação: contrato compartilhado, endpoint HTTP, adapter e facade.
- Campo persistido: `src/types.ts`, `RecipeForm.tsx`, `db.ts` e `database.sql`.
- Login/permissões: [authentication.md](authentication.md), `AuthContext.tsx`, `server/app.ts` e `core/db.ts`.

O código permanece a fonte da verdade para detalhes de funções e payloads; esta página registra relações e pontos de investigação.
