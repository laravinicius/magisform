> Atualização: as referências desktop deste ADR são históricas. O produto atual é exclusivamente web; permanecem os contratos de bootstrap, upgrade explícito e preservação de checksums.

# ADR-002 — Bootstrap explícito e upgrades versionados de banco

## Status

Accepted — etapa 04.

## Contexto

`database.sql` é o schema consolidado usado para instalação limpa. Bancos já instalados precisam evoluir sem recriação e sem executar o histórico de `migrations/`, que não é um pipeline confiável de atualização.

## Decisão

- `database.sql` continua sendo a representação consolidada do schema atual para bootstrap limpo.
- Todo upgrade novo é versionado em `database/upgrades/`; os arquivos históricos em `migrations/` nunca são executados.
- Bootstrap e upgrade são comandos explícitos de operação. Abertura do Electron, conexão do pool e requests não executam DDL.
- O preflight identifica a estrutura por versão registrada e verificações estruturais. Ausência de versão só é aceita para o legado conhecido; schemas desconhecidos falham sem DDL.
- Upgrades usam lock MariaDB exclusivo, versão e SHA-256 do artefato aplicado. DDL MariaDB pode confirmar implicitamente; upgrades devem suportar retomada idempotente, e rollback após DDL parcial é por restauração de backup ensaiado.
- A etapa 04 amplia espaço de armazenamento de senha para hashes codificados e adiciona política/expiração às sessões, invalidando sessões legadas. Rehash de senha e enforcement de novas políticas pertencem à etapa 05.
- O schema consolidado não contém credencial administrativa padrão. O primeiro administrador é criado pelo fluxo seguro de provisionamento, fora do bootstrap SQL.

## Consequências

Instalações limpas e bancos legados usam caminhos diferentes e explícitos. A distribuição desktop deve ser coordenada: clientes anteriores não são compatíveis com o schema após upgrade. Release de migração precisa incluir backup verificado, janela de manutenção, versão Electron mínima e plano de restore; não se reduz a coluna de senha após rehash.

## Relação com ADR-001

Este ADR substitui somente a decisão do ADR-001 que proibia executor/upgrades novos. `database.sql` permanece schema consolidado; o histórico `migrations/` permanece inerte.
