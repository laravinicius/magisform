# Autenticação e autorização

## Sessão web

`AuthContext` mantém somente o usuário em memória. O servidor recebe o cookie HttpOnly, valida a sessão em `Db.withSessionContext()` e associa o ator à operação. Identidade e autorização nunca são estabelecidas por payload do navegador.

## Senhas e sessão

Senhas novas usam Argon2id com 19 MiB, 2 iterações e paralelismo 1. Hashes SHA-256 legados são verificados com comparação de tempo constante e atualizados após autenticação válida, inclusive na reautenticação administrativa. Hashes nunca entram nos DTOs de usuário.

Somente a política `hosted` é criada e aceita. Prazos ocioso e absoluto vêm de `server/config.ts`, preservando a configuração da instalação (padrões atuais: 8h e 24h). O frontend mantém encerramento por inatividade em 5 minutos. Leituras/mutações com `X-Magisform-Activity: user` renovam inatividade; polling, `/auth/me` e heartbeat passivos não renovam.

Há uma sessão por usuário. Login concorrente serializa na linha do usuário; sem `force`, retorna conflito. Login forçado revoga e audita a sessão anterior na mesma transação. Logout revoga e audita. Sessões antigas de política diferente são rejeitadas e removidas pela limpeza periódica. O enum histórico do banco não foi alterado.

## HTTP hospedado

O servidor Fastify expõe a API versionada em `/api/v1`. Web usa o cookie host-only `__Host-magisform_session` (HttpOnly, Secure, Path=/, SameSite=Lax, sem Domain) e token CSRF com validação de Origin canônico em operações mutantes. Desenvolvimento usa nomes distintos de cookie e só deve escutar em loopback. A API aceita somente cookies de sessão. `Authorization` retorna HTTP 400 e a antiga rota de login desktop retorna 404.

Tokens são aleatórios e o MariaDB armazena somente SHA-256 do token. Não há autenticação Bearer na API dos clientes. O servidor não habilita CORS; production exige origin HTTPS e Host canônico. `MAGISFORM_SERVER_TRUST_PROXY` aceita apenas uma lista explícita de IPs confiáveis; vazio não confia em headers encaminhados. O rate limit de login é por IP e nome da conta no processo da instalação.

O servidor não oferece endpoints de setup, bootstrap ou acesso ao MariaDB. `/health/live` verifica o processo; `/health/ready` verifica conexão e versão de schema sem devolver detalhes. A configuração pública tem somente nome, marca, versão e capacidades aprovadas.

No browser, a facade faz requests de mesma origem com `credentials: 'same-origin'`. O cookie de sessão nunca é lido por JavaScript; o token CSRF fica somente em memória e é enviado no header das mutações. Antes de mostrar conteúdo protegido, a aplicação restaura o usuário por `/auth/me`. Uma resposta 401 em rota autenticada limpa recursos e rascunhos em memória e retorna ao login; falha de rede/503 mantém a sessão apresentada e não é tratada como senha inválida. Login concorrente preserva o conflito explícito e o usuário pode confirmar o login forçado.

As leituras iniciadas por navegação enviam `X-Magisform-Activity: user`; polling de 10 segundos, `/auth/me` e heartbeat usam `passive` e não renovam indefinidamente a validade por inatividade. As chaves de `useData` incluem origem, sessão e recurso. Logout, novo login e sessão revogada trocam esse escopo e descartam os recursos antigos. O cache e os rascunhos continuam somente em memória do renderer.

## Perfis e permissões

Roles: `employee`, `pharmacist`, `manager` e `admin`. Todas as operações de negócio exigem sessão. Leituras de pacientes/clientes, insumos e fórmulas aceitam qualquer usuário autenticado. Administração de usuários, auditoria e modelos salvos é restrita a `admin`, `manager` e `pharmacist`. As demais ações preservam a matriz da etapa 00. Verificação de fórmula é exclusiva do perfil `manager`, sem equivalência para os outros perfis privilegiados.

Operações de exclusão/alteração administrativa mantêm a reautenticação de credenciais já existente e usam como ator o usuário da sessão HTTP validada. Autoexclusão e remoção/rebaixamento do último acesso administrativo utilizável são bloqueados.

## Navegador e provisionamento

A aplicação restaura a sessão por cookie após recarregar. O logout mantém confirmação e o fechamento da aba usa `beforeunload` quando há rascunho alterado. Links de WhatsApp abrem nova aba com `noopener,noreferrer`.

Não existe modo especial de setup, configuração de conexão ou instalação de atualizações no navegador. O administrador inicial é criado pelo provisionamento explícito; o painel gerencia as instalações Docker.

A atualização de pagamento no histórico exige sessão autenticada, com os mesmos perfis das mutações de fórmulas. O ator vem do contexto HTTP validado; o payload não estabelece identidade. Regra de negócio de pagamento usa erros explícitos 400/404/409, sem expor erros internos do MariaDB.
