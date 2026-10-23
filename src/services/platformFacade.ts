import type { PublicConfigDto } from '../../shared/contracts';

/** Integrações disponíveis no navegador. */
export const platform = {
  brand: {
    publicConfig: async (): Promise<PublicConfigDto | null> => {
      const pathname = typeof window !== 'undefined' ? window.location?.pathname ?? '' : '';
      const match = pathname.match(/^\/t\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\/|$)/);
      const prefix = match ? `/t/${match[1]}/api/v1` : '/api/v1';
      const response = await fetch(`${prefix}/public-config`, { credentials: 'same-origin' });
      return response.ok ? (await response.json()).data : null;
    },
  },
  dialogs: {
    openWhatsApp: async (url: string) => {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) throw new Error('O navegador bloqueou a abertura do link.');
    },
  },
};
