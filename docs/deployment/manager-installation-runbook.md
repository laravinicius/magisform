# Runbook — nova implantação do gestor MagisForm

Este procedimento instala o Nginx Proxy Manager (NPM), a API do gestor e o executor em uma VM nova e descreve as duas formas de acesso ao gestor: **local sem DNS público** e **pública com DNS e HTTPS**. Não substitui o gate de capacidade/QA nem autoriza por si só operação com clientes.

## Escolha do modo

| Modo | Uso | Endereço e TLS | Requisitos externos |
|---|---|---|---|
| Local, sem DNS público | QA, avaliação ou acesso administrativo por túnel | `https://<host>.magisform.test:8443`; certificado de teste autossinado | SSH até a VM e entradas locais no arquivo `hosts` do computador |
| Público, com DNS | Gestor acessível pela Internet | `https://gestao.exemplo.com.br`; certificado Let's Encrypt | DNS A para o IPv4 da VM, TCP 80/443 liberados e e-mail válido |

O modo local não publica a porta 8443 na rede da VM e não emite certificado público. No modo público, o NPM mantém a interface administrativa na porta 81 ligada somente a `127.0.0.1`; essa porta não deve ser exposta no firewall.

## 1. Preparar uma VM limpa

Use uma VM Ubuntu Server 24.04 ou 26.04 LTS, arquitetura amd64, com acesso root/sudo, terminal interativo e espaço suficiente para imagens, estado do NPM e backups. Reserve IP estável para o modo público. Sincronize a hora do sistema e confirme acesso de saída aos repositórios do Ubuntu, Docker e GitHub.

Antes de iniciar, decida qual revisão do repositório será instalada. O instalador baixa `main` e registra a revisão em `/srv/magisform-manager/install-manifest.json`. Confirme que essa revisão contém o fix de certificados locais em `manager/npm.ts` (upload multipart em `/nginx/certificates/:id/upload`) e os testes correspondentes. Se a revisão ainda não estiver na branch que o instalador busca, integre o fix primeiro ou prepare explicitamente o servidor para usar a revisão aprovada; não presuma que o checkout local do desenvolvedor será baixado automaticamente.

O instalador existente preserva estado e volumes em uma repetição, mas não deve ser usado como mecanismo de migração entre VMs. Para uma instalação nova, use VM limpa. Para uma VM que já contenha dados, NPM, certificados, clientes ou volumes, faça backup/restauração e um plano de mudança próprios antes de qualquer reinstalação; nunca remova volumes como atalho.

## 2. Preparar DNS e firewall (somente modo público)

1. Escolha o hostname do gestor, por exemplo `gestao.exemplo.com.br`.
2. Crie um registro DNS **A** apontando esse hostname ao IPv4 público estável da VM. Aguarde a propagação e confira de uma rede externa:

   ```sh
   dig +short A gestao.exemplo.com.br
   curl -4 -fsS https://api.ipify.org
   ```

   O IPv4 retornado pelo DNS precisa incluir o IP público da VM. O instalador faz essa validação antes de instalar. Se publicar um registro AAAA, confirme também que IPv6 chega corretamente à VM; remova-o enquanto não houver conectividade IPv6 funcional.
3. Libere TCP 80 e 443 tanto no firewall do provedor quanto no firewall local, se ativo. A porta 80 é necessária para o fluxo HTTP/ACME e redirecionamento; a 443 atende HTTPS.
4. Não libere TCP 81. O Compose fixa a interface administrativa do NPM em `127.0.0.1:81`.

Não é necessário criar DNS público no modo local. Não aponte um hostname de teste para IP público: o acesso ocorrerá pelo túnel SSH e por uma entrada local no computador do operador.

## 3. Executar o instalador

Revise o script de instalação da revisão aprovada e execute-o em terminal interativo como root:

```sh
curl -fsSL https://raw.githubusercontent.com/laravinicius/magisform/main/deploy/install.sh -o /tmp/magisform-install.sh
less /tmp/magisform-install.sh
sudo bash /tmp/magisform-install.sh
```

Escolha uma das opções apresentadas:

### Opção A — teste local sem DNS

1. Escolha `1`.
2. Use o hostname sugerido `gestao.magisform.test` ou outro hostname terminado em `.magisform.test`.
3. Informe um usuário do operador. Guarde a senha e a chave TOTP exibidas no primeiro setup em um cofre seguro.
4. O instalador configura bind local em `127.0.0.1`, portas 8080/8443, cria certificado autossinado de teste e configura o Proxy Host do gestor no NPM.

