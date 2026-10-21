> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 07 — Aplicação web com paridade funcional

**Estado:** concluída para o escopo e os critérios de validação desta etapa. Nenhuma publicação ou implantação foi feita.

## Dependências e limites

- Os relatórios `etapa-03.md` e `etapa-06.md` estão concluídos; as facades desktop e o backend HTTP existentes foram mantidos como contratos de referência.
- O checkout já continha alterações extensas das etapas 00–06. Foram mantidas; não houve commit.
- QA ponta a ponta usou MariaDB 11.4 descartável, schema sintético `magisform_qa` e contas sem dados reais. O container foi removido ao final.

## Implementação

- `src/services/httpAdapter.ts` implementa a facade de negócio por HTTP de mesma origem para autenticação, usuários, clientes, insumos, fórmulas, modelos e auditoria. Envelopes e erros preservam o contrato compartilhado; conflitos de sessão voltam à UI como conflito explícito. Falha transitória continua erro de conexão e não é convertida em senha inválida.
- CSRF é inicializado por `/auth/csrf`; o cookie CSRF é definido pelo servidor e o token devolvido à aplicação fica em memória até a próxima sessão. Login, mutações e logout enviam o header CSRF. O cookie da sessão permanece HttpOnly; nenhum token de sessão foi armazenado em JavaScript, localStorage ou IndexedDB.
- A aplicação consulta `/auth/me` antes de mostrar conteúdo protegido, restaura a sessão depois de reload e limpa o contexto em 401 de rotas autenticadas. Login forçado respeita a confirmação já usada pela UI. Logout web usa a confirmação existente e remove sessão, rascunhos e dados em memória.
- A facade de plataforma esconde capacidades nativas indisponíveis no browser: barra/updater e setup/conexão ficam no desktop; o link de WhatsApp usa nova aba segura. O estado de navegação permanece React, sem roteador.
- `useData` recebe chaves explícitas (`customers`, `formulas`, `users`, etc.) e escopa recursos por origem e geração de sessão. Troca de sessão desassocia a cache anterior. Mutação bem-sucedida invalida os recursos inscritos. Carregamentos de navegação enviam `X-Magisform-Activity: user`; polling de 10 segundos envia `passive`.
- Rascunhos continuam em memória. No browser, `beforeunload` só é instalado enquanto existe rascunho ativo. Em viewport abaixo de 900 px o menu inicia recolhido e adapta a largura ao redimensionamento; tabelas mantêm rolagem horizontal interna.
- `server/app.ts` serve `dist-web/` e a API sob a mesma origem quando o bundle existe. `dev:web` usa porta 3002 e proxy `/api` para o backend em loopback; a varredura do Vite foi limitada ao entrypoint web para não tentar otimizar os artefatos desktop de `dist/`.
- `docs/authentication.md` foi atualizado; o relatório desta etapa foi liberado no `.gitignore`.

## Evidências automatizadas

- `npm run lint` — passou (`tsc --noEmit`).
- `npm run lint:server` — passou.
- `npm run build:server` — passou.
- `npm test` — passou: 3 testes de contrato; 14 testes MariaDB/HTTP foram pulados neste comando por não usar variáveis do harness.
- `npm run test:integration` — passou: **14/14** testes em MariaDB 11.4 descartável (10 de núcleo e 4 grupos HTTP), incluindo autorização, conflito/force, CSRF/Origin e CRUD HTTP.
- `npm run build:web` — passou; bundle em `dist-web/` e auditoria de 17 arquivos sem runtime Node/Electron, driver MariaDB ou variáveis de segredo detectáveis. O Vite manteve aviso de chunk JS acima de 500 kB.
- `npm run build` — passou para Windows x64/Electron 36.9.5/electron-builder 25.1.8; gerado `../magisform-release/0.2.2/MagisForm-Setup-0.2.2.exe`. Artefato não instalado nem distribuído.
- `git diff --check` — passou; Git emitiu apenas avisos de normalização LF/CRLF nos arquivos alterados.

## Evidências reais no browser

Testado com Playwright CLI em `http://127.0.0.1:3001` servindo o bundle web e, depois, via `http://127.0.0.1:3002` com `dev:web` e proxy da API. As duas origens apontaram para o mesmo banco QA descartável.

- Login válido e reload — sessão restaurada por `/auth/me` e cookie; conteúdo do dashboard só apareceu após restaurar o usuário.
- CRUD de cliente — criação, leitura na tabela, edição do nome e exclusão com reautenticação administrativa concluídos.
- Fórmula — cliente e insumo selecionados, orçamento sintético de R$ 42,50, pagamento “Pago” por Pix, confirmação e transições “Em produção” → “Aguardando retirada” → “Entregue” concluídas pela UI.
- Sessão concorrente — segundo contexto recebeu conflito e apresentou “Entrar mesmo assim”. Após force, o contexto antigo recebeu 401 em carregamento protegido via polling, limpou o usuário/cache e voltou ao login com aviso de sessão encerrada.
- Logout — confirmação explícita, retorno ao login; uma conta de gerente também autenticou e restaurou a sessão no servidor web de desenvolvimento.
- Narrow — viewport 390×844 sem overflow horizontal global (`scrollWidth=390`). Na tabela de clientes, a largura de conteúdo medida foi 596 px em viewport interno de 214 px com `overflow-x:auto`, preservando a rolagem da tabela.
- Captura de narrow viewport: `.playwright-cli/page-2026-10-08T15-45-26-440Z.png` (evidência local, ignorada pelo Git).
- Os 401 de `/auth/me` sem cookie são respostas HTTP esperadas e não geram erro de aplicação; o Vite confirmou uma única chamada na inicialização mesmo em React StrictMode.

## Compatibilidade, limitações e rollback

- Electron local continua usando o adapter IPC e a mesma tela; lint e build/empacotamento desktop passaram após as mudanças do renderer. Não foi iniciado um login Electron contra MariaDB para evitar qualquer acesso a banco fora do QA web.
- A validação browser cobre os fluxos solicitados nesta etapa, mas não substitui a matriz completa dos três modos, dispositivos, carga, proxy TLS, produção e operações concorrentes prevista para as etapas 08 e 11.
- O rollback web é retirar o bundle/serviço HTTP da instalação publicada; os arquivos não alteram dados do banco. O QA local foi removido e nenhuma infraestrutura externa foi tocada.

**Gate da etapa 07:** adapter HTTP, sessão web restaurável, conflito/force/logout/401, CRUD sintético, fórmula/pagamento/entrega, narrow e build desktop validados. Nenhuma etapa posterior foi iniciada.
