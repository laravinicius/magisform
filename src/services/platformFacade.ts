import type { PublicConfigDto } from '../../shared/contracts';

/** Integrações disponíveis no navegador. */
export const platform = {
  brand: {
    publicConfig: async (): Promise<PublicConfigDto | null> => {
      const response = await fetch('/api/v1/public-config', { credentials: 'same-origin' });
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