### Opção B — domínio público com DNS

1. Escolha `2`.
2. Informe o hostname público já apontado por DNS A para o IPv4 da VM.
3. Informe o e-mail válido usado pelo NPM/Let's Encrypt e o usuário do operador.
4. O instalador configura bind em `0.0.0.0`, portas públicas 80/443 e solicita o certificado do gestor. A porta 81 do NPM continua local.
5. Guarde a senha e a chave TOTP exibidas no primeiro setup em um cofre seguro.

O instalador instala Docker Engine/Compose quando necessário, cria os diretórios de estado privados, gera credenciais próprias para o NPM, constrói as imagens localmente e sobe infraestrutura, API e executor. Não publique nem envie credenciais ou arquivos de backup para Git. O arquivo `npm-credentials.json` é segredo; não o cole em chamados, logs ou mensagens.

## 4. Acessar o gestor

### Acesso local sem DNS

No computador do operador, mantenha este túnel aberto:

```sh
ssh -N -L 8443:127.0.0.1:8443 -L 81:127.0.0.1:81 usuario_ssh@IP_DA_VM
```

Adicione ao arquivo `hosts` do computador:

```text
127.0.0.1 gestao.magisform.test
```

Abra `https://gestao.magisform.test:8443`. O navegador avisará que o certificado de teste é autossinado; isso é esperado para esse modo e não significa que houve emissão Let's Encrypt. Para abrir a interface administrativa do NPM, use `http://127.0.0.1:81` enquanto o túnel estiver ativo.

Quando cadastrar uma instalação de teste, adicione também o hostname `.magisform.test` que o gestor apresentar ao arquivo `hosts`, apontando-o para `127.0.0.1`. O túnel do gestor não cria automaticamente entradas locais para os domínios das instalações.

### Acesso público com DNS

Abra `https://gestao.exemplo.com.br` usando o hostname configurado. Não use IP no navegador: o hostname deve corresponder ao certificado e ao Host esperado pela aplicação. Para administrar o NPM, crie um túnel separado para a porta 81:

```sh
ssh -N -L 81:127.0.0.1:81 usuario_ssh@IP_DA_VM
```

Depois acesse `http://127.0.0.1:81`. Não altere o bind do NPM para `0.0.0.0:81`.

## 5. Validar a instalação do gestor

No servidor, confira os serviços e o commit instalado:

```sh
sudo magisform status
sudo cat /srv/magisform-manager/install-manifest.json
docker inspect --format '{{.Name}} {{.State.Health.Status}}' magisform-npm magisform-manager-api-1 magisform-manager-agent-1
docker exec magisform-npm nginx -t
```

Confirme que NPM, API e executor estão saudáveis; que o manifesto identifica a revisão esperada; que `nginx -t` termina com sucesso; e que a porta 81 está ligada apenas a loopback. Não imprima ou compartilhe o conteúdo de `/srv/magisform-manager/secrets/`.

Do computador cliente, valide a resposta HTTPS do gestor. No modo local, execute com o túnel aberto e o mapeamento `hosts` configurado:

```sh
curl -k -i https://gestao.magisform.test:8443/health/live
```

No modo público:

```sh
curl -i https://gestao.exemplo.com.br/health/live
```

Em ambos, confirme HTTP 200 para o healthcheck, acesso à página do gestor, obtenção do token CSRF e carregamento do login. Confirme também que uma listagem administrativa sem sessão recebe 401 e que um hostname desconhecido não é encaminhado a uma instalação. Faça login com senha e TOTP do operador.

## 6. Provisionar e validar a primeira instalação

Faça primeiro em QA com imagem aprovada e dados sintéticos. A criação no gestor chama o fluxo de provisionamento isolado: cada instalação tem projeto Compose, MariaDB, volume, segredos e rede próprios. O NPM é conectado à rede de entrada daquela instalação; o MariaDB não deve participar dela.

Antes de criar:

