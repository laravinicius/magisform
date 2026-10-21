import { DialogSurface } from './DialogSurface';
import React, { useState } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { handleDialogArrowNavigation } from '../utils/enterNavigation';

interface AdminAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (adminCreds?: { username: string; password: string }) => Promise<void>;
  title?: string;
  message?: string;
}

export function AdminAuthModal({ isOpen, onClose, onConfirm, title = 'Confirmação de exclusão', message = 'Esta ação requer credenciais de um perfil Farmacêutico, Gerente ou Administrador.' }: AdminAuthModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Informe usuário e senha.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await onConfirm({ username: username.trim(), password: password.trim() });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Credenciais de administrador inválidas');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}
      onKeyDown={e => { if (e.key === 'Escape' && !loading) onClose(); }}>
      <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-warning-strong flex items-center justify-center shrink-0">
              <AlertCircle className="w-5 h-5 text-warning" />
            </div>
            <div>
              <h3 className="font-bold text-ink text-lg">{title}</h3>
              <p className="text-xs text-muted">{message}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading} className="ui-button ui-icon-button p-1 text-muted hover:text-muted transition-colors disabled:opacity-50" aria-label="Fechar" >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-muted mb-4">Informe usuário e senha de um perfil Farmacêutico, Gerente ou Administrador para confirmar a exclusão.</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-adminauthmodal-1" >Usuário</label>
            <input
              type="text"
              autoFocus
              value={username}
              onChange={e => { setError(''); setUsername(e.target.value); }}
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
              disabled={loading}
             id="mf-adminauthmodal-1" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-adminauthmodal-2" >Senha</label>
            <input
              type="password"
              value={password}
              onChange={e => { setError(''); setPassword(e.target.value); }}
              onKeyDown={e => e.key === 'Enter' && !loading && handleSubmit(e as any)}
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
              disabled={loading}
             id="mf-adminauthmodal-2" />
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-xs text-danger font-medium bg-danger-soft border border-danger-line rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="ui-button ui-icon-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-50"

            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Confirmar exclusão'}
            </button>
          </div>
        </form>
      </DialogSurface>
    </div>
  );
}
