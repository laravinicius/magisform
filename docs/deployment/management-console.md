# Console de gestão MagisForm

Para a implantação completa em VM nova, incluindo os caminhos local sem DNS e público com DNS, siga o [runbook de implantação do gestor](manager-installation-runbook.md).

## Instalação automática em Ubuntu 24.04 e 26.04

Em uma VM limpa Ubuntu Server 24.04 ou 26.04 amd64, execute como root ou com `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/laravinicius/magisform/main/deploy/install.sh | sudo bash
```

O instalador instala Docker Engine e Compose, clona a branch `main`, registra o commit e constrói as imagens localmente. Não publica imagens. Ele sobe Nginx Proxy Manager, API do console e executor separado; somente o executor recebe o socket Docker. O banco e a aplicação/API de cada farmácia permanecem em containers, rede, segredos e volume exclusivos. O repositório oficial do Docker publica pacotes para Ubuntu Resolute 26.04 e Noble 24.04.

Escolha teste local ou publicação pública. No teste local, o NPM publica HTTPS somente em loopback na porta 8443, usa hostnames `.magisform.test` e um certificado de teste. Acesse com o túnel exibido pelo instalador e mapeie o hostname para `127.0.0.1` no arquivo `hosts` do computador. Para publicar depois, execute:

```sh
sudo magisform configure-domain gestao.exemplo.com.br operador@exemplo.com
```

O comando valida o DNS A contra o IPv4 público da VM, configura as portas 80/443, solicita o certificado e troca a origem canônica do console. O firewall do provedor precisa permitir TCP 80/443. A porta 81 do NPM permanece ligada a loopback.

No modo público durante a instalação, informe o domínio do console e um e-mail. O DNS precisa apontar para o IPv4 público da VM e as portas 80/443 precisam estar liberadas. O usuário do painel, a senha e o segredo TOTP aparecem apenas no primeiro setup; guarde-os em um cofre. O NPM recebe uma senha aleatória própria, guardada no diretório privado de estado. A repetição do instalador preserva as credenciais e volumes existentes.

O painel configura automaticamente o Proxy Host para cada farmácia. Em produção ele solicita certificado Let's Encrypt individual; no modo local reutiliza o certificado de teste wildcard. O usuário cadastra domínio público por farmácia quando estiver em modo público; no modo local use um hostname terminado em `.magisform.test`.

O comando baixa código mutável da branch `main`; o commit efetivamente instalado fica em `/srv/magisform-manager/install-manifest.json`. Para reproduzir os mesmos bytes em outra VM, fixe manualmente o commit antes da instalação. Esse fluxo não publica nem aprova release. A etapa 11 continua com gate de capacidade pendente e deve ser revalidada antes de uso com clientes.

O console opera instalações de clientes sem compartilhar seus bancos. O serviço `api` serve a interface e a API administrativa; o serviço `agent` executa comandos fechados do Docker. Somente `agent` monta `/var/run/docker.sock` e ele não possui porta publicada. API e executor compartilham uma rede interna protegida por token; o NPM alcança somente a API pela rede `npm-management`.

## Preparação de operador

Escolha um diretório absoluto de estado, fora do repositório e protegido ao usuário operacional. A primeira execução cria uma senha aleatória, um segredo TOTP e um token interno; copie senha e chave TOTP para um cofre/autenticador e faça backup cifrado do diretório.

```sh
MAGISFORM_MANAGER_STATE_DIR=/srv/magisform-manager/secrets npm run manager:setup -- operador
```

O setup não sobrescreve arquivos de operador/token existentes. A senha só é exibida no terminal nessa execução; o segredo TOTP fica em `operator.json` e precisa entrar no backup cifrado. Não publique a saída do comando.

## Implantação isolada

1. Prepare `/srv/magisform-manager` com proprietário UID/GID do usuário `node` da imagem (1000:1000), permissões privadas e espaço para os dados operacionais. `MAGISFORM_MANAGER_ROOT` deve ser um caminho absoluto idêntico no host e dentro do executor: o Docker Engine precisa encontrar nesse mesmo caminho os arquivos de segredo apontados pelos Compose dos clientes.
2. Copie `.env.example` para `.env` fora do Git. Informe os digests SHA-256 aprovados, a origem HTTPS do painel, o CIDR real e exclusivo da rede entre NPM e API, o diretório de estado e o GID do socket Docker. Não use os valores ilustrativos do exemplo.
3. Construa e publique a imagem do console somente após o gate de QA; prenda-a por digest em `MAGISFORM_MANAGER_IMAGE`. Configure DNS/TLS e faça `docker compose --env-file .env -f compose.yaml up -d` na pasta `deploy/manager`.
4. A infraestrutura NPM cria a rede `npm-management`. No painel do NPM, crie manualmente o Proxy Host do domínio `MAGISFORM_MANAGER_ORIGIN` apontando para `api:3003`, com TLS individual, Force SSL e Block Common Exploits. O painel administrativo do próprio NPM segue restrito a loopback/túnel SSH.
5. O primeiro acesso usa senha e TOTP. O console mostra apenas a imagem aprovada pela instalação: em modo automático, uma tag local vinculada ao commit e ao ID imutável da imagem; em operação manual, uma referência `repo@sha256:<digest>`.

O console usa senha Argon2id + TOTP de seis dígitos, Origin/CSRF estritos, cookies seguros em produção, sessões temporárias e rate limit. A API e o NPM nunca recebem o socket Docker. O executor implementa somente consulta do estado de projetos catalogados, provisionamento pelo script aprovado e `start`, `stop` ou `restart`; não aceita comandos, caminhos, nomes de serviço ou imagens arbitrários. Não há remoção de instalação no painel.

## Provisionamento e recuperação

O fluxo automático reusa `scripts/provision-tenant.mjs`, gera banco/segredos exclusivos, aplica bootstrap apenas em banco vazio e cria o administrador inicial. A senha inicial é entregue na resposta de criação uma única vez; o arquivo protegido `secrets/initial-admin.txt` permanece no host para recuperação operacional por acesso local. O executor registra o Proxy Host no NPM e, em modo público, solicita o certificado Let's Encrypt antes de anunciar o endereço no painel.

O botão **Gerar pacote** baixa `compose.yaml`, `.env.example` e instruções sem senhas. O operador completa CIDR e arquivos de segredo no host, valida o preflight e segue o bootstrap operacional antes de subir os serviços.

Para indisponibilidade do executor, use o caminho de provisionamento por CLI documentado em `tenant-installations.md`. Para parar/reiniciar empresas, prefira o painel; a operação equivalente por Compose deve usar o ID/catalogo e nunca apagar volumes. Não use `docker compose down -v`.

Inclua no backup cifrado o catálogo, Compose, `.env`, segredos iniciais, arquivo TOTP/hash/token e auditoria do operador, além dos bancos, estado/certificados do NPM e manifestos. Restaure primeiro em ambiente separado e mantenha a versão do console compatível com os dados recuperados.

## Estado da etapa

O painel e seu executor são preparados em QA. A etapa 11 continua reprovada no gate de capacidade; portanto esta configuração não autoriza publicação do domínio, instalação real, migração ou uso operacional com clientes.
