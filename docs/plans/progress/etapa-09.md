> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 09 — Instalações independentes e marca por cliente

**Estado:** implementação e verificações automatizadas concluídas no checkout. Gate operacional parcial: a imagem de release imutável pertence à etapa 10; não foi aplicada uma instalação real. A pendência de smoke do Electron empacotado local/remoto da etapa 08 continua aberta.

## Implementado

- API `/api/v1/public-config` fornece marca e tema públicos da instalação. O servidor valida nome (1–80 caracteres) e seis cores `#RRGGBB`; não há suporte para HTML, script, CSS livre, fontes externas ou URLs de assets. Browser carrega e aplica o tema antes de montar o React. Electron remoto consulta a própria origem pelo main/preload IPC antes do shell; token Bearer não é usado nesse endpoint. Electron local mantém marca padrão. Logos vêm dos assets locais aprovados.
- Tema usa padrões MagisForm e variáveis CSS existentes; paleta derivada de texto para controles usa cores de contraste e sombras calculadas a partir dos valores validados. Nome público aparece como título/caption no modo web/remoto.
- `deploy/tenant-template/compose.yaml` define MariaDB 11.4, volume por projeto Compose e aplicação na mesma imagem fornecida por digest. Não publica porta de aplicação ou banco. A aplicação conecta à rede de entrada exclusiva externa e à rede `data`; MariaDB conecta somente à rede `data`, que é interna. Aliases são exclusivos por ID. Senhas do root e app usam Docker secrets montados como arquivos; a aplicação lê `MAGISFORM_SERVER_DB_PASSWORD_FILE`.
- `npm run tenant:provision` valida ID, hostname, digest, marca e paleta; cria diretório privado, secrets CSPRNG, manifesto local, catálogo operacional sem dados de pacientes e instruções NPM por instalação. Recusa conflitos/artefatos preexistentes. A repetição idêntica não troca segredo nem sobrescreve dados. `--apply` cria/verifica a rede rotulada, espera MariaDB saudável, faz preflight e bootstrap só em banco vazio, cria o primeiro admin com Argon2id e inicializa a aplicação. A rotina guarda a senha administrativa em arquivo privado fora do Git e retoma estados preparados/em provisionamento.
- [tenant-installations.md](../../deployment/tenant-installations.md) documenta preparo/apply, redes, volumes/rollback, segredos, alias exclusivo e campos do Proxy Host cadastrado manualmente na UI do NPM. Não usa API administrativa do NPM.
- O modo local/remoto Electron preserva `appId`, `productName`, nome do instalador, diretório de usuário e updater já definidos. Sem cadastro público ou painel global; sem alteração de identidade Electron.

## Evidências

| Modo/superfície | Verificação | Resultado e limite |
|---|---|---|
| Electron local | `npm run lint`, build Windows x64 e configuração local retrocompatível | Compilação/empacotamento verificados. Não foi aberto o executável nem conectada uma MariaDB local nesta etapa; a pendência visual/funcional Windows listada em etapa 08 continua. |
| Electron remoto | Build Windows; integração HTTP do adapter remoto existente; teste da origem/configuração pública | Build e contratos compilam; bearer continua no processo principal. A nova consulta pública via IPC foi compilada, mas não observada numa janela Electron empacotada. A prova remota compartilhada do relatório etapa 08 segue limitada ao adapter de teste. |
| Web | `npm run build:web` + auditoria de bundle e endpoints HTTP em duas instalações MariaDB | Build passou e auditoria aprovou 17 arquivos sem runtime Electron/Node, driver MariaDB ou nomes de variáveis secretas. API/isolamento passou; não foi feito smoke visual de navegador nesta etapa. |
| Isolamento de clientes | `npm run test:integration` em MariaDB descartável 11.4, `tests/tenant-isolation.integration.test.ts` | **16/16** testes de integração passaram. Instalações A/B tinham usuário `admin-compartilhado`, ID de usuário 1, ID de paciente 1, ID de fórmula 1 e orçamento `Q009`. Cada uma autenticou na própria API e recebeu nome/dado distinto; token Bearer de A retornou 401 em B. Endpoint público retornou nomes e paletas distintas. Bancos foram removidos pelo harness. |
| Compose | Provisionamento sintético `qa-stage09` com digest fictício e `docker compose config --format json` | Validado sem iniciar containers: `app.ports=[]`, `db.ports=[]`, app em `data+edge`, db somente em `data`, `data.internal=true`, edge `npm-qa-stage09`, segredo e volume presentes, marca/paleta propagadas. Repetir o mesmo comando informou instalação existente sem alterar segredo. O fixture local foi removido após a verificação. |
| Código/bundles | `npm run lint`; `npm run build:server`; `npm test`; `npm run build:web` | Lint e build do servidor passaram. Teste unitário: 6 passaram; 16 testes que exigem MariaDB foram pulados nesse comando. Build web passou com aviso já conhecido de chunk principal acima de 500 kB. |
| Empacotamento Electron | `npm run build` | Passou: diretório `win-unpacked` e instalador NSIS Windows x64 MagisForm 0.2.2 gerados. Instalador não executado/publicado. Aviso de chunk principal acima de 500 kB. |
| Higiene | `git diff --check` | Passou; avisos de normalização LF/CRLF em arquivos previamente modificados. Alterações locais anteriores das etapas 00–08 foram preservadas. |

## Limites e pendências

- `--apply` não foi usado: não há imagem de produção identificada/construída nesta etapa (imagem Docker é dependência da etapa 10) e nenhuma instalação/conta real foi criada. A preparação sintética foi descartada. DNS, NPM real, TLS e VPS permanecem sem validação.
- O isolamento de dados foi exercitado com dois schemas/bancos e duas APIs no mesmo processo de QA; Compose foi inspecionado estruturalmente, não foram iniciados dois stacks de aplicação. A infraestrutura NPM não foi conectada.
- Gate etapa 09 automatizado concluído; liberação operacional depende de imagem imutável/release com os scripts documentados e de aplicação/Proxy Host em ambiente QA nas etapas 10/11. O estágio 08 ainda exige smoke Windows em ambos os modos.

## Rollback

Pare somente o projeto Compose da farmácia alvo com `docker compose down`, preserve `<projeto>_mariadb_data` e arquivos de configuração/segredo para recuperação. Não use `down -v`. Mudança de marca altera somente a configuração pública daquele servidor e não dados de pacientes. Para código, retorne à imagem anterior compatível com o schema e reaplique apenas após preflight.

