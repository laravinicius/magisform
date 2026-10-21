# Operação da camada web (etapa 10)

## Topologia e build

`Dockerfile` compila frontend e API em estágios separados e produz uma única imagem OCI de execução para todas as farmácias. O runtime usa Node 22.14.0 Alpine, usuário `node`, lockfile, healthcheck `/health/live` e contém apenas builds web/API, schema/upgrades e dependências de runtime; Ferramentas de build, `.env`, banco, certificados e segredos ficam fora da imagem. Para releases, publique fora do escopo desta etapa e registre o digest SHA-256; provisionamento aceita somente digest imutável.

```sh
docker build --pull=false -t magisform:qa -f Dockerfile .
docker image inspect magisform:qa --format '{{.Id}} {{.Size}}'
```

A infraestrutura é um projeto separado em `deploy/infrastructure/compose.yaml`. Volumes persistentes próprios: `magisform_npm_data` (SQLite/configuração NPM), `magisform_npm_letsencrypt` (certificados individuais/estado ACME) e `magisform_npm_default_tls` (certificado autossinado de fallback TLS). O snippet `default-https-404.conf` instala um vhost TLS default que completa o handshake e retorna 404 a SNI/Host desconhecidos; não encaminha tráfego. O gerador mantém seu par de chaves somente nesse volume e não é certificado de farmácia. NPM inclui o arquivo somente leitura `http_top.conf`. Restart é `unless-stopped`, limites são 2 CPUs/1 GiB e logs usam driver `local` rotacionado. Portas públicas de serviço: TCP 80 e 443. O painel 81 só vincula `127.0.0.1`.

```sh
docker compose -f deploy/infrastructure/compose.yaml config
docker compose -f deploy/infrastructure/compose.yaml up -d
ssh -L 8181:127.0.0.1:81 operador@servidor
```

Abra `http://127.0.0.1:8181` no cliente com o túnel. Não altere o bind para `0.0.0.0`. DNS A/AAAA, liberação de firewall e instalação em servidor real são externos e dependem de autorização própria.

## Redes e Proxy Hosts

Cada instalação recebe rede dedicada `npm-<id>` com CIDR /24 não sobreposto escolhido pelo provisionador e rotulado `com.magisform.tenant=<id>`. O NPM é conectado individualmente a essa rede (`docker network connect npm-<id> magisform-npm`); o app tem alias `mf-<id>` nessa mesma rede e a confiança Fastify é limitada a esse CIDR. Nenhuma dessas redes contém MariaDB. MariaDB e app compartilham somente a rede `data` interna. Não habilitar `ports` no template de instalação.

Use o formulário manual em [npm-proxy-template.md](../../deploy/infrastructure/npm-proxy-template.md): um Proxy Host por alias autorizado, upstream HTTP `mf-<id>:3001`, um só hostname, websockets, Block Common Exploits, certificado individual e Force SSL. Frontend, assets e `/api/v1` permanecem na mesma origem; não há host de API separado. Registre o certificado que corresponde ao alias. O primeiro rollout não usa wildcard.

Crie no painel um host de descarte QA ou valide a instalação com hosts de produção já cadastrados: Host desconhecido não pode retornar dados de nenhuma farmácia (404). Confirme por HTTPS com o hostname esperado, e teste Host divergente no mesmo SNI. Não crie Proxy Host default apontando para uma instalação. Force SSL só depois do certificado correto estar ativo.

O backend exige Host literal igual ao origin canônico e protocolo efetivo HTTPS em produção. `trustProxy` aceita apenas IP/CIDR e é configurado pelo CIDR /24 exclusivo de cada rede tenant. O NPM deve substituir `X-Forwarded-Host`, `X-Forwarded-Proto` e `X-Forwarded-For` com os valores da conexão recebida. A borda do app não é publicada em host; não adicionar outros containers ou usuários à rede de entrada. Portanto cabeçalho encaminhado enviado diretamente por um cliente externo não pode alcançar o backend, e a origem do cabeçalho é conferida contra a rede confiável. A configuração usa o parser IP do Fastify, não `trustProxy=true` nem confiança por quantidade de saltos.

Logs da aplicação registram `requestId`, instalação, operação (método e rota), status e tipo de erro sem stack/corpo. O serializer descarta query string e cabeçalhos; Pino mascara Authorization/cookies e corpos. Em Advanced de cada Proxy Host, desative access log com `access_log off;` para que query strings não apareçam no log padrão do Nginx. O NPM mantém error logs do container com rotação pelo driver `local`. Não habilite logs de payload nem debug de credenciais.

## Backup cifrado e monitoramento

Execute backup diário em host/volume externo à VPS. A ferramenta `age` usa chave pública de backup; mantenha a privada offline, fora do servidor e fora do Git. Configure retenção 7 diários e 4 semanais no destino criptografado e alerta externo quando o job diário não produzir arquivo. Antes de cada deploy, gere cópia adicional e complete o restore QA antes de confirmar o gate.

