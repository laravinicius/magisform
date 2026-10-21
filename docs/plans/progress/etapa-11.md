> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 11 — Validação integrada e versão candidata

**Estado:** gate parcial reprovado para versão candidata. QA integrado e ensaios sustentados foram executados em 8 de outubro de 2026. Nenhum deploy, publicação, DNS público, certificado ACME ou alteração de produção foi feito.

## Ambiente e limites

- Windows 11 x64 com Docker Desktop Linux: 16 vCPU e 8,13 GB de RAM informados pelo Docker. Isso não representa a hipótese de VPS 4 vCPU/8 GB nem valida firewall, DNS ou tráfego público.
- Duas instalações sintéticas A/B, MariaDB 11.4, imagem local construída do checkout e Nginx Proxy Manager 2.16.0 restaurado de backup cifrado. Cada instalação recebeu 10.000 fórmulas, 100 clientes sintéticos, um insumo e um item/orçamento por fórmula.
- O NPM foi limitado a endereços loopback nos ensaios. Certificados QA autossinados tinham SAN individual `qa-a.invalid`/`qa-b.invalid`, vencimento em 10/10/2026. Não são certificados públicos.
- O arquivo cifrado foi extraído novamente para `magisform-stage11-restore-fresh-20261008`; SQLite, dados restantes, certificados e fallback TLS foram carregados em volumes NPM QA novos. Os dumps A e B foram importados em MariaDBs novos separados. Marcadores recuperados: A `(A=1, B=0)` e B `(A=0, B=1)`.
- Os bancos ficaram fora das duas redes de entrada do proxy. Os DBs QA restaurados para conferir os dumps ficaram somente na bridge padrão, sem conexão ao NPM; os DBs em execução ficaram apenas nas redes internas `data` de suas instalações. O NPM ficou conectado somente às redes de entrada A/B.

## Verificações e evidências

| Área | Resultado | Limite |
|---|---|---|
| Código e contratos | `npm run lint` passou; `npm test` passou com 6 testes unitários e 17 integrações puladas sem DB; `npm run test:integration` passou com 17/17 em MariaDB descartável; `npm run build:server` passou. | A suíte não equivale à matriz completa de UI, Windows ou produção. |
| Web | `npm run build:web` passou; auditoria aprovou 17 arquivos sem runtime Electron/Node, driver MariaDB ou nomes de variáveis secretas. | Aviso existente de chunk minificado acima de 500 KB. |
| Electron empacotado | `npm run build` gerou pacote Windows x64 MagisForm 0.2.2 sem publicar. O executável abriu e mostrou a tela de login. | O smoke remoto não concluiu: o Electron usou `%APPDATA%\MagisForm` apesar de `APPDATA` apontar para a pasta temporária, ignorou o `config.json` QA temporário e iniciou no modo local sem MariaDB. A tela exibiu “Erro ao acessar o banco de dados”. Não alterei o perfil/configuração real para forçar o teste. O processo atualizou/criou caches Chromium nesse perfil preexistente; não gravou `config.json` nele. Smoke Electron remoto e local com MariaDB continuam pendentes em conta Windows/VM isolada. |
| NPM restaurado | NPM subiu com SQLite, configuração, certificados e dois Proxy Hosts restaurados. Pela porta TLS QA: A health 200, B health 200; HTTP conhecido 301 para HTTPS; host desconhecido 404; Host divergente 404. Reiniciei o NPM restaurado e A/B voltaram a 200. Painel ficou mapeado em `127.0.0.1:38181`. | Autenticação administrativa da interface não foi validada; a restrição de rede foi comprovada pelo bind loopback. Nenhum certificado público/renovação ACME. |
| Isolamento HTTP | Smoke automatizado passou: sem sessão 401; conflito de login único 409; `force` 200 e token anterior 401; token A apresentado em B 401; marcadores A/B corretos nas respectivas listas; host desconhecido e Host divergente 404. | Não substitui navegação completa no browser nem isolamento em VPS. |
| Recuperação | Parar DB B causou health 503; após reiniciar, MariaDB ficou healthy e API voltou a 200. Reiniciar backend A devolveu health 200. Reiniciar o NPM restaurado devolveu A/B a 200. | RTO/RPO não foram cronometrados nesta etapa. Sem simulação de falha física de host ou de perda do destino de backup. |
| Browser e estados de sessão | Rotas web foram atendidas pelo NPM; login, conflito, force e isolamento foram exercitados por HTTP real com MariaDB e TLS QA. Os contratos HTTP/adapter também foram exercitados na suíte de integração. | Navegação visual real, múltiplas abas, aba suspensa/refresh e recuperação de rascunho não foram comprovados nesta etapa. |

