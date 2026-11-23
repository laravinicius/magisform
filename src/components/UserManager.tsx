import React, { useState, useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../services/lanDatabase';
import { User } from '../types';
import { useData } from '../hooks/useData';
import { useFormDraft } from '../context/FormDraftContext';
import { LoadingState, ErrorState } from './Feedback';
import { AdminAuthModal } from './AdminAuthModal';
import { AuditLogs } from './AuditLogs';
import { COLORS } from '../../config/branding';
import { canManageUsers, USER_ROLE_LABELS, UserRole } from '../types';

const ADMIN_TABS = [
  { id: 'users', label: 'Usuários' },
  { id: 'logs', label: 'Logs' },
] as const;

export function AdminPanel({ user }: { user: User }) {
  const [activeTab, setActiveTab] = useState<(typeof ADMIN_TABS)[number]['id']>('users');

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextTab: typeof activeTab;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        nextTab = activeTab === 'users' ? 'logs' : 'users';
        break;
      case 'Home':
        nextTab = 'users';
        break;
      case 'End':
        nextTab = 'logs';
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveTab(nextTab);
    event.currentTarget.querySelector<HTMLButtonElement>(`#admin-tab-${nextTab}`)?.focus();
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="flex flex-col gap-6">
      {canManageUsers(user.role) ? (
        <>
          <h2 className="ui-page-title text-3xl font-medium text-ink">Administração</h2>
          <div role="tablist" aria-label="Administração" className="flex items-center gap-4 border-b border-line" onKeyDown={handleTabKeyDown}>
            {ADMIN_TABS.map(({ id, label }) => (
              <button
                key={id}
                id={`admin-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                aria-controls={`admin-panel-${id}`}
                tabIndex={activeTab === id ? 0 : -1}
                onClick={() => setActiveTab(id)}
                className={`ui-button relative px-2 pb-4 text-sm font-medium ${
                  activeTab === id ? 'text-brand' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
                {activeTab === id && (
                  <motion.span layoutId="activeAdminTab" className="absolute inset-x-0 bottom-0 h-0.5 bg-brand" />
                )}
              </button>
            ))}
          </div>
          <div id="admin-panel-users" role="tabpanel" aria-labelledby="admin-tab-users" tabIndex={0}
            hidden={activeTab !== 'users'} className="ui-panel overflow-hidden rounded-2xl">
            <UserManager user={user} />
          </div>
          <div id="admin-panel-logs" role="tabpanel" aria-labelledby="admin-tab-logs" tabIndex={0} hidden={activeTab !== 'logs'}>
            <AuditLogs />
          </div>
        </>
      ) : (
        <div className="ui-panel rounded-2xl">
          <p className="p-6 text-sm text-muted">Somente perfis Farmacêutico, Gerente ou Administrador podem gerenciar usuários.</p>
        </div>
      )}
    </motion.div>
  );
}

export function UserManager({ user }: { user: User }) {
  const { data: users, loading, error, reload } = useData('users', activity => db.users.list(activity));
  const emptyForm = { name: '', username: '', role: 'employee' as UserRole };
  const [form, setForm] = useState(emptyForm);
  const [password, setPassword] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const { getDraft, saveDraft, removeDraft } = useFormDraft();
  const DRAFT_KEY = 'userManager';

  const draftRef = useRef(form);
  const skipFirstCleanupRef = useRef(true);
  useEffect(() => { draftRef.current = form; });

  useEffect(() => {
    const draft = getDraft<{ form: typeof emptyForm }>(DRAFT_KEY);
    if (!draft?.form) return;
    setForm(draft.form);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (skipFirstCleanupRef.current) { skipFirstCleanupRef.current = false; return; }
      saveDraft(DRAFT_KEY, { form: draftRef.current });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setForm(emptyForm);
    setPassword('');
    setEditingId(null);
    setFormError('');
  };

  const startEdit = (u: any) => {
    setForm({ name: u.name, username: u.username, role: u.role });
    setEditingId(u.id);
    setFormError('');
    // Scroll suave ao formulário
    document.getElementById('user-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    setSaving(true);
    try {
      if (editingId) {
        const res: any = await db.users.update(editingId, {
          name: form.name.trim(),
          username: form.username.trim(),
          role: form.role,
          ...(password ? { password } : {}),
        });
        if (res && res.success === false) {
          setFormError(res.error ?? 'Erro ao salvar. Tente novamente.');
          return;
        }
      } else {
        const res: any = await db.users.add({
          name: form.name.trim(),
          username: form.username.trim(),
          role: form.role,
          password,
        });
        if (res && res.success === false) {
          setFormError(res.error ?? 'Erro ao salvar. Tente novamente.');
          return;
        }
      }
      removeDraft(DRAFT_KEY);
      reset();
      reload();
    } catch (err: any) {
      setFormError(err?.message ?? 'Erro ao salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u: any) => {
    if (u.username === 'admin') { alert('O usuário de configuração não pode ser excluído.'); return; }
    if (u.username === user.username) { alert('Você não pode excluir seu próprio usuário.'); return; }
    // Cancela edição se for o mesmo usuário sendo deletado
    if (editingId === u.id) reset();
    setPendingDeleteId(u.id);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async (credentials: { username: string; password: string }) => {
    if (pendingDeleteId === null) return;
    try {
      const res: any = await db.users.remove(pendingDeleteId, credentials);
      if (res?.success === false) throw new Error(res.error ?? 'Erro ao excluir.');
      reload();
      setPendingDeleteId(null);
    } catch (err: any) {
      setFormError(err?.message ?? 'Erro ao excluir.');
      throw err;
    }
  };

  const isEditing = editingId !== null;

  return (
    <div className="p-6 space-y-6">
      {/* Formulário */}
      <div id="user-form" className={`rounded-xl border p-5 space-y-4 transition-colors ${isEditing ? 'bg-info-soft border-info-line' : 'bg-canvas border-line'}`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-ink uppercase tracking-wide">
            {isEditing ? 'Editando usuário' : 'Novo usuário'}
          </h3>
          {isEditing && (
            <button type="button" onClick={reset}
              className="ui-button text-xs text-muted hover:text-ink px-2 py-1 rounded-lg hover:bg-row-alt transition-colors">
              Cancelar edição
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-usermanager-1" >Nome completo</label>
            <input
              required
              type="text"
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
             id="mf-usermanager-1" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-usermanager-2" >Usuário</label>
            <input
              required
              type="text"
              autoComplete="off"
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface"
              value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
             id="mf-usermanager-2" />
          </div>

          <div><label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-usermanager-password">{isEditing ? 'Nova senha (opcional)' : 'Senha inicial'}</label><input id="mf-usermanager-password" type="password" required={!isEditing} minLength={8} maxLength={255} autoComplete="new-password" className="ui-field w-full px-3 py-2 rounded-lg border border-control-line bg-surface" value={password} onChange={e => setPassword(e.target.value)} /></div>

          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-usermanager-4" >Cargo</label>
            <select
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface"
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value as any }))} id="mf-usermanager-4" >
              <option value="employee">Funcionário</option>
              <option value="pharmacist">Farmacêutico</option>
              <option value="manager">Gerente</option>
              <option value="admin">Administrador</option>
            </select>
          </div>

          <div className="space-y-1">
            {formError && (
              <p className="text-xs text-danger font-medium bg-danger-soft px-2 py-1 rounded">{formError}</p>
            )}
            <button
              type="submit"
              disabled={saving}
              style={{ background: isEditing ? COLORS.secondary : COLORS.primary, color: isEditing ? COLORS.onSecondary : COLORS.onPrimary }}
              className="ui-button w-full text-white py-2 px-3 rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 transition-all text-sm">
              {saving ? 'Salvando...' : isEditing ? 'Salvar alterações' : '+ Adicionar'}
            </button>
          </div>
        </form>
      </div>

      {/* Lista */}
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="ui-table w-full text-left">
            <thead>
              <tr className="border-b border-line bg-canvas text-muted text-xs uppercase font-semibold">
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Usuário</th>
                <th className="px-4 py-3">Cargo</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 bg-surface">
              {(users as any[])?.map(u => (
                <tr key={u.id}
                  className={`transition-colors ${editingId === u.id ? 'bg-info-soft' : 'hover:bg-canvas'}`}>
                  <td className="px-4 py-3 font-medium text-ink">{u.name}</td>
                  <td className="px-4 py-3 text-muted font-mono text-sm">{u.username}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      u.role === 'admin' ? 'bg-danger-soft text-danger' :
                      u.role === 'manager' ? 'bg-success-soft text-success' :
                      u.role === 'pharmacist' ? 'bg-info-soft text-info' :
                      'bg-warning-soft text-warning'
                    }`}>
                      {USER_ROLE_LABELS[u.role as UserRole] ?? u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => editingId === u.id ? reset() : startEdit(u)}
                      className={`ui-button text-xs font-semibold px-3 py-1 rounded-lg transition-colors ${editingId === u.id ? 'bg-row-alt text-muted hover:bg-sage' : 'text-info hover:bg-info-soft'}`}>
                      {editingId === u.id ? 'Cancelar' : 'Editar'}
                    </button>
                    {u.username !== 'admin' && u.username !== user.username && (
                      <button
                        onClick={() => handleDelete(u)}
                        className="ui-button ui-icon-button text-muted hover:text-danger transition-colors p-1 rounded" aria-label="Excluir" >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(users as any[])?.length === 0 && (
            <p className="text-center py-10 text-muted">Nenhum funcionário cadastrado.</p>
          )}
        </div>
      )}
      <AdminAuthModal
        isOpen={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setPendingDeleteId(null); }}
        onConfirm={handleDeleteConfirm}
        title="Excluir usuário"
        message="Esta ação não pode ser desfeita. O usuário não conseguirá mais fazer login."
      />
    </div>
  );
}
