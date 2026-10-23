import { useCallback, useEffect, useMemo, useState } from 'react';
import { db, type DataActivity } from '../services/lanDatabase';

interface PerfMetrics { httpDurationMs: number; reloadCount: number; sqlQueryCount: number; recordsReturned: number; concurrentLoads: number; lastError: string | null }
const globalMetrics: PerfMetrics = { httpDurationMs: 0, reloadCount: 0, sqlQueryCount: 0, recordsReturned: 0, concurrentLoads: 0, lastError: null };
let activeLoads = 0;
export function getPerfMetrics(): PerfMetrics { return { ...globalMetrics }; }
export function resetPerfMetrics(): void { Object.assign(globalMetrics, { httpDurationMs: 0, reloadCount: 0, sqlQueryCount: 0, recordsReturned: 0, concurrentLoads: 0, lastError: null }); activeLoads = 0; }

interface Resource<T> { data: T | null; loading: boolean; error: string | null; subscribers: Set<() => void>; inFlight: Promise<T> | null; timer: ReturnType<typeof setTimeout> | null; unlisten: (() => void) | null; failures: number }
const resources = new Map<string, Resource<any>>();
function resource<T>(key: string): Resource<T> {
  let value = resources.get(key) as Resource<T> | undefined;
  if (!value) { value = { data: null, loading: true, error: null, subscribers: new Set(), inFlight: null, timer: null, unlisten: null, failures: 0 }; resources.set(key, value); }
  return value;
}
function notify<T>(entry: Resource<T>) { entry.subscribers.forEach(listener => listener()); }
async function load<T>(entry: Resource<T>, fetcher: (activity: DataActivity) => Promise<T>, silent: boolean, activity: DataActivity): Promise<T | null> {
  if (entry.inFlight) return entry.inFlight;
  if (!silent) { entry.loading = true; notify(entry); }
  activeLoads++;
  const started = performance.now();
  entry.inFlight = (async () => {
    try {
      const data = await fetcher(activity);
      entry.failures = 0;
      globalMetrics.httpDurationMs += performance.now() - started;
      globalMetrics.reloadCount++;
      globalMetrics.lastError = null;
      globalMetrics.recordsReturned += Array.isArray(data) ? data.length : data && typeof data === 'object' ? 1 : 0;
      entry.data = data; entry.error = null; entry.loading = false; notify(entry);
      return data;
    } catch (error) {
      entry.failures = Math.min(entry.failures + 1, 6);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      globalMetrics.lastError = message; entry.error = message; entry.loading = false; notify(entry); throw error;
    } finally { activeLoads--; globalMetrics.concurrentLoads = Math.max(globalMetrics.concurrentLoads, activeLoads); entry.inFlight = null; }
  })();
  return entry.inFlight;
}

/** Cache apenas em memória, identificado por instalação, sessão e chave de recurso. */
export function useData<T>(key: string, fetcher: (activity: DataActivity) => Promise<T>, deps: unknown[] = []) {
  const [, redraw] = useState(0);
  const forceUpdate = useCallback(() => redraw(value => value + 1), []);
  const tenant = window.location.pathname.match(/^\/t\/([^/]+)/)?.[1] ?? 'platform';
  const resourceKey = useMemo(() => `${window.location.origin}:${tenant}:${db.auth.sessionGeneration()}:${key}`, [key, tenant, db.auth.sessionGeneration()]);
  useEffect(() => db.auth.onSessionChanged(forceUpdate), [forceUpdate]);
  useEffect(() => {
    const entry = resource<T>(resourceKey);
    entry.subscribers.add(forceUpdate);
    if (!entry.unlisten) entry.unlisten = db.data.onChanged(() => { void load(entry, fetcher, true, 'passive').catch(() => {}); });
    let disposed = false;
    const schedule = () => {
      if (disposed || document.visibilityState !== 'visible') return;
      const delay = Math.min(60_000 * (2 ** entry.failures), 15 * 60_000);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (document.visibilityState === 'visible') void load(entry, fetcher, true, 'passive').catch(() => {}).finally(schedule);
        else schedule();
      }, delay);
    };
    const onVisibility = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      if (document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!entry.timer) schedule();
    if (!entry.inFlight && entry.data === null && entry.error === null) void load(entry, fetcher, false, 'user').catch(() => {});
    return () => {
      entry.subscribers.delete(forceUpdate);
      if (entry.subscribers.size === 0) {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisibility);
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null; entry.unlisten?.(); entry.unlisten = null;
        if (resources.get(resourceKey) === entry) resources.delete(resourceKey);
      }
    };
  // fetcher identity is intentionally controlled by explicit resource key and deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceKey, forceUpdate]);
  const entry = resources.get(resourceKey) as Resource<T> | undefined;
  const reload = useCallback(async (silent = false) => { const current = resources.get(resourceKey) as Resource<T> | undefined; if (current) await load(current, fetcher, silent, 'user'); }, [resourceKey, ...deps]);
  useEffect(() => { void reload().catch(() => {}); }, [reload]);
  return { data: entry?.data ?? null, loading: entry?.loading ?? true, error: entry?.error ?? null, reload };
}
