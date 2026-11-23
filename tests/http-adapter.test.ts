import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWebResources, httpBusinessAdapter as db } from '../src/services/httpAdapter';
import { fixtureOrder } from './fixtures/contracts';

const fetchMock = vi.fn();
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('adapter web com cookie e CSRF', () => {
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('window', new EventTarget()); clearWebResources(); fetchMock.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  it('envia proposta com revisão e notifica alterações após sucesso', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ success: true }));
    const changed = vi.fn(); const cleanup = db.data.onChanged(changed);
    try {
      await db.orders.propose(42, 3, fixtureOrder, 'Revisão');
      const [url, options] = fetchMock.mock.calls[1];
      expect(url).toBe('/api/v1/orders/42/propose');
      expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-qa' } });
      expect(JSON.parse(options.body)).toMatchObject({ revision: 3, data: fixtureOrder, note: 'Revisão' });
      expect(options.headers.Authorization).toBeUndefined();
      expect(changed).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it('não notifica alterações quando o servidor rejeita a decisão', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Pedido atualizado' } }), { status: 409 }));
    const changed = vi.fn(); const cleanup = db.data.onChanged(changed);
    try { await expect(db.orders.transition(42, 'approve', 2)).rejects.toMatchObject({ status: 409 }); expect(changed).not.toHaveBeenCalled(); }
    finally { cleanup(); }
  });

  it('renova o escopo ao entrar e restaura o usuário por cookie', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ user: { id: 1, role: 'manager' } })).mockResolvedValueOnce(ok({ authenticated: true, user: { id: 1, role: 'manager' } }));
    const changed = vi.fn(); const cleanup = db.auth.onSessionChanged(changed);
    try {
      expect(await db.auth.login(false, { username: 'qa', password: 'senha' })).toEqual({ success: true, user: { id: 1, role: 'manager' } });
      expect(changed).toHaveBeenCalledOnce();
      expect((await db.auth.current()).success).toBe(true);
      expect(fetchMock.mock.calls[2][1].credentials).toBe('same-origin');
    } finally { cleanup(); }
  });

  it('distingue expiração de sessão de indisponibilidade', async () => {
    const expired = vi.fn(); const cleanup = db.auth.onExpired(expired);
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAVAILABLE' } }), { status: 503 }));
      await expect(db.orders.list()).rejects.toMatchObject({ status: 503 }); expect(expired).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }));
      await expect(db.orders.list()).rejects.toMatchObject({ status: 401 }); expect(expired).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it('envia credenciais de reautenticação para excluir insumo', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ success: true }));
    await db.insumos.remove(7, { username: 'admin', password: 'senha' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/insumos/7');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ username: 'admin', password: 'senha' });
  });
});
