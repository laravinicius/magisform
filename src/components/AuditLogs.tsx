import React, { useState } from 'react';
import { RefreshCw, Search, X, ScrollText, ChevronLeft, ChevronRight } from 'lucide-react';
import { db } from '../services/lanDatabase';
import { useData } from '../hooks/useData';
import { LoadingState, ErrorState } from './Feedback';

const ACTION_OPTIONS = [
  { value: 'login', label: 'Login' },
  { value: 'logout', label: 'Logout' },
  { value: 'add', label: 'Adicionar' },
  { value: 'update', label: 'Atualizar' },
  { value: 'delete', label: 'Excluir' },
  { value: 'reviewed', label: 'Iniciar análise' },
  { value: 'accepted', label: 'Aceitar pedido' },
  { value: 'proposed', label: 'Propor alteração' },
  { value: 'approved', label: 'Aprovar alteração' },
  { value: 'rejected', label: 'Rejeitar alteração' },
];

const ENTITY_OPTIONS = [
  { value: 'users', label: 'Usuários' },
  { value: 'insumos', label: 'Insumos' },
  { value: 'orders', label: 'Pedidos' },
  { value: 'partner_pharmacies', label: 'Farmácias' },
  { value: 'partner_memberships', label: 'Acessos de farmácias' },
  { value: 'system', label: 'Sistema' },
];

const PAGE_SIZE = 50;

const actionLabel = (a: string) => ACTION_OPTIONS.find(o => o.value === a)?.label ?? a;
const entityLabel = (e: string) => ENTITY_OPTIONS.find(o => o.value === e)?.label ?? e;

function actionBadge(action: string) {
  const color = {
    login: 'bg-success-soft text-success',
    logout: 'bg-row-alt text-muted',
    add: 'bg-danger-soft text-danger',
    update: 'bg-info-soft text-info',
    delete: 'bg-danger-soft text-danger',
    update_status: 'bg-info-soft text-info',
    update_delivery_status: 'bg-info-soft text-info',
  }[action] ?? 'bg-row-alt text-muted';
  return color;
}

const formatLogDate = (ts: string) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const date = d.toLocaleDateString('pt-BR');
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};

export function AuditLogs() {
  const { data: users } = useData('users', activity => db.users.list(activity));
  const [filters, setFilters] = useState<{
    userId?: number | '';
    action?: string;
    entity?: string;
    from?: string;
    to?: string;
    search?: string;
    page: number;
  }>({ userId: '', action: '', entity: '', from: '', to: '', search: '', page: 1 });

  const payload = {
    userId: filters.userId === '' ? undefined : Number(filters.userId),
    action: filters.action || undefined,
    entity: filters.entity || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    search: filters.search || undefined,
    page: filters.page,
    pageSize: PAGE_SIZE,
  };

  const { data, loading, error, reload } = useData(`logs:${JSON.stringify(payload)}`, activity => db.logs.list(payload, activity));

  const set = (patch: Partial<typeof filters>) => setFilters(f => ({ ...f, ...patch, page: 1 }));
  const resetFilters = () => setFilters({ userId: '', action: '', entity: '', from: '', to: '', search: '', page: 1 });

  const rows: any[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="ui-panel bg-surface rounded-2xl  border border-line overflow-hidden">
      <div className="p-8 border-b border-line flex items-start justify-between gap-4">
        <div>
          <h2 className="ui-page-title text-2xl font-medium text-ink flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-danger" /> Logs de atividades
          </h2>
          <p className="text-muted">Histórico completo das ações realizadas pelos usuários.</p>
        </div>
        <button onClick={() => reload()} className="ui-button inline-flex items-center gap-2 border border-control-line text-ink font-semibold px-4 py-2 rounded-lg hover:bg-canvas transition-colors text-sm">
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
      </div>

      {/* Filtros */}
      <div className="p-6 border-b border-line grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 bg-canvas/50">
        <div className="lg:col-span-2 col-span-2">
          <label className="block text-xs font-semibold text-muted uppercase mb-1">Busca</label>
          <div className="relative">
            <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filters.search}
              onChange={e => set({ search: e.target.value })}
              placeholder="Usuário ou detalhe da ação..."
              className="ui-field w-full pl-9 pr-8 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface"
             aria-label="Busca nos logs" />
            {filters.search && (
              <button onClick={() => set({ search: '' })} className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink" aria-label="Fechar" >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-auditlogs-1" >Usuário</label>
          <select value={filters.userId} onChange={e => set({ userId: e.target.value ? Number(e.target.value) : '' })}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface" id="mf-auditlogs-1" >
            <option value="">Todos</option>
            {((users as any[]) ?? []).map(u => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
            <option value={0}>Sem usuário vinculado</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-auditlogs-2" >Ação</label>
          <select value={filters.action} onChange={e => set({ action: e.target.value })}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface" id="mf-auditlogs-2" >
            <option value="">Todas</option>
            {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-auditlogs-3" >Entidade</label>
          <select value={filters.entity} onChange={e => set({ entity: e.target.value })}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface" id="mf-auditlogs-3" >
            <option value="">Todas</option>
            {ENTITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-auditlogs-4" >De</label>
          <input type="date" value={filters.from} onChange={e => set({ from: e.target.value })}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface"  id="mf-auditlogs-4" />
        </div>

        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-auditlogs-5" >Até</label>
          <input type="date" value={filters.to} onChange={e => set({ to: e.target.value })}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm bg-surface"  id="mf-auditlogs-5" />
        </div>

        <div className="col-span-2 lg:col-span-6 flex items-center justify-between">
          <span className="text-xs text-muted font-medium">{total.toLocaleString('pt-BR')} registro(s) encontrados</span>
          <button onClick={resetFilters}
            className="ui-button inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-danger transition-colors">
            <X className="w-3.5 h-3.5" /> Limpar filtros
          </button>
        </div>
      </div>

      {/* Tabela */}
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && (
        <div className="overflow-x-auto">
          <table className="ui-table w-full text-left">
            <thead>
              <tr className="border-b border-line bg-canvas text-muted text-xs uppercase font-semibold">
                <th className="px-6 py-3">Data e hora</th>
                <th className="px-6 py-3">Usuário</th>
                <th className="px-6 py-3">Ação</th>
                <th className="px-6 py-3">Entidade</th>
                <th className="px-6 py-3">Detalhes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 bg-surface">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-canvas transition-colors">
                  <td className="px-6 py-3 text-sm text-muted whitespace-nowrap">{formatLogDate(r.created_at)}</td>
                  <td className="px-6 py-3 text-sm font-medium text-ink">{r.user_name || '—'}</td>
                  <td className="px-6 py-3">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${actionBadge(r.action)}`}>{actionLabel(r.action)}</span>
                  </td>
                  <td className="px-6 py-3 text-sm text-muted">{entityLabel(r.entity)}</td>
                  <td className="px-6 py-3 text-sm text-muted">{r.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="text-center py-10 text-muted">Nenhum registro encontrado com os filtros atuais.</p>
          )}
        </div>
      )}

      {/* Paginação */}
      {!loading && !error && total > 0 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-line">
          <button
            onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
            disabled={filters.page <= 1}
            className="ui-button inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <ChevronLeft className="w-4 h-4" /> Anterior
          </button>
          <span className="text-sm text-muted">Página {filters.page} de {totalPages}</span>
          <button
            onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
            disabled={filters.page >= totalPages}
            className="ui-button inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            Próxima <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
