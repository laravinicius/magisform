import { httpBusinessAdapter, clearWebResources } from './httpAdapter';
export type DataActivity = 'user' | 'passive';

/** Acesso de negócio exclusivamente HTTP, com sessão em cookie HttpOnly. */
export const db = {
  ...httpBusinessAdapter,
  auth: {
    ...httpBusinessAdapter.auth,
    invalidateSession: clearWebResources,
  },
};
