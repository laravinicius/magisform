> Registro histórico: a arquitetura desktop descrita neste documento foi superada pela aplicação exclusivamente web. Consulte `docs/architecture.md` para o fluxo vigente. Resultados de QA históricos não validam a versão atual.

# Etapa 10 — Infraestrutura, deploy, backup e recuperação

**Escopo:** somente etapa 10 após a 09. Nenhum contrato, DNS, publicação, emissão/renovação pública de certificados ou alteração em produção foi feito. Mudanças pré-existentes das etapas 00–09 foram preservadas.

## Entregue

- `Dockerfile` multi-stage: Node 22.14.0 Alpine fixado, build do frontend/API, dependências por lockfile, runtime sem Electron/build tools, usuário `node`, healthcheck e sem `.env`, secrets ou dados de instalação. `.dockerignore` limita o contexto.
- `deploy/infrastructure/compose.yaml`: Nginx Proxy Manager 2.16.0 em Compose separado, com SQLite/configuração e certificados em volumes próprios, portas públicas 80/443, painel 81 somente em `127.0.0.1`, limites de CPU/RAM, rotação de logs e resposta TLS 404 de descarte para SNI desconhecido.
- Cada instalação ganha rede de entrada exclusiva com CIDR /24 sem sobreposição, alias `mf-<id>:3001` e trust proxy restrito ao CIDR. MariaDB não entra nessa rede; app e banco compartilham somente `data` interna. O NPM é conectado individualmente às redes de entrada.
- Host canônico literal e protocolo HTTPS são verificados no backend em produção. IP/CIDR do proxy é validado; não se confia em qualquer remetente, quantidade de hops ou valor arbitrário de cabeçalho. Logs da aplicação omitem query, cabeçalhos, corpo, stack e segredos; logs access do Nginx ficam desabilitados em cada Proxy Host.
- Runbooks cobrem Proxy Host por alias/porta, frontend/API na mesma origem, certificado individual, Force SSL, host desconhecido com 404, painel por túnel SSH, preflight, deploy unitário, rollback, backup/restore, retenção, RPO/RTO, custos e auditoria.
- `deploy/ops/backup.mjs`: snapshot online consistente do SQLite NPM, configuração, certificados/fallback TLS, dumps transacionais MariaDB por instalação, manifesto e cifragem age no destino externo. `restore-qa.mjs` descriptografa em diretório inexistente, valida path traversal e extrai para QA.
- `deploy/ops/deploy-tenant.mjs`: preflight por digest e schema; apply de apenas uma instalação, condicionado a backup/restore verificados, sem upgrade DDL automático.

## Evidência local e QA

| Verificação | Resultado | Limite |
|---|---|---|
| `npm run lint`, build Docker e `git diff --check` | Aprovados | Build Vite ainda emite aviso de chunk >500 KB |
| Compose de infraestrutura e `nginx -t` | Válidos; configuração Nginx aprovada | Execução em máquina local, não VPS |
| Dois tenants sintéticos em sub-redes de entrada separadas | A/B em redes exclusivas; bancos aparecem apenas em `data` interna | Não representa topologia/firewall do host de produção |
| NPM: HTTP conhecido → 301 HTTPS; frontend/API same-origin | A/B responderam HTTP 301, HTML 200 e `/api/v1/health/ready` 200 em HTTPS | Certificados autossinados de QA |
| Hosts não cadastrados | HTTP e HTTPS retornaram 404; TLS default completou handshake com certificado de descarte | DNS público não consultado |
| Host, protocolo e origem de proxy | Testes de integração passaram: CIDR confiável, IP não confiável, Host errado, protocolo encaminhado errado e health local | Não substitui teste de borda pública |
| Backup e restore | Pacote age restaurado; SQLite/configuração/certificados carregaram em NPM QA novo. Dumps A/B importados em MariaDBs novos e marcadores sintéticos `QA_STAGE10_RESTORE_A/B` recuperados | Sem escrita concorrente; restauração ensaiada em ambiente local |
| RTO observado | Aproximadamente 4 min da extração bem-sucedida até NPM e APIs A/B prontos | Medição de uma execução sintética, sem pull de imagem ou limitações do host remoto |
| RPO observado | Os marcadores do snapshot mais recente foram recuperados; zero linha sintética ausente nesse ensaio | Idade do arquivo no restore foi de poucos segundos. RPO operacional de 24 h depende de job diário monitorado e ainda não está comprovado |
| Auditoria de segredos | `.env`/secrets ignorados pelo Git; imagem não contém `.env`, `.git` ou diretório `secrets`; build bundle passou auditoria de conteúdo; chave privada age ficou fora do repo e backups foram cifrados | Não examina host ou operador externo |

O build de produção da imagem usa dependências runtime sem vulnerabilidades reportadas no audit da imagem; a árvore de desenvolvimento do estágio de build reportou 21 avisos no audit npm (5 moderados, 13 altos, 3 críticos). Isso não foi resolvido neste escopo.

## Gate

**QA local aprovado para encerrar a etapa 10 de implementação.** A infraestrutura está preparada e o restore por farmácia foi ensaiado. A ativação pública permanece pendente de VPS/firewall e DNS autorizados, certificados públicos individuais, configuração do job diário/alertas e repetição do restore no host escolhido. Nenhum certificado público ou renovação ACME foi alegado. Etapa 11 e ações externas não foram iniciadas.

## Rollback

Os containers, volumes e redes de QA foram removidos depois do ensaio. Os dois diretórios de instalação sintética permanecem ignorados pelo Git porque a revisão automática bloqueou a remoção dos arquivos locais; contêm apenas credenciais aleatórias de QA, sem vínculo com farmácias reais. A chave age e os backups de QA permanecem na pasta temporária local `magisform-stage10-qa` pela mesma razão. Nenhuma instalação real foi alterada. Para deploy futuro, volte apenas para imagem compatível com o schema; se o schema tiver avançado sem compatibilidade, restaure em volume novo, confira dados/IDs e só então direcione o Proxy Host. Não use `down -v` em farmácia real.
