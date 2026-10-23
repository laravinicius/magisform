# Operação do piloto Cloudflare

Este procedimento é um checklist para a etapa remota. Ele não significa que a conta esteja configurada ou que a aplicação esteja publicada. Faça a publicação somente com dados fictícios e depois do aceite local.

## Preparação e proteção

1. Confirme no dashboard a conta de destino, que Workers, D1 e Zero Trust permanecem no plano gratuito, o subdomínio `workers.dev` e a disponibilidade de autenticação por código de e-mail.
2. Crie a aplicação Access para o Worker/hostname de produção, abrangendo painel, SPA e API. Mantenha previews desligados e crie política `allow` apenas para os e-mails operacionais aprovados. Não use regra por domínio inteiro.
3. Confirme que uma identidade fora da allowlist recebe bloqueio antes de carregar a aplicação e que cada requisição aceita pelo Worker contém JWT Access válido. A proteção pode ser habilitada no Worker ou por aplicação de hostname; não deixe rota alternativa desprotegida.
4. Gere a audiência real da aplicação Access e configure `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` localmente no Wrangler sem registrar valores secretos no Git.
5. Crie somente o D1 `magisform-piloto` e o Worker `magisform-piloto`. Previews continuam desativados.

## Primeiro administrador da plataforma

O primeiro administrador não é criado por endpoint público nem por senha padrão. Com Access ativo e audiência validada, insira no D1 o convite de curta duração por comando operacional explícito. A forma SQL, executada no destino correto e após revisar o e-mail, é:

```sql
INSERT INTO platform_admin_invites(id, email, expires_at)
VALUES (<ID_INTEIRO_UNICO>, '<EMAIL_AUTORIZADO>', datetime('now', '+1 day'));
```

Use um ID positivo único dentro do limite inteiro seguro da aplicação. Depois de aceitar o convite, o vínculo é por emissor e subject Access; alterar o e-mail não transfere a identidade. Revogue convites não utilizados atualizando `revoked_at`.

## Banco, publicação e conferência

1. Revise o nome/ID do banco e o ambiente no comando antes de aplicar qualquer migration remota; faça preflight e registre a versão/checksum.
2. Aplique `wrangler d1 migrations apply magisform-piloto --remote` somente após identificar a conta e confirmar que é o banco do piloto. Não importe dump MariaDB.
3. Gere o build e dry-run local, confirme zero placeholders em configuração, depois publique o Worker.
4. Confirme `workers.dev` protegido em todas as rotas de produção e previews desativados antes de cadastrar dados fictícios.
5. Teste código por e-mail, entrada em `/`, `/management/`, criação e suspensão de farmácia, e fórmulas em duas farmácias. Registre erros, CPU, linhas lidas/escritas D1 e usuários concorrentes. Pare o piloto se as cotas se aproximarem do limite.

## Suspensão, contingência e recuperação

- **Bloqueio emergencial:** suspenda a farmácia pelo painel global para revogar sessões daquele tenant. Para incidente que afete toda a aplicação, desative temporariamente a política/rota do Worker no dashboard mantendo evidência do estado anterior.
- **Allowlist:** alterações são feitas no Zero Trust Access, não pela aplicação. Use e-mails individuais e valide com uma identidade autorizada e outra não autorizada após qualquer mudança.
- **Backup:** antes de migrations, exporte o D1 e guarde o arquivo em armazenamento controlado fora do repositório; confirme tamanho e leitura do arquivo. Faça exportação periódica conforme volume e retenção aprovados.
- **Recuperação D1:** restaure o backup em banco separado para verificar integridade e versionamento antes de qualquer substituição. Não execute restore sobre o banco ativo sem janela e validação operacional explícitas.
- **Rollback de código:** reverta para a versão anterior do Worker pelo histórico de deployments. Isso não desfaz alterações de schema ou dados. Migrations são somente aditivas/compatíveis durante a janela de rollback; restauração do banco é procedimento separado.

Não registrar JWTs, tokens, códigos de e-mail ou dados de pacientes em logs, tickets ou artefatos de CI.
