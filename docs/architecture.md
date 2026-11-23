# Arquitetura

MagisForm é exclusivamente web, com React, API Fastify e MariaDB.

```text
Navegador → lanDatabase.ts → httpAdapter.ts → /api/v1 → core/db.ts → MariaDB
Painel web → API do gerenciador → executor → Docker Compose de cada cliente
Nginx Proxy Manager → rede edge exclusiva → app do cliente → rede data interna → MariaDB
```

O backend serve `dist-web` e `/api/v1` na mesma origem. No desenvolvimento, Vite em 3002 encaminha a API para 3001. `npm run build` gera `dist-web`, `dist-manager` e `dist-server`.

O frontend não importa Node, driver MariaDB nem o núcleo de persistência. A fachada usa apenas HTTP. Mutações notificam assinantes do adapter; `useData` faz polling a cada 10 segundos e mantém recursos somente em memória, separados por origem e geração da sessão.

A autenticação usa cookie HttpOnly e CSRF. Sessões são exclusivamente hospedadas. Recursos de janela nativa, instalador, atualização desktop e configuração de banco pelo navegador foram removidos. Dados e configuração operacional ficam no servidor.

O painel e executor mantêm autenticação própria. Somente o executor acessa o socket Docker. Cada cliente tem Compose, banco, volume, segredos e redes exclusivos; o proxy não entra na rede interna do banco.

Bootstrap e upgrade exigem comando explícito; pool, requests e inicialização não executam DDL. A remoção desktop não altera o schema nem checksums históricos.

A apresentação usa `config/branding.ts`, `src/index.css`, fontes locais e vetores aprovados. A marca pública da instalação vem de `/api/v1/public-config`.

Cada instalação MariaDB representa uma manipulação e pode cadastrar várias farmácias solicitantes. Um usuário vinculado a uma farmácia acessa somente as rotas de pedidos, os pacientes da própria farmácia e o catálogo de insumos. O servidor resolve o vínculo a partir da sessão e aplica o filtro em cada leitura e mudança.

O pedido mantém cópias da solicitação original, dos dados atuais e da proposta pendente. Envio, atendimento, aprovação e rejeição registram eventos na mesma transação; a revisão impede decisões sobre dados desatualizados. O aceite do pedido não inicia produção automaticamente. O schema v5 remove as entidades do fluxo anterior e preserva os pedidos e seus históricos.
