# Piloto MagisForm na Cloudflare

Esta é uma migração em andamento para Workers, Static Assets, D1 e Cloudflare Access. O piloto implementa o contrato anterior e **ainda não oferece o fluxo atual de pedidos**; a tela da farmácia indica essa limitação. O runtime **não está aprovado para publicação**: precisa de adaptação para pedidos, testes de navegador, revisão completa de papéis e configuração real da conta/Access. Use exclusivamente dados fictícios.

## Arquitetura local

- `worker.ts`: valida JWT RS256 do Access, resolve identidade, tenant, convites, sessões e CSRF; atende API de negócio e plataforma.
- `migrations/`: migrations D1 ativas e versionadas; `schema.sql` é o snapshot gerado.
- `tests/`: integração em `workerd` com D1, duas farmácias e chaves Access de teste.
- `/`: seleção de farmácias vinculadas; `/t/{slug}/`: informa que o fluxo de pedidos ainda não está disponível; `/management/`: gestão global.
- `wrangler.jsonc`: usa marcadores não implantáveis para D1 e Access; preencher somente na preparação aprovada da conta.

## Comandos locais

```powershell
npm ci
npm run lint
npm run lint:cloudflare
npm run test:workers
npm run build:cloudflare
```

O `build:cloudflare` termina em `wrangler deploy --dry-run`; não publica. Banco local:

```powershell
npm run d1:preflight:local
npm run d1:upgrade:local
```

O schema nunca é criado durante requests. Migrations remotas exigem identificação explícita de conta/banco e ficam para etapa posterior.

## Condições antes de publicar

1. Completar os endpoints/contratos usados por toda a interface e confirmar as permissões por papel.
2. Cobrir as jornadas no navegador e testar isolamento e rollback em mutações relacionadas.
3. Preparar Zero Trust Free, hostname `workers.dev`, allowlist de e-mails e audiência Access; bloquear tudo por padrão.
4. Criar um D1 e um Worker, aplicar migrations remotas explicitamente e publicar somente depois de validar proteção Access.
5. Testar com dados fictícios, observar cotas Free, documentar recuperação e operação.

Não importe o MariaDB. Não ative planos pagos nem use dados reais neste piloto.
