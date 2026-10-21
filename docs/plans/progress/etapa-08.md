> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 08 — Electron remoto com preservação do modo local

**Estado:** em andamento; implementação e QA automatizado passaram, mas faltam smoke tests do executável Windows iniciado nos dois modos.

Checkout: branch `main`, HEAD `dfc4e63559d2d8ae6611dca396eccd6735c5f186`. A árvore já tinha mudanças extensas das etapas 00–07 e arquivos não rastreados antes desta etapa. Foram preservados; nenhum commit, publicação ou acesso a banco operacional foi feito.

## Implementação desta etapa

- `config.json` continua no diretório `%APPDATA%/MagisForm`. `connectionMode` agora aceita `local` ou `remote`; ausência do campo e valores desconhecidos resolvem para `local`. Os campos MariaDB antigos continuam carregados. A senha continua omitida na leitura da configuração e uma senha vazia recebida do renderer preserva a senha local salva.
- A tela desktop de conexão permite escolher MariaDB local ou URL remota. A URL é validada no processo principal: exige HTTPS, origem sem credenciais, caminho, query ou fragmento; HTTP só é aceito em loopback quando o app não está empacotado. O teste de conexão usa a configuração digitada sem salvá-la.
- A troca de modo ou de URL remota pede confirmação explícita na tela. O main encerra a sessão atual em melhor esforço, grava a configuração e solicita reinício. O processo atual mantém o modo selecionado no startup até encerrar; o modo seguinte é lido somente ao reiniciar.
- `electron/remoteAdapter.ts` mapeia login, sessão, leituras e mutações IPC para `/api/v1`. O token Bearer fica somente no mapa em memória do processo principal; o renderer recebe apenas o marcador `remote-session` exigido pela facade legada e não recebe o valor Bearer. HTTP autenticado usa timeout e não segue redirecionamentos.
- Conflito de login continua explícito; 401 remoto notifica o renderer para limpar a sessão. Logout e encerramento tentam revogar a sessão remota. As leituras preservam atividade `user`/`passive`, e mutações remotas invalidam os dados carregados nas janelas.
- No modo remoto não é criado pool MariaDB e o limpador local não executa consultas. Não há fallback automático para MariaDB. O modo local continua inicializando o pool existente.
- Preload e adapters continuam tipados. O fluxo de janela, tela cheia, confirmação de saída, updater, `appId`, `productName`, nome do instalador e caminho padrão de dados não foram alterados.

## Validações

- `npm run lint` — passou.
- `npm test` — passou: 6 testes passaram; os 15 testes MariaDB/HTTP foram pulados nesse comando por não haver variáveis do harness.
- `npm run test:integration` — passou em MariaDB 11.4 descartável: **15/15**. Incluiu URL/HTTP remoto, conflito de sessão e prova cruzada de leitura e gravação na mesma base com dois usuários diferentes: Electron remoto (`electron-remote-qa`) criou registro lido pelo browser com cookie; browser (`browser-qa`) gravou registro lido pelo adapter Electron remoto.
- `npm run build:server` — passou antes dos últimos ajustes, que tocaram somente Electron e testes.
- `npm run build:web` — passou; auditoria dos 17 arquivos do `dist-web/` não encontrou runtime Node/Electron, driver MariaDB ou nomes de variáveis secretas. Vite mantém aviso de chunk principal acima de 500 kB.
- `npm run build` — passou para Windows x64, Electron 36.9.5/electron-builder 25.1.8. Gerou `C:\Users\Vinicius\Documents\GitHub\magisform-release\0.2.2\MagisForm-Setup-0.2.2.exe` (93.910.860 bytes). O `app-update.yml` empacotado mantém `owner: laravinicius`, `repo: magisform` e updater `magisform-updater`; `package.json` mantém `com.magisform.app`, `MagisForm` e o nome `MagisForm-Setup-${version}.${ext}`. O instalador não foi executado nem publicado.
- Smoke exploratório do `win-unpacked\MagisForm.exe` — a janela empacotada e a tela de login abriram. A tentativa de apontar um perfil QA por `APPDATA` resultou em erro de conexão MariaDB antes de entrar; essa tentativa não valida modo local. O executável Electron e os serviços QA foram encerrados. O smoke remoto empacotado também não foi executado, pois o endpoint de teste estava em HTTP e o binário empacotado corretamente exige HTTPS. A remoção recursiva dos diretórios QA em `%TEMP%` foi rejeitada pela política local de comandos; os arquivos continuam nos diretórios `magisform-etapa08-playwright`, `magisform-etapa08-local-profile` e `magisform-etapa08-remote-profile`, contendo somente credenciais/fixtures sintéticas.
- `git diff --check` — passou; apenas avisos de normalização LF/CRLF em arquivos preexistentes.

## Gate e pendências

**Gate parcial; etapa ainda não concluída.** O build Windows e os contratos automatizados passaram, mas o critério da etapa exige validar local e remoto no executável instalado no Windows. Também falta observar pela janela real a troca confirmada, reinício, indisponibilidade durante uso, encerramento com revogação e preservação visual/funcional da janela e do updater nos dois modos. A prova compartilhada foi feita pelo adapter Electron em processo de teste e pelo transporte HTTP de sessão web sobre a mesma MariaDB descartável; não equivale a executar o instalador ou a tela do browser nesta etapa. A tela web real e seus fluxos foram cobertos no gate 07.

## Compatibilidade e rollback

- `config.json` antigo sem `connectionMode` continua local por padrão; nenhum campo MariaDB foi removido. O diretório padrão e a identidade de instalação permaneceram iguais.
- Se for necessário retornar de remoto para local, entre com conta privilegiada, selecione MariaDB local, confirme logout/reinício e use a configuração/banco local previamente existente. Não há sincronização nem cópia automática de dados entre as instalações.
- Para rollback de código, desligue a seleção remota e use a versão desktop local compatível com o schema antes de trocar de base. Não restaure ou altere banco operacional como parte do rollback desta etapa.

**Próximo gate:** instalar e executar o pacote Windows com configuração QA isolada em modo local e remoto, observar logout/restart/fechamento e updater, repetir a prova visual com browser e registrar os resultados antes de marcar a etapa concluída.
