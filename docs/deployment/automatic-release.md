# Releases e atualização da instalação independente

O CI valida pushes para `main` e pull requests. Uma tag final, como `v0.2.9`, executa novamente o CI e só cria uma release se todas as verificações passarem. A tag deve apontar para um commit que já esteja em `main`; sua versão deve ser igual à de `package.json` e `package-lock.json`. Mensagem de commit não cria release. Tags de pré-lançamento e versões diferentes dos arquivos são recusadas.

A release contém a imagem Docker web/API e um manifesto com commit e SHA-256. O servidor independente consulta a última release pública, confere o manifesto e o checksum, e instala apenas uma versão maior que a registrada. Ele inicia a imagem candidata separadamente e verifica o preflight do banco, o healthcheck e a prontidão da API antes de trocar o serviço `app`. Após a troca, repete as verificações. Em caso de erro ou interrupção, tenta restaurar a imagem anterior; uma tag que falhou após a troca fica bloqueada para evitar reinícios sucessivos. A rotina não altera nem atualiza o schema.

Este atualizador é para um Compose independente que tenha serviços `app`, `db` e `ingress`, imagem literal na linha `image` do serviço `app`, e proxy na mesma rede do app, como a instalação de demonstração. Ele não atualiza o painel, o executor, o Nginx ou instalações criadas pelo gerenciador. Essas instalações continuam seguindo [operações](operations.md) e seus gates próprios.

## Preparar o servidor

Na demonstração `magisform-demo`, pode-se usar `deploy/ops/backup-demo.py` como executável de backup. Antes de cada troca, ele salva um dump comprimido em `.auto-update/backups/`, restaura esse arquivo em MariaDB descartável sem rede e confere a versão do schema. O executável é limitado ao projeto `magisform-demo`; uma falha bloqueia a atualização. As cópias são locais, não cifradas e não têm retenção automática: acompanhe o espaço em disco. Elas servem apenas para dados de teste e não substituem um backup externo.

Para dados reais, configure backup cifrado em destino externo à VM, restauração em QA e monitoramento conforme [operações](operations.md). Crie um executável local exclusivo para o backup, com caminho absoluto, que execute o backup e só retorne código zero depois de verificar sua restauração em QA. O atualizador executa esse arquivo antes de trocar a imagem. Sem ele, a atualização é recusada. Nunca use um comando que apenas simule sucesso.

1. Configure o executável de backup apropriado ao ambiente. Para instalar o backup de teste, copie `deploy/ops/backup-demo.py` para `.auto-update/backup-validado`, restrinja o arquivo a `0700` e execute-o uma vez no diretório da instalação; confirme a restauração QA antes de ativar o agendamento.
2. Copie `deploy/ops/update-standalone.py` da revisão aprovada para um diretório privado da instalação. O servidor precisa de Python 3, Docker/Compose e acesso HTTPS ao GitHub; não precisa receber conexões SSH do GitHub nem guardar token para este repositório público.
3. Inicialize uma única vez com a versão **efetivamente instalada**. Por exemplo, a partir do diretório da instalação:

   ```sh
   python3 .auto-update/update-standalone.py --dir "$PWD" --initial-version v0.2.8
   ```

   Esse registro é uma referência para comparação; não comprova que a imagem existente veio de uma release. Se o estado já existir ou houver recuperação pendente, a inicialização é recusada.
4. Cadastre a verificação periódica com o usuário que pode executar Docker, substituindo os caminhos absolutos pelo diretório real e pelo executável do backup:

   ```cron
   */10 * * * * test -x /CAMINHO/backup-validado && /usr/bin/python3 /CAMINHO/.auto-update/update-standalone.py --dir /CAMINHO --backup-hook /CAMINHO/backup-validado >> /CAMINHO/.auto-update/update.log 2>&1
   ```

   A entrada espera o executável de backup existir antes de consultar releases. O atualizador não se substitui sozinho; quando o próprio arquivo for alterado, copie a revisão aprovada para o servidor. Monitore o log, a saúde da aplicação e a conclusão dos backups.

## Publicar uma versão

Faça commit das alterações revisadas na `main`. Pushes comuns continuam disponíveis para salvar o trabalho sem criar uma versão final. Quando quiser publicar a próxima versão patch, execute:

```sh
npm run release:patch
```

O comando exige a `main` limpa e atualizada, executa lint, testes, integração e build, incrementa a versão patch nos dois arquivos npm, cria um commit e a tag correspondentes e envia ambos juntos. Por exemplo, de `0.2.8` passa para `v0.2.9`. Ele não faz commit das alterações de trabalho: elas devem ser revisadas e commitadas antes. Se o envio falhar depois da criação da tag, o terminal informa o comando para tentar novamente sem incrementar outra vez.

Confira o workflow **Versão final** no GitHub Actions e, depois, o log do servidor. A release e a instalação são etapas diferentes: uma release criada não comprova que o servidor atualizou. O servidor verifica a cada dez minutos no exemplo acima; falhas de backup, rede, imagem ou compatibilidade impedem a conclusão.

Para uma mudança de schema, siga o procedimento explícito de [banco](../database.md), incluindo backup/restauração e autorização para mudanças destrutivas. O preflight também reconhece schemas antigos; a checagem de prontidão da candidata é que exige compatibilidade com o schema em uso. Após corrigir a causa de uma troca que falhou e confirmar a imagem em execução, remova apenas `.auto-update/failed-tag` para permitir nova tentativa da mesma tag; alternativamente publique uma versão posterior corrigida.
