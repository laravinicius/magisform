// ─── Configuração central de marca ────────────────────────────────────────────
// Identidade padrão, compartilhada pelos componentes da aplicação web.
// Sempre importe as cores da marca daqui (e não hex solto nos componentes),
// A configuração pública da instalação aplica a marca do cliente no navegador.

export const BRAND = {
  name: 'MagisForm',
  windowTitle: 'MagisForm - Manipulação',
  caption: 'Manipulação',
};

export const COLORS = {
  primary: '#D95C4F', primaryHover: '#E46D60', onPrimary: '#101814',
  secondary: '#173E35', secondaryHover: '#245347', onSecondary: '#FFFDF8',
  background: '#F4F1E9', surface: '#FFFDF8', surfaceHover: '#F0F3EC',
  ink: '#17201D', muted: '#5F6965', border: '#DCDDD4', controlBorder: '#7B8880',
  sage: '#DCE8E1', sageBorder: '#C4D1C8',
  selectionBg: '#DCE8E1', selectionColor: '#173E35',
  navActive: '#FFFDF8', navActiveBg: '#355D51', navMuted: '#CDDDD3', rowAlt: '#F5F6F0',
  success: '#245D43', successSoft: '#E7F0E7', successStrong: '#D5E5D6', successBorder: '#9BBBA4',
  warning: '#795119', warningSoft: '#F7ECD3', warningStrong: '#F0DDB8', warningBorder: '#B89A61',
  danger: '#A5342D', dangerSoft: '#FAEAE5', dangerStrong: '#F3D4CD', dangerBorder: '#CB8E84',
  info: '#355F68', infoSoft: '#E5EFF0', infoStrong: '#D4E5E7', infoBorder: '#8EAFB5',
  overlay: 'rgba(10, 24, 19, 0.65)',
} as const;

// As variáveis CSS e os estilos React compartilham esta fonte de cores.
export function applyBrandTheme() {
  for (const [name, value] of Object.entries(COLORS)) {
    const cssName = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    document.documentElement.style.setProperty(`--mf-${cssName}`, value);
  }
}

const publicColorKeys = ['primary', 'secondary', 'background', 'surface', 'ink', 'muted'] as const;
export function applyPublicBrand(value: unknown, updateDocumentTitle = true): boolean {
  if (!value || typeof value !== 'object') return false;
  const config = value as { brand?: unknown; brandTheme?: Record<string, unknown> };
  if (typeof config.brand !== 'string' || config.brand.trim().length < 1 || config.brand.trim().length > 80 || !config.brandTheme) return false;
  if (!publicColorKeys.every((key) => typeof config.brandTheme?.[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(config.brandTheme[key] as string))) return false;
  const cssKeys = { primary: 'primary', secondary: 'secondary', background: 'background', surface: 'surface', ink: 'ink', muted: 'muted' } as const;
  for (const key of publicColorKeys) document.documentElement.style.setProperty(`--mf-${cssKeys[key]}`, config.brandTheme[key] as string);
  const shade = (hex: string, factor: number) => {
    const rgb = hex.slice(1).match(/.{2}/g)!.map((part) => Math.round(parseInt(part, 16) * (1 - factor)));
    return `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  };
  const luminance = (hex: string) => hex.slice(1).match(/.{2}/g)!.map((part) => parseInt(part, 16) / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
  const onColor = (hex: string) => luminance(hex) > 0.38 ? '#101814' : '#FFFDF8';
  document.documentElement.style.setProperty('--mf-primary-hover', shade(config.brandTheme.primary as string, 0.08));
  document.documentElement.style.setProperty('--mf-on-primary', onColor(config.brandTheme.primary as string));
  document.documentElement.style.setProperty('--mf-secondary-hover', shade(config.brandTheme.secondary as string, 0.12));
  document.documentElement.style.setProperty('--mf-on-secondary', onColor(config.brandTheme.secondary as string));
  document.documentElement.dataset.publicBrand = config.brand.trim();
  if (updateDocumentTitle) document.title = config.brand.trim();
  return true;
}

export const LOGO = {
  original: {
    src: 'brand/logo-horizontal-green.svg',
    fallback: 'brand/symbol-green.svg',
  },
  white: {
    src: 'brand/logo-horizontal-white.svg',
    fallback: 'brand/symbol-white.svg',
  },
  symbol: {
    original: { src: 'brand/symbol-green.svg', fallback: null },
    white: { src: 'brand/symbol-white.svg', fallback: null },
  },
  // Quando src for null, renderiza o CrossIcon + texto.
  textParts: [
    { text: 'Magis', color: COLORS.secondary },
    { text: 'Form', color: COLORS.secondary },
  ],
};
