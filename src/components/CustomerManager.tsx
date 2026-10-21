import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle, Trash2, Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../services/lanDatabase';
import { Customer } from '../types';
import { formatPhone, isValidPhone, stripDiacritics } from '../utils/format';
import { useData } from '../hooks/useData';
import { useFormDraft } from '../context/FormDraftContext';
import { LoadingState, ErrorState } from './Feedback';
import { HighlightMatch } from './HighlightMatch';
import { AdminAuthModal } from './AdminAuthModal';
import { ConfirmModal } from './ConfirmModal';

export function CustomerManager({ compact = false, onCreated, initialName }: { compact?: boolean; onCreated?: (c: Customer) => void; initialName?: string } = {}) {
  const { data: customers, loading, error, reload } = useData('customers', activity => db.customers.list(activity));
  const [form, setForm] = useState({ firstName: initialName ?? '', lastName: '', phone: '' });
  const [isDependent, setIsDependent] = useState(false);
  const [responsibleCustomerId, setResponsibleCustomerId] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [rowDraft, setRowDraft] = useState({ name: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'create'>('list');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: 'name' | 'phone' | 'created_at'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<{ name: string; phone: string | null; responsible_customer_id?: number } | null>(null);
  const { getDraft, saveDraft, removeDraft } = useFormDraft();
  const DRAFT_KEY = 'customer';
  const isDraftMode = !compact;

  const draftRef = useRef({ form, tab });
  const skipFirstCleanupRef = useRef(true);
  useEffect(() => { draftRef.current = { form, tab }; });

  useEffect(() => {
    if (!isDraftMode) return;
    const draft = getDraft<{ form: { firstName: string; lastName: string; phone: string }; tab: 'list' | 'create' }>(DRAFT_KEY);
    if (!draft) return;
    if (draft.form) setForm(draft.form);
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

  const reset = () => { setForm({ firstName: '', lastName: '', phone: '' }); setEditingId(null); setIsDependent(false); setResponsibleCustomerId(''); setFormError(''); setSuccess(null); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isDependent && !responsibleCustomerId) { setFormError('Selecione o responsável do dependente.'); return; }
    if (!isDependent && !isValidPhone(form.phone)) { setFormError('Informe o celular completo, com DDD e 9 dígitos.'); return; }
    const rawPhone = form.phone.replace(/\D/g, '');
    const formatted = isDependent ? null : formatPhone(form.phone);
    // Verificação de duplicata local
    if (!editingId && !isDependent) {
      const dup = (customers as Customer[])?.find(c => c.phone && c.phone.replace(/\D/g,'') === rawPhone);
      if (dup) { setFormError(`Celular já cadastrado para: ${dup.name}`); return; }
    }
    setSaving(true); setFormError(''); setSuccess(null);
    try {
      const payload = { name: `${form.firstName} ${form.lastName}`.trim(), phone: formatted, ...(isDependent ? { responsible_customer_id: Number(responsibleCustomerId) } : {}) };
      if (editingId) {
        const res: any = await db.customers.update(editingId, payload);
        if (res?.success === false) { setFormError(res.error ?? 'Erro ao salvar.'); return; }
        removeDraft(DRAFT_KEY);
        reset(); reload();
      } else {
        setPendingPayload(payload);
        setSaving(false);
        setConfirmOpen(true);
      }
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
    } finally { setSaving(false); }
  };

  const handleCreateConfirm = async () => {
    if (pendingPayload === null) return;
    setSaving(true); setFormError(''); setSuccess(null);
    try {
      const res: any = await db.customers.add(pendingPayload);
      if (res?.success === false) {
        setFormError(res.error ?? 'Erro ao salvar.');
        setPendingPayload(null);
        return;
      }
      if (onCreated) onCreated({ id: res.id, ...pendingPayload });
      setConfirmOpen(false);
      setPendingPayload(null);
      removeDraft(DRAFT_KEY);
      reset(); reload();
      setSuccess(pendingPayload.responsible_customer_id ? 'Dependente cadastrado com sucesso!' : 'Cliente cadastrado com sucesso!');
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
      setPendingPayload(null);
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    setPendingDeleteId(id);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async (adminCreds?: { username: string; password: string }, token?: string) => {
    if (pendingDeleteId === null) return;
    try {
      const res: any = await db.customers.remove(pendingDeleteId, adminCreds);
      if (res?.success === false) { setFormError(res.error ?? 'Erro ao excluir.'); return; }
      reload();
      setPendingDeleteId(null);
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao excluir.');
    }
  };

  const handleRowSave = async () => {
    if (editingRow === null) return;
    const rowCustomer = available.find(c => c.id === editingRow);
    if (!rowCustomer?.responsible_id && !isValidPhone(rowDraft.phone)) { setFormError('Informe o celular completo, com DDD e 9 dígitos.'); return; }
    const formatted = formatPhone(rowDraft.phone);
    setSaving(true); setFormError('');
    try {
      const res: any = await db.customers.update(editingRow, { name: rowDraft.name, phone: rowCustomer?.responsible_id ? '' : formatted });
      if (res?.success === false) { setFormError(res.error ?? 'Erro ao salvar.'); return; }
      setEditingRow(null); setRowDraft({ name: '', phone: '' });
      reload();
    } catch (err: any) {
      setFormError(err.message ?? 'Erro ao salvar.');
    } finally { setSaving(false); }
  };

  const available = (customers as Customer[]) ?? [];
  const eligibleResponsibles = available.filter(c => c.phone && !c.responsible_id);
  const q = stripDiacritics(search.trim().toLowerCase());
  const qDigits = search.replace(/\D/g, '');
  const list = available
    .filter(c => {
      if (!q && !qDigits) return true;
      const name = stripDiacritics((c.name ?? '').toLowerCase());
      const matchesName = q && name.includes(q);
      const matchesPhone = qDigits && (c.phone ?? '').replace(/\D/g, '').includes(qDigits);
      return matchesName || matchesPhone;
    })
    .sort((a, b) => {
      if (q || qDigits) {
        // Ordena por relevância quando há busca: início do nome, início do
        // telefone, depois ocorrências internas; empates por nome (A–Z).
        const score = (c: Customer) => {
          const name = stripDiacritics((c.name ?? '').toLowerCase());
          const phone = (c.phone ?? '').replace(/\D/g, '');
          let s = 0;
          if (q && name.startsWith(q)) s += 4;
          else if (q && name.includes(q)) s += 3;
          if (qDigits && phone.startsWith(qDigits)) s += 2;
          else if (qDigits && phone.includes(qDigits)) s += 1;
          return s;
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

  const formBlock = (
    <form onSubmit={handleSubmit} className={`grid gap-3 items-end bg-canvas p-4 rounded-xl border border-line ${compact ? '' : 'grid-cols-1 md:grid-cols-4'}`}>
        {success && (
        <p className={`flex items-center gap-1.5 text-xs font-semibold text-success bg-success-soft border border-success-line rounded-lg px-3 py-2 ${compact ? '' : 'md:col-span-4'}`}>
          <CheckCircle className="w-3.5 h-3.5 shrink-0" /> {success}
        </p>
      )}
        <div className={compact ? '' : 'md:col-span-1'}>
        <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-customermanager-1" >Nome</label>
        <input required autoFocus={compact} className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value.toUpperCase() })}  id="mf-customermanager-1" />
      </div>
      <div className={compact ? '' : 'md:col-span-1'}>
        <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-customermanager-2" >Sobrenome</label>
        <input required className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value.toUpperCase() })}  id="mf-customermanager-2" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-muted uppercase mb-1">Celular</label>
        {isDependent ? <p className="px-3 py-2 text-sm text-muted">Celular compartilhado do responsável</p> : <input required inputMode="numeric" className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none" value={form.phone} onChange={e => { setFormError(''); setForm({ ...form, phone: formatPhone(e.target.value) }); }} maxLength={15}  aria-label="Celular" />}
      </div>
      {!editingId && <div className={compact ? 'flex items-center gap-2' : 'md:col-span-4 flex items-center gap-2'}>
        <input id={compact ? 'customer-dependent-compact' : 'customer-dependent'} type="checkbox" checked={isDependent} onChange={e => { setIsDependent(e.target.checked); setResponsibleCustomerId(''); setForm(d => ({ ...d, phone: '' })); setFormError(''); }} />
        <label htmlFor={compact ? 'customer-dependent-compact' : 'customer-dependent'} className="text-sm text-ink">Cadastrar como dependente</label>
      </div>}
      {isDependent && <div className={compact ? '' : 'md:col-span-3'}>
        <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-customermanager-3" >Responsável</label>
        <select required value={responsibleCustomerId} onChange={e => setResponsibleCustomerId(e.target.value)} className="ui-field w-full px-3 py-2 rounded-lg border border-control-line bg-surface" id="mf-customermanager-3" >
          <option value="">Selecione um responsável</option>
          {eligibleResponsibles.map(c => <option key={c.id} value={c.id}>{c.name} — {c.phone}</option>)}
        </select>
      </div>}
      <div className="space-y-1">
        {formError && <p className="text-xs text-danger font-medium">{formError}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={saving}  className="ui-button ui-button-primary flex-1 text-on-coral py-2 px-3 rounded-lg font-medium hover:opacity-90 disabled:opacity-50 transition-all text-sm">
            {saving ? '...' : editingId ? 'Atualizar' : 'Adicionar'}
          </button>
          {editingId && <button type="button" onClick={reset} aria-label="Cancelar edição" className="ui-button ui-icon-button px-3 py-2 rounded-lg border border-control-line text-muted hover:bg-row-alt text-sm"><X size={16} aria-hidden="true" /></button>}
        </div>
      </div>
    </form>
  );

  if (compact) return (
    <>
      {formBlock}
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { setConfirmOpen(false); setPendingPayload(null); }}
        onConfirm={handleCreateConfirm}
        title={pendingPayload?.responsible_customer_id ? 'Criar dependente' : 'Criar cliente'}
        message={pendingPayload?.responsible_customer_id ? 'Deseja cadastrar este dependente vinculado ao responsável selecionado?' : 'Deseja realmente cadastrar este novo cliente?'}
        confirmLabel={pendingPayload?.responsible_customer_id ? 'Confirmar dependente' : 'Confirmar cadastro'}
      />
    </>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
      <div>
        <h2 className="ui-page-title text-3xl font-medium text-ink">Clientes</h2>
        <p className="text-muted">Gerencie os clientes da farmácia.</p>
      </div>
      <div className="flex items-center gap-4 border-b border-line">
        <button onClick={() => { setTab('list'); }} className={`ui-button pb-4 px-2 text-sm font-medium transition-colors relative ${tab === 'list' ? 'text-brand' : 'text-muted hover:text-ink'}`}>
          Lista de Clientes
          {tab === 'list' && <motion.div layoutId="activeCust" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />}
        </button>
        <button onClick={() => setTab('create')} className={`ui-button pb-4 px-2 text-sm font-medium transition-colors relative ${tab === 'create' ? 'text-brand' : 'text-muted hover:text-ink'}`}>
          Cadastro de cliente
          {tab === 'create' && <motion.div layoutId="activeCust" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />}
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
                      value={search} onChange={e => setSearch(e.target.value)}  aria-label="Buscar clientes" />
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
                    <option value="phone:asc">Celular</option>
                  </select>
                  <span className="text-xs font-semibold text-muted whitespace-nowrap">
                    {list.length} de {available.length} {available.length === 1 ? 'cliente' : 'clientes'}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="ui-table w-full text-left">
                    <thead><tr className="border-b border-line text-muted text-xs uppercase font-semibold">
                      <th className="px-4 py-3">Nome</th><th className="px-4 py-3">Celular</th><th className="px-4 py-3">Responsável</th><th className="px-4 py-3">Cadastro</th><th className="px-4 py-3 text-right">Ações</th>
                    </tr></thead>
                    <tbody className="divide-y divide-zinc-50">
                      {list.map(c => (
                        <tr key={c.id} className="hover:bg-canvas transition-colors">
                          <td className="px-4 py-3 font-medium text-ink">
                            {editingRow === c.id ? (
                              <input className="ui-field w-full px-2 py-1 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
                                value={rowDraft.name} onChange={e => setRowDraft(d => ({ ...d, name: e.target.value.toUpperCase() }))}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRowSave(); } else if (e.key === 'Escape') { setEditingRow(null); setRowDraft({ name: '', phone: '' }); setFormError(''); } }}  aria-label="Nome do cliente" />
                            ) : (
                              <HighlightMatch text={c.name} query={search} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted">
                            {editingRow === c.id ? (
                              <div>
                                {c.responsible_id ? <span className="text-sm text-muted">{c.responsible_phone ?? ''}</span> : <input inputMode="numeric" maxLength={15}
                                  className="ui-field w-full px-2 py-1 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
                                  value={rowDraft.phone} onChange={e => setRowDraft(d => ({ ...d, phone: formatPhone(e.target.value) }))}
                                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRowSave(); } else if (e.key === 'Escape') { setEditingRow(null); setRowDraft({ name: '', phone: '' }); setFormError(''); } }}  aria-label="Celular do cliente" />}
                                {formError && <p className="text-xs text-danger font-medium mt-1">{formError}</p>}
                              </div>
                            ) : (
                              <HighlightMatch text={c.phone ?? ''} query={search} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted">{c.responsible_name ? <><span>{c.responsible_name}</span><br /><span className="text-xs text-muted">{c.responsible_phone ?? ''}</span></> : '—'}</td>
                          <td className="px-4 py-3 text-muted text-sm">{c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : '—'}</td>
                          <td className="px-4 py-3 text-right space-x-3">
                            {editingRow === c.id ? (
                              <>
                                <button onClick={handleRowSave} disabled={saving} className="ui-button text-muted hover:text-success text-sm font-medium transition-colors disabled:opacity-50">
                                  {saving ? '...' : 'Salvar'}
                                </button>
                                <button onClick={() => { setEditingRow(null); setRowDraft({ name: '', phone: '' }); setFormError(''); }} className="ui-button text-muted hover:text-danger text-sm transition-colors">Cancelar</button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => { setRowDraft({ name: c.name, phone: c.phone }); setEditingRow(c.id); setFormError(''); }} className="ui-button text-muted hover:text-info text-sm transition-colors">Editar</button>
                                <button onClick={() => handleDelete(c.id)} className="ui-button ui-icon-button text-muted hover:text-danger transition-colors" aria-label="Excluir" ><Trash2 className="w-4 h-4" /></button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {available.length === 0 && <p className="text-center py-8 text-muted">Nenhum cliente cadastrado.</p>}
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
        title="Excluir cliente"
        message="Esta ação não pode ser desfeita. O cliente será removido permanentemente."
      />
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { setConfirmOpen(false); setPendingPayload(null); }}
        onConfirm={handleCreateConfirm}
        title="Criar cliente"
        message="Deseja realmente cadastrar este novo cliente?"
        confirmLabel="Confirmar cadastro"
      />
    </motion.div>
  );
}
