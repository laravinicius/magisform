import { DialogSurface } from './DialogSurface';
import React, { useState } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { handleDialogArrowNavigation } from '../utils/enterNavigation';

interface AdminAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title?: string;
  message?: string;
}

export function AdminAuthModal({ isOpen, onClose, onConfirm, title = 'Confirmar ação', message = 'Confirme a ação. O servidor verificará o papel da sua sessão.' }: AdminAuthModalProps) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onConfirm();
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
        <form onSubmit={handleSubmit} className="flex gap-3 pt-3">
          <button type="button" onClick={onClose} disabled={loading} className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas disabled:opacity-50">Cancelar</button>
          <button type="submit" disabled={loading} className="ui-button ui-icon-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Confirmar'}
          </button>
        </form>
      </DialogSurface>
    </div>
  );
}
