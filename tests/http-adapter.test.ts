import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWebResources, httpBusinessAdapter as db } from '../src/services/httpAdapter';

const fetchMock = vi.fn();
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('adapter web com cookie e CSRF', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', new EventTarget());
    clearWebResources();
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('confere fórmula por HTTP e notifica os dados sem token no renderer', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ success: true }));
    const changed = vi.fn();
    const cleanup = db.data.onChanged(changed);
    try {
      expect(await db.formulas.verify(42)).toEqual({ success: true });
      const [url, options] = fetchMock.mock.calls[1];
      expect(url).toBe('/api/v1/formulas/42/verification');
      expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-qa' } });
      expect(options.headers.Authorization).toBeUndefined();
      expect(changed).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it('renova o escopo ao entrar e restaura o usuário por cookie', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ user: { id: 1, role: 'manager' } })).mockResolvedValueOnce(ok({ authenticated: true, user: { id: 1, role: 'manager' } }));
    const changed = vi.fn();
    const cleanup = db.auth.onSessionChanged(changed);
    try {
      expect(await db.auth.login('gerente', 'senha-qa')).toEqual({ success: true, user: { id: 1, role: 'manager' } });
      expect(changed).toHaveBeenCalledOnce();
      expect((await db.auth.current()).success).toBe(true);
      expect(fetchMock.mock.calls[2][1].credentials).toBe('same-origin');
    } finally { cleanup(); }
  });

  it('distingue expiração de sessão de indisponibilidade do servidor', async () => {
    const expired = vi.fn();
    const cleanup = db.auth.onExpired(expired);
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAVAILABLE' } }), { status: 503 }));
      await expect(db.customers.list()).rejects.toMatchObject({ status: 503 });
      expect(expired).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }));
      await expect(db.customers.list()).rejects.toMatchObject({ status: 401 });
      expect(expired).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it('exclui modelo pela rota web e invalida recursos ao sair', async () => {
    fetchMock.mockResolvedValueOnce(ok({ csrfToken: 'csrf-qa' })).mockResolvedValueOnce(ok({ success: true })).mockResolvedValueOnce(ok({ success: true }));
    await db.savedFormulas.remove(7, { username: 'admin', password: 'senha-qa' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/saved-formulas/7');
    const generation = db.auth.sessionGeneration();
    await db.auth.logout();
    expect(db.auth.sessionGeneration()).toBe(generation + 1);
  });
});
