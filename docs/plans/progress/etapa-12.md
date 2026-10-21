> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 12 — Painel de gestão e provisionamento

**Estado:** implementação base concluída e verificações locais aprovadas. Gate operacional pendente: a etapa 11 não foi aprovada; não houve publicação, provisionamento real, nem QA de ponta a ponta com várias instalações Docker.

## Implementação

- Aplicação web de gestão independente, com marca e tokens MagisForm, painel responsivo, atualização periódica e estados separados para aplicação e MariaDB.
- Login de operador provisionado por CLI com Argon2id e TOTP obrigatório; sem cadastro web. API aplica rate limit, sessão com validade ociosa/absoluta, cookies seguros em produção, CSRF, validação estrita de Origin e auditoria sem corpo/segredos.
- Executor separado em rede privada. Somente ele recebe o socket Docker; a API web chama uma interface interna com token. O executor expõe ações fechadas, aceita imagens por digest allowlist e reutiliza `scripts/provision-tenant.mjs` e o Compose de instalação.
- Criação mostra os dados do administrador inicial na resposta única da operação; o painel não oferece exclusão. A alternativa manual gera Compose, `.env.example` e instruções com dados para configurar o Proxy Host, sem segredos de instalação.
- A etapa 12 foi inserida antes do piloto, agora etapa 13. O guia operacional, backup e comandos de operador estão em [management-console.md](../../deployment/management-console.md).

## Verificações realizadas

| Verificação | Resultado | Limite |
|---|---|---|
| `npm run lint:server` | Aprovado | Verificação TypeScript do backend. |
| `npm test` | 12 testes passaram; 17 testes de integração foram pulados por ausência de MariaDB configurada | Inclui TOTP, autenticação/CSRF, repetição de TOTP, autorização, criação, ações e pacote. |
| `npm run build:manager` | Aprovado | Bundle de produção gerado em `dist-manager/`. |
| `docker compose --env-file deploy/manager/.env.example -f deploy/manager/compose.yaml config -q` | Aprovado | Valida a composição, não a implantação em rede NPM. |
| `docker build -f Dockerfile.manager -t magisform-manager:stage12-qa .` | Aprovado | Imagem criada localmente; não publicada. |
| Browser Playwright com API/controlador sintético | Login TOTP e painel com duas empresas apresentados | Smoke visual apenas; o controlador não opera Docker nem provisiona instalações reais. |

## Pendências e gate

- A etapa 11 está reprovada no critério de p95: com 20 usuários por instalação, `GET /formulas` mediu 1.175/1.204 ms no backend frente ao limite de 1 s. O relatório da etapa 11 também registra pendências de validação do Electron empacotado. Portanto, a etapa 12 não está autorizada para publicação e o piloto etapa 13 continua bloqueado.
- Ainda falta executar QA isolado com Docker para duas instalações sintéticas: provisionamento pelo executor, isolamento de volumes/redes/bancos, falha parcial e recuperação, ações start/stop/restart e geração/aplicação do pacote.
- Ainda falta smoke visual de acessibilidade com teclado/leitor de tela e conferência responsiva em browser real. A inspeção Playwright cobriu login e painel desktop; não comprova esse aceite completo.
- DNS, HTTPS público, configuração real no NPM, instalação administrativa e qualquer operação de produção permanecem fora deste gate.

Nenhum banco, volume, instalação de cliente, DNS ou serviço de produção foi alterado. Nenhum commit ou publicação foi feito.