```sh
AGE_RECIPIENT='age1...' MAGISFORM_BACKUP_DIR=/mnt/backup/magisform node deploy/ops/backup.mjs
```

O pacote cifrado contém: SQLite do NPM obtido com a API online backup do SQLite (snapshot consistente), restante de `/data`, volume de certificados `/etc/letsencrypt`, certificado de fallback do volume próprio, dumps transacionais MariaDB por instalação com triggers/routines/events e manifesto com IDs, hosts e digests. Dump MariaDB usa `--single-transaction --quick` e lê a senha root do Docker secret por arquivo temporário 0600 dentro do container, apagado ao terminar. Arquivo temporário do host é restrito 0700/0600 e removido em `finally`. Um container Alpine temporário cifra via age com chave pública; nenhuma ferramenta de criptografia é instalada no host. A chave privada permanece offline e senhas de container nunca são impressas.

```sh
AGE_IDENTITY=/caminho/offline/backup.key node deploy/ops/restore-qa.mjs /mnt/backup/magisform-<data>.tar.age /srv/qa-restore/<ensaio-vazio>
```

O restore descriptografa apenas em temp privado, valida nomes contra path traversal e extrai em diretório QA inexistente. A restauração operacional deve criar volumes e projeto Compose novos, copiar `npm-data.tar`, substituir somente `database.sqlite` pelo snapshot online de `npm-snapshot/database.sqlite`, copiar `npm-certificates.tar`, `npm-default-tls.tar` e o `default-https-404.conf` versionado e iniciar um NPM QA com portas alternativas/loopback. Inicie um MariaDB 11.4 QA isolado por SQL, importe cada `<id>.sql` em sua base separada, aplique a mesma imagem imutável por digest e rode `db:preflight`. Nunca monte volumes QA em projeto produtivo. Após validar Proxy Hosts/certificados, Host 404, health e contagem sintética, apague os containers/volumes QA e a pasta descriptografada. Em produção, o painel é acessado apenas via túnel SSH.

RPO inicial é 24 horas, condicionado a job diário realmente monitorado; não inferir disponibilidade do backup pelo plano do scheduler. RTO inicial é alvo de 4 h. Registre datas do último snapshot recuperável e tempos medidos do início da descriptografia até API saudável por instalação; não marque objetivos como cumpridos sem repetição do exercício.

## Deploy por instalação

Execute uma farmácia por vez em janela de manutenção coordenada. Primeiro resolva a referência de imagem imutável e confira `installation.json`, rede, espaço e saúde. Faça backup cifrado e restaure-o em QA. Depois rode:

```sh
node deploy/ops/deploy-tenant.mjs <id> <imagem@sha256:digest-atual> --preflight
```

O comando compara digest ao catálogo atual e executa somente `db:preflight`. Antes do apply, tenha backup pré-deploy verificável e restore QA recente. `--apply` exige a imagem presente localmente, revalida schema e requer `MAGISFORM_DEPLOY_BACKUP=verified`; atualiza apenas serviço app e espera healthcheck. O script não executa upgrade de schema, não reinicia NPM ou bancos e não publica imagens. Alteração de schema requer janela e comando de upgrade explícito aprovado pelo runbook de banco. Repita procedimento separadamente por farmácia; não faça deploy simultâneo.

```sh
MAGISFORM_DEPLOY_BACKUP=verified node deploy/ops/deploy-tenant.mjs <id> <imagem@sha256:digest-atual> --apply
```

## Preflight, rollback e objetivos de serviço

Preflight por instalação: digest e esquema conhecidos, health `db`/`app`, espaço livre e volume correto, certificado válido e individual, backup diário/extra com hash/cifra conferidos, restore QA concluído, rede app/NPM sem MariaDB, e teste Host/origin/TLS/API same-origin. Pausar escritas somente para mudança DDL incompatível; aplicação de imagem compatível é em uma unidade por vez.

Para rollback de imagem, congele novas escritas da instalação, volte o `MAGISFORM_IMAGE` ao digest anterior que seja compatível com o schema e faça `docker compose up -d --no-deps app`; confirme health e smoke. Não use rollback de imagem se upgrade de banco já removeu compatibilidade. Nesse caso, mantenha manutenção, restaure base em volume novo do backup pré-upgrade, confira invariantes/IDs e só então aponte a aplicação para esse volume, aceitando explicitamente que escritas posteriores ao snapshot ficam fora. Nunca usar `down -v`, apagar/reutilizar volume de cliente ou restaurar a farmácia A sobre B.

## Capacidade e custos a cotar

Hipótese inicial do plano: uma VPS 4 vCPU/8 GB para NPM e instalações iniciais, armazenamento externo cifrado, domínio anual, alertas/monitoramento e operação administrativa. Não é sizing aprovado: validar CPU, RAM, DB, armazenamento, tráfego e concorrência na etapa 11. Host único não oferece alta disponibilidade. Contratação, DNS, firewall público, emissão ACME e publicação permanecem fora deste pacote.
