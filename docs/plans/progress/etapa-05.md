> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 05 — Autenticação, autorização e auditoria comuns

**Estado:** implementação e testes automatizados concluídos para o núcleo e Electron local. Gate de implantação em clientes permanece pendente: o artefato foi empacotado para validação, não instalado nem distribuído.

Checkout: branch `main`, HEAD `dfc4e63559d2d8ae6611dca396eccd6735c5f186`. O worktree já tinha alterações e arquivos novos das etapas anteriores quando esta etapa começou; todos foram preservados e não foram commitados.

## Gate da dependência 04

O relatório [etapa-04.md](etapa-04.md) registra bootstrap limpo, upgrade legado, checksum, lock, retomada, repetição, recusa segura e restore em MariaDB isolado. A coluna `users.password` aceita hash codificado e as sessões têm política/expirações, incluindo unicidade por usuário. O mesmo relatório deixa como requisito instalar uma release Electron compatível antes de atualizar banco de cliente; a versão 0.2.2 anterior não entende Argon2id. Nenhum banco operacional foi usado nesta etapa.

## Implementação

- `core/db.ts` centraliza o contexto assíncrono de sessão/ator. Queries do núcleo exigem contexto quando o Electron ativa o enforcement. IPC vincula cada `webContents` à sessão criada naquele login; não confia em token opcional de mutação nem em flags do payload para identificar o usuário. Leituras também passam pelo wrapper autenticado.
- `preload` e facade mantêm os contratos públicos desktop já consumidos pela UI. A adaptação ocorre no main ao associar sessão e transação por janela; isso evita exigir token novo em listagens existentes e preserva compatibilidade dos componentes.
- Hashes novos usam `@node-rs/argon2` com Argon2id, `m=19456`, `t=2`, `p=1`. SHA-256 legado é comparado em tempo constante e refeito para Argon2id no login/reautenticação válidos. Hashes não são devolvidos em DTOs.
- Login bloqueia a linha do usuário dentro de transação, verifica a senha após adquirir o lock e mantém uma sessão ativa por usuário. O caminho `force` revoga a anterior e registra logout forçado e novo login na transação. Logout registra auditoria e remove sessão atomicamente.
- Políticas de sessão: `desktop_local` — 120 s ociosa, absoluto 30 dias; `hosted` — 900 s ociosa, absoluto 12 horas. Heartbeat renova expiração ociosa até o absoluto; leitura de sessão, cleanup e exclusão de sessão vencida respeitam a política. `Db.login` aceita modo hospedado, embora o transporte hospedado ainda não exista nesta etapa.
- A matriz documentada na etapa 00 permanece: leitura operacional exige sessão; usuários, logs, modelos e configuração são privilegiados; exclusões que já pediam credenciais mantêm reautenticação; verificação da fórmula exige role `manager`. O ator da auditoria é derivado do contexto IPC autenticado. Setup continua local ao Electron e vinculado à janela; só configuração e provisionamento de usuário previamente existente ficam disponíveis nesse modo. Logout e fechamento encerram o estado setup e registram auditoria.
- Mutations executadas no contexto autenticado reutilizam a mesma conexão transacional, inclusive operações compostas de clientes, fórmulas e modelos. Mudanças de usuário (incluindo senha/perfil), exclusão de usuário, login/force/logout e suas auditorias também são atômicas. Alteração/exclusão não pode remover o último acesso administrativo nem autoexcluir.
- `@node-rs/argon2` fornece N-API com binário Windows x64 pré-compilado. `vite.config.ts` deixa o binding externo ao bundle main e `package.json` configura o `.node` para sair do `app.asar`.
- `docs/authentication.md` e `docs/database.md` foram atualizados para descrever os contratos implementados e separar os modos ainda futuros.

## Evidências e comandos

- Gate 04 revisado em `docs/plans/progress/etapa-04.md` antes das mudanças. A evidência de MariaDB e restore é a registrada naquele relatório; não repetimos a migração de schema nesta etapa.
- `npm run lint` — passou (`tsc --noEmit`).
- `npm run test:integration` — passou em MariaDB 11 descartável, iniciado e removido pelo harness: **10/10 cenários** (3 contratos de dados existentes e 7 casos novos de autenticação/autorização), cobrindo negação sem efeitos, SHA-256 → Argon2id, política desktop/hospedada, corrida/conflito, `force`, expiração/cleanup, verificação exclusiva de manager, último administrador, reautenticação administrativa e ator real na auditoria.
- `npm test` — passou: 3 testes de contrato; os 10 casos MariaDB foram pulados neste comando porque ele não injeta `MARIADB_HOST` (rodaram separadamente no comando de integração acima). Verificação de fronteira `core/shared` também passou.
- Teste direto do binding Argon2id no Windows Node — hash gerado com prefixo `$argon2id$` e verificação correta.
- `npm run build` — passou para Windows x64 com electron-builder 25.1.8/Electron 36.9.5. Instalador criado em `../magisform-release/0.2.2/MagisForm-Setup-0.2.2.exe` (91.1 MB). Inspeção de `app.asar` confirmou os arquivos de runtime Argon2 e o binário `argon2.win32-x64-msvc.node` (609.280 bytes) em `app.asar.unpacked`.
- `git diff --check` — passou. Permanecem avisos de conversão LF/CRLF em arquivos preexistentes.

## Limitações e compatibilidade

- O instalador foi empacotado e inspecionado, mas não foi executado/instalado; não há smoke visual Electron com MariaDB real nesta etapa. Portanto o gate de empacotamento está comprovado, e o gate de fluxo instalado/login desktop permanece pendente.
- O caminho hospedado está preparado no contrato de sessão do núcleo, sem servidor HTTP/cookie/adapter; validar esse modo pertence às etapas futuras.
- A UI continua guardando token em memória por compatibilidade atual, mas o main usa o vínculo à janela para autorização e autoria. Não foi feita validação por automação de tentativa de IPC com DevTools ou renderer comprometido.
- A versão do pacote permanece `0.2.2`, apenas por ser o número configurado no checkout. O build de QA não é release compatível para atualizar clientes; não distribuir nem executar o upgrade v1 de cliente antes de definir versão/release coordenada e ensaiar backup/restore com ela.
- O build ainda informa o aviso preexistente de chunk do renderer acima de 500 kB. Nenhuma publicação, instalação em cliente ou acesso a banco operacional ocorreu.

## Rollback e pendências

Não executar downgrade de schema ou voltar a um binário sem suporte a Argon2id depois que houver rehash. Em QA, um fixture pode ser recriado. Em cliente, manter versão compatível com hashes codificados ou restaurar backup coordenado segundo o runbook da etapa 04; não reduzir `users.password` nem restaurar dados de produção nesta etapa.

Antes de liberar para cliente: definir versão nova e release Electron compatível, instalar e testar o pacote Windows com fixture MariaDB isolada, terminar a unificação transacional das mutações compostas e manter a atualização de banco em janela com backup/restauração ensaiados. Etapas HTTP/web seguem pendentes.

**Gate da etapa 05:** PASSOU para lint, MariaDB QA de sessão/autorização/rehash/auditoria, N-API Windows e pacote NSIS com binding fora de ASAR. **Pendente para aceite operacional:** execução do app instalado e validação integrada contra Electron/MariaDB; não há autorização ou alvo de cliente nesta etapa.