## Carga sustentada

O runner consultou a lista completa de fórmulas e `/health/ready` em ciclos de polling de 10 s. Cada perfil durou pelo menos 30 minutos, passando pelo NPM e HTTPS. O p95 do servidor foi extraído dos logs Fastify sanitizados; os 5xx foram contados por status.

| Usuários simultâneos por instalação | Janela UTC | Requisições | p95 backend `GET /formulas` A/B | p95 ponta a ponta `GET /formulas` A/B | 5xx | Conexões MariaDB médias/máximas A/B | CPU/memória de pico observadas |
|---:|---|---:|---:|---:|---:|---:|---|
| 5 | 19:46:38–20:16:46 | 3.280 | 500/354 ms | 577/439 ms | 0% | 6/6 e 6/6 | Apps: 8,54%/318 MiB A; 8,09%/192 MiB B. DBs: 2,99%/123 MiB A; 3,23%/119 MiB B. NPM: 0,56%/101 MiB. |
| 20 | 20:16:58–20:47:07 | 13.120 | 1.175/1.204 ms | 1.404/1.375 ms | 0% | 11/11 e 11/11 | Apps: 17,12%/524 MiB A e 8,69%/486 MiB B; DBs: 11,16%/146 MiB A e 2,92%/147 MiB B. |

O ensaio de 20 usuários **falhou** ao critério de p95 backend ≤1 s para a operação usual de listagem. Não houve 5xx e as conexões ficaram estáveis; a listagem integral de 10.000 fórmulas concentrou a latência. Um smoke inicial de 1 minuto registrou p95 ponta a ponta de 3,37 s durante aquecimento/coleta, portanto não foi usado como resultado sustentado.

A carga foi somente leitura após a preparação das fixtures; os testes de integração cobriram operações HTTP/DB e sessão concorrente. Não há prova de latência de mutação sob carga nesta etapa. A série de memória do runner foi resumida para máximos e não arquivou cada amostra; margem e ausência de crescimento contínuo ficam parcialmente evidenciadas, não comprovadas por série temporal exportável.

## Automação adicionada

- `deploy/qa/stage11-fixtures.mjs`: prepara dois bancos sintéticos com 10.000 fórmulas, itens, orçamentos, clientes e contas de carga.
- `deploy/qa/stage11-load.mjs`: perfis sustentados de 5/20 usuários, polling, p95 ponta a ponta, 5xx, CPU, memória e conexões.
- `deploy/qa/stage11-server-metrics.mjs`: extrai p95/5xx do tempo de resposta do backend a partir de logs sem payload.
- `deploy/qa/stage11-smoke.mjs`: rotas HTTPS, 301/404, login, conflito/force, revogação e token cruzado.
- `deploy/qa/stage11-electron-proxy.mjs` e `stage11-electron-smoke.mjs`: ponte local e tentativa automatizada de login CDP para o pacote Windows. O smoke termina como pendência ambiental descrita acima.

## Pendências e decisão

- **Não liberar versão candidata.** O p95 de fórmula excedeu 1 s a 20 usuários por instalação e o Electron empacotado não foi validado remotamente em perfil isolado. Browser visual completo e mutações sob carga também não foram comprovados.
- A latência exige avaliação de capacidade/paginação. Como paginação muda o contrato aprovado, não alterei endpoint, schema ou comportamento de lista nesta etapa. Abrir etapa adicional de capacidade/contrato antes de repetir o gate; manter 10.000 fórmulas na fixture.
- Repetir browser em origem HTTPS com certificado confiável, abas/reload/aba suspensa, testes de timeout de mutação e janela real do Electron local/remoto em Windows isolado. Validar painel NPM autenticado com credencial QA controlada.
- DNS, VPS/firewall, ACME público, job/alerta diário de backup e medição RPO/RTO permanecem pendentes de ambiente autorizado.

Nenhuma alteração de regra ou contrato foi necessária ou feita. Nenhuma release foi publicada. O checkout já continha extensas mudanças locais anteriores; foram preservadas.

Ao concluir, removi somente os containers e redes criados com nomes QA da etapa 11 e encerrei a ponte local do Electron. Mantive volumes nomeados da etapa 11 e artefatos sintéticos em `%TEMP%` para auditoria/repetição; nenhum volume das instalações de farmácias foi usado ou removido.
