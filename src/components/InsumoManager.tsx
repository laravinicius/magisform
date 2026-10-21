import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle, Trash2, Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../services/lanDatabase';
import { Insumo } from '../types';
import { stripDiacritics } from '../utils/format';
import { useData } from '../hooks/useData';
import { useFormDraft } from '../context/FormDraftContext';
import { LoadingState, ErrorState } from './Feedback';
import { HighlightMatch } from './HighlightMatch';
import { AdminAuthModal } from './AdminAuthModal';
import { ConfirmModal } from './ConfirmModal';

export function InsumoManager({ compact = false, onCreated, initialName }: { compact?: boolean; onCreated?: (m: Insumo) => void; initialName?: string } = {}) {
  const { data: insumos, loading, error, reload } = useData('insumos', activity => db.insumos.list(activity));
  const [name, setName] = useState((initialName ?? '').toUpperCase());
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [rowDraft, setRowDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'create'>('list');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: 'name' | 'created_at'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const { getDraft, saveDraft, removeDraft } = useFormDraft();
  const DRAFT_KEY = 'insumo';
  const isDraftMode = !compact;

  const draftRef = useRef({ name, tab });
  const skipFirstCleanupRef = useRef(true);
  useEffect(() => { draftRef.current = { name, tab }; });

  useEffect(() => {
    if (!isDraftMode) return;
    const draft = getDraft<{ name: string; tab: 'list' | 'create' }>(DRAFT_KEY);
    if (!draft) return;
    if (draft.name) setName(draft.name);
    if (draft.tab) setTab(draft.tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (!isDraftMode) return;
      if (skipFirstCleanupRef.current) { skipFirstCleanupRef.current = false; return; }
      saveDraft(DRAFT_KEY, draftRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraftMode]);

  const reset = () => { setName(''); setFormError(''); setSuccess(null); };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = name.trim().toUpperCase();
    if (!trimmed) return;
    const dup = (insumos as Insumo[])?.find(m => m.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setFormError(`Insumo já cadastrado: ${dup.name}`); return; }
    setSaving(true); setFormError(''); setSuccess(null);
    try {
      setPendingName(trimmed);
      setSaving(false);
      setConfirmOpen(true);
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
    } finally { setSaving(false); }
  };

  const handleCreateConfirm = async () => {
    if (pendingName === null) return;
    setSaving(true); setFormError(''); setSuccess(null);
    try {
      const res: any = await db.insumos.add(pendingName);
      if (res?.success === false) { setFormError(res.error ?? 'Erro ao salvar.'); setPendingName(null); return; }
      if (onCreated) onCreated({ id: res.id, name: pendingName });
      setConfirmOpen(false);
      setPendingName(null);
      removeDraft(DRAFT_KEY);
      reset(); reload();
      setSuccess('Insumo cadastrado com sucesso!');
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
      setPendingName(null);
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    setPendingDeleteId(id);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async (adminCreds?: { username: string; password: string }, token?: string) => {
    if (pendingDeleteId === null) return;
    const res: any = await db.insumos.remove(pendingDeleteId, adminCreds);
    if (!res?.success) { setFormError(res?.error ?? 'Erro ao excluir.'); return; }
    reload();
    setPendingDeleteId(null);
  };

  const handleRowSave = async () => {
    if (editingRow === null) return;
    const trimmed = rowDraft.trim().toUpperCase();
    if (!trimmed) { setFormError('Informe o nome do insumo.'); return; }
    const dup = (insumos as Insumo[])?.find(m => m.id !== editingRow && m.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setFormError(`Insumo já cadastrado: ${dup.name}`); return; }
    setSaving(true); setFormError('');
    try {
      const res: any = await db.insumos.update(editingRow, trimmed);
      if (res?.success === false) { setFormError(res.error ?? 'Erro ao salvar.'); return; }
      setEditingRow(null); setRowDraft('');
      reload();
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
    } finally { setSaving(false); }
  };

  const formBlock = (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 items-end bg-canvas p-4 rounded-xl border border-line">
      {success && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-success bg-success-soft border border-success-line rounded-lg px-3 py-2 w-full">
          <CheckCircle className="w-3.5 h-3.5 shrink-0" /> {success}
        </p>
      )}
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-insumomanager-1" >Nome do Insumo</label>
        <input required className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none" value={name} onChange={e => { setFormError(''); setName(e.target.value.toUpperCase()); }}  id="mf-insumomanager-1" />
        {formError && <p className="text-xs text-danger mt-1">{formError}</p>}
      </div>
      <button type="submit" disabled={saving}  className="ui-button ui-button-primary text-on-coral py-2 px-4 rounded-lg font-medium hover:opacity-90 disabled:opacity-60 transition-all whitespace-nowrap">
        {saving ? '...' : 'Adicionar'}
      </button>
    </form>
  );

  if (compact) {
    return (
      <>
        <div className="flex flex-wrap gap-3 items-end bg-canvas p-4 rounded-xl border border-line">
          {success && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-success bg-success-soft border border-success-line rounded-lg px-3 py-2 w-full">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" /> {success}
            </p>
          )}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-insumomanager-2" >Nome do Insumo</label>
            <input required autoFocus className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none" value={name} onChange={e => { setFormError(''); setName(e.target.value.toUpperCase()); }}  id="mf-insumomanager-2" />
            {formError && <p className="text-xs text-danger mt-1">{formError}</p>}
          </div>
          <button type="button" onClick={() => handleSubmit()} disabled={saving}  className="ui-button ui-button-primary text-on-coral py-2 px-4 rounded-lg font-medium hover:opacity-90 disabled:opacity-60 transition-all whitespace-nowrap">
            {saving ? '...' : 'Adicionar'}
          </button>
        </div>
        <ConfirmModal
          isOpen={confirmOpen}
          onClose={() => { setConfirmOpen(false); setPendingName(null); }}
          onConfirm={handleCreateConfirm}
          title="Criar insumo"
          message="Deseja realmente cadastrar este novo insumo?"
          confirmLabel="Confirmar cadastro"
        />
      </>
    );
  }

  const available = (insumos as Insumo[]) ?? [];
  const q = stripDiacritics(search.trim().toLowerCase());
  const list = available
    .filter(m => {
      if (!q) return true;
      return stripDiacritics((m.name ?? '').toLowerCase()).includes(q);
    })
    .sort((a, b) => {
      if (q) {
        // Ordena por relevância quando há busca: início do nome primeiro;
        // empates por nome (A–Z).
        const score = (m: Insumo) => {
          const name = stripDiacritics((m.name ?? '').toLowerCase());
          if (name.startsWith(q)) return 2;
          if (name.includes(q)) return 1;
          return 0;
        };
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return (a.name ?? '').localeCompare(b.name ?? '');
      }
      const dir = sort.dir === 'desc' ? -1 : 1;
      const av = String(a[sort.key] ?? '').toLowerCase();
      const bv = String(b[sort.key] ?? '').toLowerCase();
      return av.localeCompare(bv) * dir;
    });

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
      <div>
        <h2 className="ui-page-title text-3xl font-medium text-ink">Insumos</h2>
        <p className="text-muted">Gerencie os insumos da farmácia.</p>
      </div>
      <div className="flex items-center gap-4 border-b border-line">
        <button onClick={() => { setTab('list'); }} className={`ui-button pb-4 px-2 text-sm font-medium transition-colors relative ${tab === 'list' ? 'text-brand' : 'text-muted hover:text-ink'}`}>
          Lista de Insumos
          {tab === 'list' && <motion.div layoutId="activeInsumo" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />}
        </button>
        <button onClick={() => setTab('create')} className={`ui-button pb-4 px-2 text-sm font-medium transition-colors relative ${tab === 'create' ? 'text-brand' : 'text-muted hover:text-ink'}`}>
          Cadastro de insumo
          {tab === 'create' && <motion.div layoutId="activeInsumo" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />}
        </button>
      </div>
      <div className="ui-panel bg-surface rounded-2xl border border-line  overflow-hidden">
        {tab === 'create' ? (
          <div className="p-6 space-y-6">{formBlock}</div>
        ) : (
          <div className="p-6 space-y-6">
            {loading && <LoadingState />}
            {error && <ErrorState message={error} onRetry={reload} />}
            {!loading && !error && (
              <div className="space-y-4">
                <div className="flex flex-col md:flex-row md:items-center gap-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
                    <input className="ui-field pl-9 pr-9 py-2 bg-surface border border-control-line rounded-xl focus:ring-2 focus:ring-brand outline-none text-sm w-full"
                      value={search} onChange={e => setSearch(e.target.value)}  aria-label="Buscar insumos" />
                    {search && (
                      <button onClick={() => setSearch('')} title="Limpar busca"
                        className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-danger transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <select value={`${sort.key}:${sort.dir}`}
                    onChange={e => { const [key, dir] = e.target.value.split(':'); setSort({ key: key as any, dir: dir as any }); }}
                    className="ui-field px-3 py-2 rounded-xl border border-control-line text-sm text-muted bg-surface focus:ring-2 focus:ring-brand outline-none" aria-label="Ordenar registros" >
                    <option value="name:asc">Nome (A–Z)</option>
                    <option value="name:desc">Nome (Z–A)</option>
                    <option value="created_at:desc">Cadastro (mais recente)</option>
                    <option value="created_at:asc">Cadastro (mais antigo)</option>
                  </select>
                  <span className="text-xs font-semibold text-muted whitespace-nowrap">
                    {list.length} de {available.length} {available.length === 1 ? 'insumo' : 'insumos'}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="ui-table w-full text-left">
                    <thead><tr className="border-b border-line text-muted text-xs uppercase font-semibold">
                      <th className="px-4 py-3">Nome</th><th className="px-4 py-3">Cadastro</th><th className="px-4 py-3 text-right">Ações</th>
                    </tr></thead>
                    <tbody className="divide-y divide-zinc-50">
                      {list.map(m => (
                        <tr key={m.id} className="hover:bg-canvas transition-colors">
                          <td className="px-4 py-3 font-medium text-ink">
                            {editingRow === m.id ? (
                              <div>
                                <input className="ui-field w-full px-2 py-1 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
                                  value={rowDraft} onChange={e => setRowDraft(e.target.value.toUpperCase())}
                                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRowSave(); } else if (e.key === 'Escape') { setEditingRow(null); setRowDraft(''); setFormError(''); } }}  aria-label="Nome do insumo" />
                                {formError && <p className="text-xs text-danger font-medium mt-1">{formError}</p>}
                              </div>
                            ) : (
                              <HighlightMatch text={m.name} query={search} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted text-sm">{m.created_at ? new Date(m.created_at).toLocaleString('pt-BR') : '—'}</td>
                          <td className="px-4 py-3 text-right space-x-3">
                            {editingRow === m.id ? (
                              <>
                                <button onClick={handleRowSave} disabled={saving} className="ui-button text-muted hover:text-success text-sm font-medium transition-colors disabled:opacity-50">
                                  {saving ? '...' : 'Salvar'}
                                </button>
                                <button onClick={() => { setEditingRow(null); setRowDraft(''); setFormError(''); }} className="ui-button text-muted hover:text-danger text-sm transition-colors">Cancelar</button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => { setRowDraft(m.name); setEditingRow(m.id); setFormError(''); }} className="ui-button text-muted hover:text-info text-sm transition-colors">Editar</button>
                                <button onClick={() => handleDelete(m.id)} className="ui-button ui-icon-button text-muted hover:text-danger transition-colors" aria-label="Excluir" ><Trash2 className="w-4 h-4" /></button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {available.length === 0 && <p className="text-center py-8 text-muted">Nenhum insumo cadastrado.</p>}
                  {available.length > 0 && list.length === 0 && <p className="text-center py-8 text-muted">Nenhum resultado encontrado.</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <AdminAuthModal
        isOpen={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setPendingDeleteId(null); }}
        onConfirm={handleDeleteConfirm}
        title="Excluir insumo"
        message="Esta ação não pode ser desfeita. O insumo será removido permanentemente."
      />
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { setConfirmOpen(false); setPendingName(null); }}
        onConfirm={handleCreateConfirm}
        title="Criar insumo"
        message="Deseja realmente cadastrar este novo insumo?"
        confirmLabel="Confirmar cadastro"
      />
    </motion.div>
  );
}
