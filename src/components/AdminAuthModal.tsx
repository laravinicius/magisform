import { DialogSurface } from './DialogSurface';
import React, { useEffect, useState } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { handleDialogArrowNavigation } from '../utils/enterNavigation';
import { useAuth } from '../context/AuthContext';

interface AdminAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (credentials: { username: string; password: string }) => Promise<void>;
  title?: string;
  message?: string;
}

export function AdminAuthModal({ isOpen, onClose, onConfirm, title = 'Confirmar ação', message = 'Informe suas credenciais para confirmar esta ação.' }: AdminAuthModalProps) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => { if (isOpen) { setUsername(user?.username ?? ''); setPassword(''); setError(''); } }, [isOpen, user?.username]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onConfirm({ username: username.trim(), password });
      setPassword('');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sua sessão não tem permissão para esta ação.');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}
      onKeyDown={event => { if (event.key === 'Escape' && !loading) onClose(); }}>
      <DialogSurface className="ui-dialog bg-surface rounded-2xl w-full max-w-md p-6" onClick={event => event.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-warning-strong flex items-center justify-center shrink-0"><AlertCircle className="w-5 h-5 text-warning" /></div>
            <div><h3 className="font-bold text-ink text-lg">{title}</h3><p className="text-xs text-muted">{message}</p></div>
          </div>
          <button onClick={onClose} disabled={loading} className="ui-button ui-icon-button p-1 text-muted disabled:opacity-50" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        {error && <p className="flex items-center gap-1.5 text-xs text-danger font-medium bg-danger-soft border border-danger-line rounded-lg px-3 py-2"><AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-3 pt-3">
          <div><label htmlFor="admin-confirm-user" className="block text-sm font-semibold mb-1">Usuário com permissão</label><input id="admin-confirm-user" className="ui-field w-full px-3 py-2 rounded-lg" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></div>
          <div><label htmlFor="admin-confirm-password" className="block text-sm font-semibold mb-1">Senha</label><input id="admin-confirm-password" type="password" className="ui-field w-full px-3 py-2 rounded-lg" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></div>
          <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={loading} className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas disabled:opacity-50">Cancelar</button>
          <button type="submit" disabled={loading} className="ui-button ui-icon-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Confirmar'}
          </button>
          </div>
        </form>
      </DialogSurface>
    </div>
  );
}
