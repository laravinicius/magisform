# Provisionamento por instalação

Cada farmácia usa o mesmo digest da imagem MagisForm e recebe seu próprio projeto Compose, banco, volume, rede de entrada, segredo MariaDB e diretório operacional. O catálogo local em `deploy/tenants/catalog.json` guarda apenas identificador, host, alias, digest e caminho do Compose. O diretório `deploy/tenants/` é ignorado pelo Git por conter segredos.

## Preparar e aplicar

A imagem informada deve ser uma imagem de release que contenha `dist-web`, `dist-server`, `database.sql`, `database/upgrades/`, `scripts/database-schema.mjs`, `scripts/tenant-initial-admin.mjs`, `node_modules` de runtime e o entrypoint `node dist-server/server/index.js`. A construção dessa imagem é parte da etapa 10. Use referência por digest para que todas as farmácias recebam os mesmos bytes.

```sh
npm run tenant:provision -- farmacia-alfa farmacia-alfa.exemplo.com --image ghcr.io/organizacao/magisform@sha256:<64-hex> --brand "Farmácia Alfa" --primary '#D95C4F' --secondary '#173E35'
```

O modo padrão cria a estrutura, credenciais aleatórias do banco e instruções locais, sem iniciar containers. Revise o manifesto e então aplique explicitamente:

```sh
npm run tenant:provision -- farmacia-alfa farmacia-alfa.exemplo.com --image ghcr.io/organizacao/magisform@sha256:<64-hex> --brand "Farmácia Alfa" --primary '#D95C4F' --secondary '#173E35' --apply
```

`--brand` e as seis cores (`--primary`, `--secondary`, `--background`, `--surface`, `--ink`, `--muted`) são opcionais; os padrões são a marca MagisForm. O validador aceita somente nome simples com até 80 caracteres e cores `#RRGGBB`. O apply cria a rede se ela ainda não existir (e recusa rede com mesmo nome que não tenha o rótulo desta instalação), inicia apenas o MariaDB, espera health, executa preflight e bootstrap somente se o schema estiver vazio, cria o primeiro administrador por hash Argon2id e inicia a aplicação. A senha inicial é gerada por CSPRNG e guardada em `deploy/tenants/<id>/secrets/initial-admin.txt`; o terminal mostra apenas caminho/estado. Distribua-a ao responsável por canal seguro e remova-a após confirmar o primeiro acesso. A rotina é retomável no mesmo ID/host/imagem/marca e preserva volume e segredos; divergência exige revisão manual, sem sobrescrever.

Não execute `docker compose down -v` para rollback: `down` mantém o volume, `down -v` o apaga. Para parar somente uma instalação, use `docker compose -p magisform-<id> down` no diretório dela e preserve o volume `<projeto>_mariadb_data`.

## Compose e isolamento

`deploy/tenant-template/compose.yaml` não publica portas. O serviço `app` conecta à rede interna `data` com o MariaDB e à rede externa exclusiva `npm-<id>`, anunciando somente o alias `mf-<id>`. O banco participa apenas da rede `data`, configurada como `internal: true`. O Proxy Host não deve usar IP/porta publicados nem conectar o proxy à rede `data`.

As senhas root e da aplicação são arquivos Docker secrets em `secrets/`, com permissões POSIX 0600 ou ACL Windows restrita à conta executora e SYSTEM. MariaDB recebe `MARIADB_*_FILE`; a aplicação lê `MAGISFORM_SERVER_DB_PASSWORD_FILE`. Nenhuma credencial faz parte da imagem ou do comando/argumentos de processo.

## Nginx Proxy Manager — configuração manual

O NPM não possui API administrativa usada por este procedimento. Na primeira configuração e após recriar o container do NPM, conecte-o à rede dedicada da instalação, por exemplo:

```sh
docker network connect npm-farmacia-alfa <container-npm>
```

No painel do NPM, crie **Hosts → Proxy Hosts → Add Proxy Host**:

- Domain Names: `farmacia-alfa.exemplo.com`
- Scheme: `http`
- Forward Hostname / IP: `mf-farmacia-alfa`
- Forward Port: `3001`
- Websockets Support: habilitado
- Block Common Exploits: habilitado
- Aba SSL: selecione/crie certificado para esse domínio e habilite Force SSL; habilite HTTP/2 conforme a instalação

Salve esses dados no registro operacional e no arquivo `NPM-Proxy-Host.md` do cliente. A rede é exclusiva; o alias é válido somente dentro dela. Após alterações no Compose do NPM, confira `docker network inspect npm-farmacia-alfa` e recrie apenas o vínculo de rede, se necessário. TLS público, DNS e implantação em VPS são etapas externas posteriores.

## Limites desta etapa

A execução do apply depende de Docker, rede autorizada e imagem produzida na etapa 10. Não cria painel/cadastro global, não consulta API do NPM, não altera DNS ou publica instalação. A marca servida pelo endpoint público é texto escapado pelo React e seis cores hexadecimais validadas no servidor; não aceita HTML, script, CSS livre, fonte externa ou URL de asset. Logos permanecem os assets locais aprovados. O navegador recebe somente o tema e a identificação pública da própria instalação.
