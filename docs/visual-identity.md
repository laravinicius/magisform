# Identidade visual do aplicativo

O aplicativo segue a identidade aprovada em `website/brand/GUIDE.md`, adaptada para formulários e listas de trabalho. A organização das telas, os campos e os fluxos permanecem os mesmos.

## Cores e fontes

`config/branding.ts` é a fonte de cores. `applyBrandTheme()`, chamado antes da montagem do React, disponibiliza variáveis `--mf-*` ao CSS. A configuração pública da instalação, recebida pela API, aplica a marca e as cores no navegador por `applyPublicBrand()`.

| Papel | Cor |
|---|---|
| Navegação e ações secundárias | `#173E35` |
| Fundo | `#F4F1E9` |
| Superfícies | `#FFFDF8` |
| Ações principais | `#D95C4F`, texto `#101814` |
| Seleção e apoio | `#DCE8E1` |
| Texto principal / secundário | `#17201D` / `#5F6965` |
| Divisórias | `#DCDDD4` |

Sucesso, atenção, erro e informação possuem tokens separados. Seus significados são acompanhados de texto ou ícones. Cores decorativas não devem substituir os estados de pagamento, entrega ou verificação.

Atkinson Hyperlegible Next é a fonte do corpo, controles, navegação e tabelas; Vollkorn é usada nos títulos principais. Os arquivos WOFF e licenças SIL OFL estão em `public/fonts/` e são incluídos no pacote. Não há carregamento de fontes de terceiros.

## Apresentação compartilhada

Os utilitários semânticos Tailwind e os estilos de componentes estão em `src/index.css`: `ui-panel`, `ui-field`, `ui-button`, `ui-button-primary`, `ui-button-secondary`, `ui-icon-button`, `ui-dialog`, `ui-page-title` e `ui-table`.

`DialogSurface` oferece nome acessível pelo título, navegação de Tab restrita ao diálogo e restauração de foco. Os eventos de confirmação e fechamento continuam nos consumidores. A preferência de movimento reduzido é respeitada pelo CSS e por `MotionConfig`.

## Layout e manutenção

- Preserve a escala de fonte de 0,75 a 1,5 e seus controles existentes.
- As colunas das listas de fórmulas usam rolagem horizontal compartilhada pelos cabeçalhos e linhas. Não remova informações para encaixar a listagem na janela.
- A disposição dos formulários usa a largura disponível do conteúdo, incluindo o espaço ocupado pela sidebar.
- Use os vetores aprovados de `public/brand/`, com suas proporções originais. Não aplique sombras ou gradientes ao logo.
- Não sobrescreva classes Tailwind globais nem adicione uma paleta independente por componente.

Esta camada não altera schema, serviços HTTP, permissões ou persistência. A pasta `website` é a referência visual e permanece independente da aplicação web.
