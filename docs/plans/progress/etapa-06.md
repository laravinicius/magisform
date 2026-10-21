> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 06 — Backend HTTP completo

**Estado:** concluída para implementação e gate local. Nenhuma publicação ou implantação foi feita.

Checkout registrado no início: branch `main`, HEAD `dfc4e63559d2d8ae6611dca396eccd6735c5f186`. O worktree já continha alterações das etapas anteriores; elas foram preservadas. Não houve commit.

## Gate da dependência 05

O gate [etapa-05.md](etapa-05.md) está aprovado para lint, MariaDB QA de sessão/autorização/rehash/auditoria, N-API Windows e pacote NSIS. O teste do aplicativo instalado e a validação integrada Electron/MariaDB continuam pendentes; não foram tratados como evidência desta etapa.

## Implementação

- Criado `server/` com Fastify 5, TypeScript, Zod 4, OpenAPI/Swagger UI, rate limit e pool MariaDB por processo. Os scripts `dev:server`, `build:server`, `start:server` e `lint:server` usam `tsconfig.server.json`; `dist-server/` é ignorado. O runtime declarado é Node `>=20 <25`.
- Implementadas as rotas `/api/v1`: CSRF/login/me/logout/heartbeat web; login desktop; usuários; clientes; insumos; fórmulas (status, entrega, verificação e lote); modelos; logs; configuração pública; health live/ready. Todas as rotas de dados verificam sessão e reutilizam `Db.withSessionContext`; as regras e permissões continuam no núcleo compartilhado.
- Web usa `__Host-magisform_session` (`Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, sem `Domain`) e cookie CSRF separado com comparação em tempo constante. Login e mutações por cookie exigem Origin canônico e CSRF. Nomes locais de cookie são distintos e configuração sem TLS é limitada a loopback.
- Electron remoto recebe Bearer somente em `/auth/desktop/login`; web não recebe token em JSON. Cookie e Bearer simultâneos são recusados. Não há CORS habilitado. Produção exige Origin HTTPS, Host canônico e senha de banco; headers encaminhados só são confiados para IPs explicitamente configurados.
- Login tem limite de oito tentativas por IP/conta em 15 minutos e limite adicional de 40 por IP. Corpo máximo é 1 MiB. Erros HTTP usam envelopes e códigos estáveis sem SQL, stack ou credenciais. OpenAPI documenta entradas, envelopes e DTOs públicos.
- A configuração de instalação expõe somente nome, marca, versão e capacidades aprovadas. Health live informa o processo; ready exige conexão MariaDB e schema v1 sem devolver detalhes internos. Não foram criadas rotas de setup, bootstrap ou consulta direta ao banco.
- O núcleo passou a persistir SHA-256 do token de sessão aleatório, mantendo o token bruto apenas no transporte. A sessão hosted segue a política do plano: 8 horas de inatividade e 24 horas absolutas, limitadas e configuráveis. Somente rotas de negócio com `X-Magisform-Activity: user` renovam inatividade; `/auth/me`, heartbeat e polling são passivos.
- Atualizados `docs/authentication.md`, `package.json`, `package-lock.json` e a exceção de `.gitignore` para o relatório desta etapa. `mysql2` ficou em `3.24.5`; versão e releases conferidos no [repositório oficial mysql2](https://github.com/sidorares/node-mysql2/releases).

## Evidências

- `npm run lint` — passou.
- `npm run lint:server` — passou.
- `npm run build:server` — passou; compilou para `dist-server/`.
- `npm test` — passou: 3 testes de contrato; os testes MariaDB foram pulados neste comando por não haver variáveis do harness.
- `npm run test:integration` — passou em MariaDB 11.4 descartável, iniciado e removido pelo harness: **14/14** (10 regressões de núcleo e 4 grupos HTTP), incluindo CRUD de dados, sessão web/desktop, Bearer, digest em repouso, CSRF/Origin, validação, perfis, conflito/force, rate limit, OpenAPI, health, configuração e encerramento do pool.
- `npm run build` — passou para Windows x64/Electron 36.9.5/electron-builder 25.1.8 e gerou `../magisform-release/0.2.2/MagisForm-Setup-0.2.2.exe`. O artefato foi empacotado, não instalado nem distribuído.
- `npm audit --omit=dev` — 0 vulnerabilidades de produção após atualizações compatíveis. A auditoria completa ainda relata **21 vulnerabilidades de dependências de desenvolvimento/empacotamento** (3 críticas, 13 altas e 5 moderadas); as correções indicadas exigem upgrades maiores de Vitest, electron-builder e Electron. Não foram aplicados `--force` nem mudanças de versão fora do escopo desta etapa.
- `git diff --check` — passou. O aviso exibido é somente conversão LF/CRLF em arquivos preexistentes.

## Compatibilidade, limites e rollback

- O desktop local continuou compilando após a mudança do token; não foi executado instalado. Sessões já ativas criadas por um binário anterior à mudança de digest exigem novo login (ou login forçado); não há alteração de dados de negócio. A compatibilidade de releases instaladas continua sob a coordenação registrada no gate 05.
- Não foram feitos browser QA, adapter HTTP do renderer, Electron remoto conectado ao backend, proxy reverso, Docker de produção ou smoke de uma instância servida. Esses itens pertencem às etapas seguintes e não são inferidos pelos testes `inject`.
- O rollback da etapa é desligar o backend; uma instalação desktop local independente continua usando seu próprio processo e MariaDB. Não executar downgrade nem restaurar banco operacional por causa desta etapa.

**Gate da etapa 06:** PASSOU para servidor, contratos HTTP, MariaDB isolado, build backend e build desktop. **Pendente para aceite operacional:** instalar/validar app Windows e exercitar browser, Electron remoto e infraestrutura nas etapas correspondentes; revisar upgrades maiores do toolchain apontados pela auditoria completa antes da versão candidata.
