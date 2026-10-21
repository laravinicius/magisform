# MagisForm — website comercial

Landing page estática em português para apresentar o sistema web a farmácias de manipulação. HTML, CSS e JavaScript sem etapa de build. Este projeto funciona independentemente da aplicação web.

## Abrir localmente

Na raiz do repositório, execute:

```powershell
python -m http.server 5174 --bind 127.0.0.1 --directory website
```

Abra http://127.0.0.1:5174/. O servidor fica acessível somente neste computador. Também é possível usar outro servidor de arquivos estáticos apontado para esta pasta.

## Organização

- `index.html`: conteúdo, SEO, FAQ nativo e estrutura acessível.
- `assets/css/style.css`: paleta, fontes, responsividade e movimento reduzido.
- `assets/js/config.js`: número comercial e mensagens do WhatsApp.
- `assets/js/main.js`: links comerciais, menu móvel e galeria em diálogo nativo.
- `assets/brand/`: logo A aprovada, variantes vetoriais e favicons.
- `assets/fonts/`: fontes locais, originais e licenças SIL OFL.
- `assets/images/`: capturas do aplicativo em WebP/AVIF e imagem de compartilhamento.
- `brand/`: briefing, três conceitos, apresentação final e guia de identidade.
- `tools/`: geração opcional das imagens, preparação de marca e verificações de arquivos.

## Contato comercial

O destino definido é `5541991942228`, correspondente a **(41) 99194-2228**. Edite `assets/js/config.js` para trocar número ou mensagens. O número deve conter somente dígitos, incluindo `55` e DDD. O clique abre o WhatsApp em outra aba; o visitante decide se envia a mensagem.

Sem uma configuração válida, os links levam à seção de contato e aparece “Canal comercial em configuração”. Sem JavaScript, o conteúdo, a navegação e o FAQ continuam disponíveis; existe um link direto de contato na seção final. Se trocar o número, atualize também esse único fallback dentro de `<noscript>` no HTML.

## Conteúdo e imagens

As imagens são capturas do renderer atual do MagisForm, com os mesmos componentes React, fontes, menus e estilos do aplicativo. A seção “O MagisForm na rotina da sua farmácia” explica seis áreas: visão geral, pedido e orçamento, produção e retirada, pagamentos, clientes e histórico com repetição de pedidos. Os recortes destacam detalhes da própria interface; a ampliação abre a tela completa, exceto o detalhe específico do pagamento.

Os dados são exclusivamente fictícios: clientes de exemplo, telefones sem uso, insumos genéricos e pedidos de demonstração. O exemplo de pagamento mostra um orçamento de R$ 180,00, R$ 72,00 recebidos e R$ 108,00 restantes. Os valores não são estatísticas comerciais. As imagens mostram o renderer em um navegador isolado; não representam capturas de uma instalação ligada ao banco da operação.

No celular, a imagem ampliada pode ser deslizada horizontalmente para facilitar a leitura. A legenda identifica a origem: “Telas do MagisForm com dados fictícios para demonstração.”

O site apresenta o produto como sistema web acessado pelo navegador com uma instalação Docker isolada para cada cliente. A contratação é sob consulta. Não há preços, depoimentos ou serviços de implantação/suporte prometidos.

As fontes Vollkorn e Atkinson Hyperlegible Next vieram do repositório oficial Google Fonts. Os arquivos WOFF são derivados sem alteração do desenho; as licenças ficam ao lado dos arquivos. Nenhuma fonte ou imagem é carregada de terceiros durante a visita.

## Verificação

Na raiz do repositório:

```powershell
node --check website/assets/js/config.js
node --check website/assets/js/main.js
python website/tools/verify-site.py
git diff --check
```

Inspecione também o navegador em 375, 768, 1024 e 1440 px. Verifique menu, âncoras, FAQ com teclado, abertura/fechamento das prévias, Escape, foco restaurado e links de WhatsApp. O diálogo nativo possui tratamento explícito de Tab e Shift+Tab para manter o foco dentro da prévia enquanto ela está aberta. A folha CSS respeita `prefers-reduced-motion` e nenhum conteúdo depende de animação.

As ferramentas de geração são opcionais e não são necessárias para servir o site. Para atualizar as capturas após mudanças na interface, instale as dependências do repositório e tenha Python, Node.js/npx e Google Chrome disponíveis. Execute na raiz:

```powershell
python website/tools/create-previews.py
```

O comando inicia um Vite separado em `127.0.0.1:5175`, com fixtures HTTP locais e captura o renderer via Playwright CLI. O servidor só fornece dados fictícios e bloqueia operações não previstas; o navegador bloqueia requisições externas. Não há conexão com MariaDB, leitura da configuração da operação, atualização do aplicativo ou envio de mensagens. A data do navegador fica em 06/10/2026 para manter os exemplos reproduzíveis. O processo fecha sua sessão de captura e o servidor ao terminar. A porta 5175 precisa estar livre.

O npx obtém `@playwright/cli` se necessário, sem adicioná-lo às dependências do projeto. Os PNGs originais ficam em `assets/images/sources/`. `render-assets.cjs` converte essas capturas para WebP e AVIF em 960 e 1600 px e atualiza no HTML as dimensões reservadas. Para apenas reconverter os PNGs existentes:

```powershell
node website/tools/render-assets.cjs --previews-only
```

As ilustrações antigas não são mais fontes das telas. A geração de logos continua separada e exige fontTools/Pillow. Sem `--previews-only`, o renderizador também gera favicons e a imagem de compartilhamento.

Para repetir a verificação de navegação e responsividade com o servidor estático na porta 5174:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=magisform-site open --browser=chrome
npx --yes --package @playwright/cli playwright-cli -s=magisform-site run-code --filename=website/tools/check-site.js
npx --yes --package @playwright/cli playwright-cli -s=magisform-site close
```

Essa verificação cobre imagens, proporções, ausência de transbordamento em 375/768/1024/1440 px, menu móvel, FAQ pelo teclado, ampliação, Escape, foco restaurado e destinos comerciais, sem enviar mensagens. As capturas de validação ficam em `output/playwright/magisform-visual/`, ignorado pelo Git. O Playwright CLI também produz arquivos temporários em `.playwright-cli/`; não inclua esses arquivos na publicação ou no versionamento.

## Publicação futura

Ainda não houve publicação. Hospede o HTML e os arquivos em `assets/` em um serviço de arquivos estáticos. Não é necessário publicar `tools/`, `brand/`, os originais TTF ou `assets/images/sources/`.

Quando o domínio for definido, transforme `og:image` e `twitter:image` em URLs HTTPS absolutas da imagem `assets/images/social-card.png`; adicione `canonical` e `og:url` com a URL final. Confirme o número comercial e repita as verificações no endereço publicado. O site não instala cookies, rastreadores ou formulários de coleta.
