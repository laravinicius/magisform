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
- `tools/`: conversão das capturas, preparação de marca e verificações de arquivos.

## Contato comercial

O destino definido é `5541991942228`, correspondente a **(41) 99194-2228**. Edite `assets/js/config.js` para trocar número ou mensagens. O número deve conter somente dígitos, incluindo `55` e DDD. O clique abre o WhatsApp em outra aba; o visitante decide se envia a mensagem.

Sem uma configuração válida, os links levam à seção de contato e aparece “Canal comercial em configuração”. Sem JavaScript, o conteúdo, a navegação e o FAQ continuam disponíveis; existe um link direto de contato na seção final. Se trocar o número, atualize também esse único fallback dentro de `<noscript>` no HTML.

## Conteúdo e imagens

As imagens são capturas da versão anterior do MagisForm. A seção “O MagisForm na rotina da sua farmácia” mostra o fluxo daquela versão, com visão geral, pedido e orçamento, produção e retirada, pagamentos, clientes e histórico. A ampliação abre a tela completa, exceto o detalhe do pagamento. O [mapa de módulos](../docs/modules.md) descreve o fluxo atual de pedidos.

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

Os PNGs originais ficam em `assets/images/sources/`. O conversor gera as prévias responsivas em WebP e AVIF, as ampliações em WebP e atualiza as dimensões das imagens no HTML. Para reconverter os PNGs existentes, instale as dependências do repositório e execute na raiz:

```powershell
node website/tools/render-assets.cjs --previews-only
```

A geração de logos continua separada e exige fontTools/Pillow. Sem `--previews-only`, o conversor também gera favicons e a imagem de compartilhamento.

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
