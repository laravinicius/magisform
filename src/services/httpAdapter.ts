import type { BusinessOperations, ErrorEnvelopeDto, OperationResultDto, FormulaListQueryDto } from '../../shared/contracts';
import type { DataActivity } from './lanDatabase';
type LoginResultDto = OperationResultDto;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
let csrfToken: string | null = null;
let currentSessionRequest: Promise<LoginResultDto> | null = null;
let sessionGeneration = 0;
const sessionListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
const changedEvent = () => { for (const listener of changeListeners) listener(); };
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
      const bootstrap = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
      if (!bootstrap.ok) throw new HttpApiError(bootstrap.status, 'UNAVAILABLE', 'Não foi possível preparar a sessão segura.');
      csrfToken = (await bootstrap.json() as { data: { csrfToken: string } }).data.csrfToken;
    }
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
    async login(username: string, password: string, force = false): Promise<LoginResultDto> {
      try {
        const response = await request<{ user: LoginResultDto['user'] }>('/auth/login', 'POST', { username, password, force });
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
  users: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['users']['list']>>>('/users', 'GET', undefined, activity),
    add: (input: Parameters<BusinessOperations['users']['add']>[0]) => result(request('/users', 'POST', input, 'user')),
    update: (id: number, input: Parameters<BusinessOperations['users']['update']>[1]) => result(request(idPath('/users', id), 'PATCH', input, 'user')),
    remove: (id: number, credentials?: Parameters<BusinessOperations['users']['remove']>[1]) => result(request(idPath('/users', id), 'DELETE', credentials ?? {}, 'user')),
  },
  customers: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['customers']['list']>>>('/customers', 'GET', undefined, activity),
    add: (input: Parameters<BusinessOperations['customers']['add']>[0]) => result(request('/customers', 'POST', input, 'user')),
    update: (id: number, input: Parameters<BusinessOperations['customers']['update']>[1]) => result(request(idPath('/customers', id), 'PATCH', input, 'user')),
    remove: (id: number, credentials?: Parameters<BusinessOperations['customers']['remove']>[1]) => result(request(idPath('/customers', id), 'DELETE', credentials ?? {}, 'user')),
  },
  insumos: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['insumos']['list']>>>('/insumos', 'GET', undefined, activity),
    add: (name: string) => result(request('/insumos', 'POST', name, 'user')),
    update: (id: number, name: string) => result(request(idPath('/insumos', id), 'PATCH', name, 'user')),
    remove: (id: number, credentials?: Parameters<BusinessOperations['insumos']['remove']>[1]) => result(request(idPath('/insumos', id), 'DELETE', credentials ?? {}, 'user')),
  },
  formulas: {
    list: (filters: FormulaListQueryDto, activity: DataActivity = 'user') => { const query = new URLSearchParams(); query.set('limit', String(filters.limit)); if (filters.cursor) query.set('cursor', filters.cursor); if (filters.statuses?.length) query.set('statuses', filters.statuses.join(',')); if (filters.deliveryStatus) query.set('deliveryStatus', filters.deliveryStatus); if (filters.search) query.set('search', filters.search); return request<Awaited<ReturnType<BusinessOperations['formulas']['list']>>>(`/formulas?${query}`, 'GET', undefined, activity); },
    get: (id: number) => request<Awaited<ReturnType<BusinessOperations['formulas']['get']>>>(idPath('/formulas', id), 'GET'),
    summary: (month: number, year: number, paymentStatus: import('../../shared/contracts').SummaryPaymentStatus = 'pago', activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['formulas']['summary']>>>(`/formulas-summary?month=${month}&year=${year}&paymentStatus=${paymentStatus}`, 'GET', undefined, activity),
    add: (input: Parameters<BusinessOperations['formulas']['add']>[0]) => result(request('/formulas', 'POST', input, 'user')),
    update: (id: number, input: Parameters<BusinessOperations['formulas']['update']>[1]) => result(request(idPath('/formulas', id), 'PATCH', input, 'user')),
    updateStatus: (id: number, status: string) => result(request(`${idPath('/formulas', id)}/status`, 'PATCH', { status }, 'user')),
    updateDeliveryStatus: (id: number, status: string) => result(request(`${idPath('/formulas', id)}/delivery-status`, 'PATCH', { status }, 'user')),
    updatePayment: (id: number, payment: import('../../shared/contracts').FormulaPaymentUpdate) => result(request(`${idPath('/formulas', id)}/payment`, 'PATCH', payment, 'user')),
    verify: (id: number) => result(request(`${idPath('/formulas', id)}/verification`, 'POST', {}, 'user')),
    updateDeliveriesStatus: (ids: number[], status: string) => result(request('/formulas/delivery-status-batch', 'PATCH', { ids, status }, 'user')),
    remove: (id: number, credentials?: Parameters<BusinessOperations['formulas']['remove']>[1]) => result(request(idPath('/formulas', id), 'DELETE', credentials ?? {}, 'user')),
  },
  savedFormulas: {
    list: (activity: DataActivity = 'user') => request<Awaited<ReturnType<BusinessOperations['savedFormulas']['list']>>>('/saved-formulas', 'GET', undefined, activity),
    add: (input: Parameters<BusinessOperations['savedFormulas']['add']>[0]) => result(request('/saved-formulas', 'POST', input, 'user')),
    update: (id: number, input: Parameters<BusinessOperations['savedFormulas']['update']>[1]) => result(request(idPath('/saved-formulas', id), 'PATCH', input, 'user')),
    remove: (id: number, credentials?: Parameters<BusinessOperations['savedFormulas']['remove']>[1]) => result(request(idPath('/saved-formulas', id), 'DELETE', credentials ?? {}, 'user')),
  },
  logs: { list: (filters?: Parameters<BusinessOperations['logs']['list']>[0], activity: DataActivity = 'user') => { const query = new URLSearchParams(); for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined && value !== '') query.set(key, String(value)); return request<Awaited<ReturnType<BusinessOperations['logs']['list']>>>(`/logs${query.size ? `?${query}` : ''}`, 'GET', undefined, activity); } },
  data: { onChanged: (listener: () => void) => { changeListeners.add(listener); return () => changeListeners.delete(listener); } },
};