- No modo público, crie DNS A do hostname da farmácia apontando ao IPv4 público da VM e aguarde propagação. Cada hostname público precisa resolver corretamente antes da solicitação Let's Encrypt.
- No modo local, use hostname terminado em `.magisform.test`; sem DNS público, o computador que fará o teste precisa de entrada `hosts` apontando para `127.0.0.1`, além do túnel HTTPS 8443 da VM.
- Confirme que a imagem indicada está na lista de imagens aprovadas e que existe espaço e CIDR exclusivo disponível para a nova rede.

Crie uma instalação de descarte com identificador e hostname de QA. Aguarde o provisionamento terminar e confira no gestor o estado do app e do MariaDB. No NPM, confirme que o certificado e o Proxy Host correspondem ao hostname criado. Para certificados locais, a correção precisa enviar certificado e chave usando multipart; o cadastro JSON sozinho não garante que os arquivos PEM existam no volume do NPM. Ao reutilizar um certificado existente, confirme os SANs no PEM e mantenha o mesmo ID quando eles cobrirem os nomes solicitados.

Valide o TLS/roteamento no modo público:

```sh
curl -I http://farmacia.exemplo.com.br
curl -i https://farmacia.exemplo.com.br/health/live
docker exec magisform-npm nginx -t
```

Valide no modo local, com túnel e `hosts` preparados:

```sh
curl -k -i https://farmacia-qa.magisform.test:8443/health/live
```

Esperado: HTTP redireciona para HTTPS; health retorna 200; certificado e Proxy Host estão ativos (`nginx_online=true`, `nginx_err=null`); o conteúdo/API atende apenas o Host esperado; Host desconhecido retorna 404. Para inspecionar NPM, abra sua UI pelo túnel. Corrija qualquer falha antes de anunciar a instalação como pronta.

Confirme ainda que app e MariaDB estão saudáveis, que o login inicial da instalação funciona e que o banco da instalação não é acessível pela rede de entrada do NPM. Registre os resultados de cada evidência separadamente; um teste local autossinado não comprova DNS público nem emissão ACME.

## 7. Passar de local para público

Se o gestor começou em modo local e será publicado depois, não altere manualmente `.env`, portas ou certificados. Use o comando operacional:

```sh
sudo magisform configure-domain gestao.exemplo.com.br operador@exemplo.com
```

Antes de executá-lo, crie o DNS A para a VM e libere TCP 80/443. O comando valida DNS, guarda backup do `.env`, troca o bind e as origens, pede certificado ao NPM, recria API/executor e atualiza o manifesto; em falha, tenta restaurar a configuração anterior. Depois repita as validações públicas dos passos 5 e 6. Planeje separadamente os domínios e certificados das instalações já existentes: publicar o gestor não cria os registros DNS dos clientes.

## 8. Backup, recuperação e atualização

Configure backup cifrado fora da VM e faça um ensaio de restauração em ambiente QA separado antes de manter dados reais. Inclua estado/configuração/certificados do NPM, estado do gestor, catálogo e dados de cada instalação. Proteja a chave privada de descriptografia fora do servidor. O backup JSON exportado manualmente pelo NPM pode conter chave privada; trate-o como segredo, restrinja leitura e não o envie ao Git ou a esta documentação.

Antes de atualizar o gestor, fixe a revisão/imagem candidata, valide lint, build e testes unitários; em seguida valide NPM 2.16.0 com uma instalação de QA, inclusive duas retomadas consecutivas, upload PEM, reutilização do ID, estado `nginx_online` e `nginx -t`. Faça backup e restore QA. Atualize apenas após passar esses gates e registre a revisão no manifesto.

Não use `docker compose down -v`, não recrie senha/estado/volumes como tentativa de corrigir TLS e não substitua o checkout ou as imagens de uma instalação existente sem plano de rollback. Se um Proxy Host existente retornar `nginx_online=false`, registre `nginx_err`, valide o caminho dos arquivos PEM dentro do volume NPM, faça backup privado, recupere o certificado por upload e reaplique o Proxy Host via API; só considere recuperado após `nginx_online=true` e `nginx -t` bem-sucedido.

## Limites das evidências

Uma instalação local via túnel comprova apenas esse caminho de QA. DNS público, firewall do provedor, IPv6, Let's Encrypt, acesso externo e comportamento de cada instalação precisam ser verificados no modo público. Healthchecks não comprovam login, provisionamento, isolamento de clientes, backup restaurável ou capacidade. A aprovação de cada gate precisa ser registrada com a evidência real correspondente antes do uso operacional.
