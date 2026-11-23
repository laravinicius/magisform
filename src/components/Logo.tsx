import React from 'react';
import { BRAND, COLORS, LOGO } from '../../config/branding';

function CrossIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="10" y="2" width="4" height="20" rx="2" fill={COLORS.onSecondary}/>
      <rect x="2" y="10" width="20" height="4" rx="2" fill={COLORS.onSecondary}/>
    </svg>
  );
}

function LogoImage({ sizePx, fillWidth = false, variant }: { sizePx: number; fillWidth?: boolean; variant: 'white' | 'original' }) {
  const [useFallback, setUseFallback] = React.useState(false);
  const asset = fillWidth ? LOGO[variant] : LOGO.symbol;
  const src = useFallback ? asset.fallback : asset.src;

  if (!src) {
    return (
      <div className="flex items-center justify-center shrink-0 rounded-xl"
        style={{ width: sizePx, height: sizePx, background: COLORS.secondary }}>
        <CrossIcon size={Math.round(sizePx * 0.55)} />
      </div>
    );
  }
  return (
    <img src={src} alt={document.documentElement.dataset.publicBrand || BRAND.name}
      className={`object-contain ${fillWidth ? 'w-full h-auto' : 'shrink-0'}`}
      style={fillWidth ? { maxWidth: sizePx } : { width: sizePx, height: sizePx }}
      onError={() => !useFallback && setUseFallback(true)} />
  );
}

export function BrandLogo({ size }: { size: 'icon' | 'lg' | 'sidebar' }) {
  const publicBrand = document.documentElement.dataset.publicBrand;
  const caption = publicBrand && publicBrand !== BRAND.name ? publicBrand : BRAND.caption;
  if (size === 'icon') return <LogoImage sizePx={40} variant="white" />;

  if (size === 'sidebar') {
    return (
      <div className="w-full flex flex-col items-center gap-2">
        <LogoImage sizePx={200} fillWidth variant="white" />
        <span className="text-xs text-nav-muted font-medium tracking-widest uppercase leading-tight">{caption}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <LogoImage sizePx={300} fillWidth variant="original" />
      {caption !== BRAND.caption && <span className="text-sm text-muted font-medium tracking-wide">{caption}</span>}
    </div>
  );
}
