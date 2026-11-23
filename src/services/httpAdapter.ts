import type { BusinessOperations, ErrorEnvelopeDto, OperationResultDto, OrderDataDto, OrderDto, PartnerPharmacyDto, PartnerPatientDto } from '../../shared/contracts';
import type { DataActivity } from './lanDatabase';
type LoginResultDto = OperationResultDto;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
let csrfToken: string | null = null;
let currentSessionRequest: Promise<LoginResultDto> | null = null;
let sessionGeneration = 0;
const sessionListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
const changedEvent = () => { for (const listener of changeListeners) listener(); };
function apiUrl(path: string): string {
  const pathname = typeof window !== 'undefined' ? window.location?.pathname ?? '' : '';
  const match = pathname.match(/^\/t\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\/|$)/);
  const prefix = match ? `/t/${match[1]}/api/v1` : '/api/v1';
  return `${prefix}${path}`;
}
export const getWebSessionGeneration = () => sessionGeneration;
export const subscribeWebSession = (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); };
export const clearWebResources = () => { sessionGeneration++; csrfToken = null; currentSessionRequest = null; for (const listener of sessionListeners) listener(); };

export class HttpApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'HttpApiError'; }
}

async function request<T>(path: string, method: Method = 'GET', body?: unknown, activity: 'user' | 'passive' = 'passive', allow401 = false): Promise<T> {
  const headers: Record<string, string> = { 'X-Magisform-Activity': activity };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    if (!csrfToken) {
      const bootstrap = await fetch(apiUrl('/auth/csrf'), { credentials: 'same-origin' });
      if (!bootstrap.ok) throw new HttpApiError(bootstrap.status, 'UNAVAILABLE', 'Não foi possível preparar a sessão segura.');
      csrfToken = (await bootstrap.json() as { data: { csrfToken: string } }).data.csrfToken;
    }
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(apiUrl(path), { method, credentials: 'same-origin', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await response.json().catch(() => ({})) as { data?: T; error?: ErrorEnvelopeDto['error'] };
  if (!response.ok) {
    const error = new HttpApiError(response.status, envelope.error?.code ?? 'UNAVAILABLE', envelope.error?.message ?? 'Falha ao comunicar com o servidor.');
    if (response.status === 401 && !allow401) window.dispatchEvent(new Event('magisform:session-expired'));
    throw error;
  }
  return envelope.data as T;
}

const result = async (promise: Promise<OperationResultDto>) => {
  const response = await promise;
  if (response.success) changedEvent();
  return response;
};
const idPath = (base: string, id: number) => `${base}/${encodeURIComponent(id)}`;

export const httpBusinessAdapter = {
  auth: {
    async login(force = false, credentials?: { username: string; password: string }): Promise<LoginResultDto> {
      try {
        const response = await request<{ user: LoginResultDto['user'] }>('/auth/login', 'POST', { force, ...credentials });
        clearWebResources();
        return { success: true, user: response.user };
      } catch (error) {
        if (error instanceof HttpApiError && error.code === 'SESSION_CONFLICT') return { success: false, conflict: true, error: error.message };
        if (error instanceof HttpApiError && error.status === 401) return { success: false, error: error.message };
        throw error;
      }
    },
    async logout(): Promise<OperationResultDto> {
      try { await request('/auth/logout', 'POST', {}, 'user'); }
      finally { clearWebResources(); }
      return { success: true };
    },
    async heartbeat(): Promise<{ valid: boolean }> {
      try { return await request('/auth/heartbeat', 'POST', {}, 'passive'); }
      catch (error) { if (error instanceof HttpApiError && error.status === 401) return { valid: false }; throw error; }
    },
    current(): Promise<LoginResultDto> {
      currentSessionRequest ??= (async () => {
        try { const response = await request<{ authenticated: boolean; user: LoginResultDto['user'] }>('/auth/me', 'GET', undefined, 'passive', true); return { success: response.authenticated, user: response.user }; }
        catch (error) { if (error instanceof HttpApiError && error.status === 401) return { success: false }; throw error; }
      })();
      return currentSessionRequest;
    },
    onExpired(listener: () => void) { window.addEventListener('magisform:session-expired', listener); return () => window.removeEventListener('magisform:session-expired', listener); },
    onSessionChanged: subscribeWebSession,
    sessionGeneration: getWebSessionGeneration,
  },
  partners: {
    list: (activity: DataActivity = 'user') => request<PartnerPharmacyDto[]>('/partners', 'GET', undefined, activity),
    add: (name: string) => result(request('/partners', 'POST', { name }, 'user')),
    addUser: (id: number, input: { name: string; username: string; password: string }) => result(request(`${idPath('/partners', id)}/users`, 'POST', input, 'user')),
    updateUser: (id: number, input: { active?: boolean; password?: string }) => result(request(idPath('/partner-users', id), 'PATCH', input, 'user')),
  },
  orders: {
    list: (activity: DataActivity = 'user') => request<OrderDto[]>('/orders', 'GET', undefined, activity),
    get: (id: number, activity: DataActivity = 'user') => request<OrderDto>(idPath('/orders', id), 'GET', undefined, activity),
    patients: (activity: DataActivity = 'user') => request<PartnerPatientDto[]>('/order-patients', 'GET', undefined, activity),
    insumos: (activity: DataActivity = 'user') => request<Array<{ id: number; name: string }>>('/order-insumos', 'GET', undefined, activity),
    add: (input: OrderDataDto) => result(request('/orders', 'POST', input, 'user')),
    transition: (id: number, action: 'review' | 'accept' | 'approve' | 'reject', revision: number, note?: string) => result(request(`${idPath('/orders', id)}/${action}`, 'POST', { revision, note }, 'user')),
    propose: (id: number, revision: number, input: OrderDataDto, note?: string) => result(request(`${idPath('/orders', id)}/propose`, 'POST', { revision, data: input, note }, 'user')),
  },
  users: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['users']['list']>>>('/users', 'GET', undefined, activity),
    add: (input: Parameters<BusinessOperations['users']['add']>[0]) => result(request('/users', 'POST', input, 'user')),
    update: (id: number, input: Parameters<BusinessOperations['users']['update']>[1]) => result(request(idPath('/users', id), 'PATCH', input, 'user')),
    remove: (id: number, credentials: { username: string; password: string }) => result(request(idPath('/users', id), 'DELETE', credentials, 'user')),
  },
  insumos: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['insumos']['list']>>>('/insumos', 'GET', undefined, activity),
    add: (name: string) => result(request('/insumos', 'POST', name, 'user')),
    update: (id: number, name: string) => result(request(idPath('/insumos', id), 'PATCH', name, 'user')),
    remove: (id: number, credentials: { username: string; password: string }) => result(request(idPath('/insumos', id), 'DELETE', credentials, 'user')),
  },
  logs: { list: (filters?: Parameters<BusinessOperations['logs']['list']>[0], activity: DataActivity = 'user') => { const query = new URLSearchParams(); for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined && value !== '') query.set(key, String(value)); return request<Awaited<ReturnType<BusinessOperations['logs']['list']>>>(`/logs${query.size ? `?${query}` : ''}`, 'GET', undefined, activity); } },
  data: { onChanged: (listener: () => void) => { changeListeners.add(listener); return () => changeListeners.delete(listener); } },
};
