import { DialogSurface } from './components/DialogSurface';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Users, Cross, BarChart3, User as UserIcon, PlusCircle, LogOut,
  CheckCircle2, Clock, Menu, Settings, RefreshCw, AlertCircle,
  CheckCircle, History, AlertTriangle, Bookmark, ChevronDown, FlaskConical, Cog, X,
} from 'lucide-react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { db } from './services/lanDatabase';
import { Formula, USER_ROLE_LABELS } from './types';
import { BrandLogo } from './components/Logo';
import { COLORS } from '../config/branding';
import { NavItem } from './components/NavItem';
import { AdminPanel } from './components/UserManager';
import { CustomerManager } from './components/CustomerManager';
import { InsumoManager } from './components/InsumoManager';
import { Dashboard } from './components/Dashboard';
import { RecipeForm } from './components/RecipeForm';
import { FormulaList } from './components/FormulaList';
import { SavedFormulaManager } from './components/SavedFormulaManager';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FormDraftProvider, useFormDraft } from './context/FormDraftContext';
import { AdminAuthModal } from './components/AdminAuthModal';
import { handleDialogArrowNavigation, handleEnterAsTab } from './utils/enterNavigation';
import { TenantSelector } from './components/TenantSelector';
import { PlatformManagement } from './components/PlatformManagement';

interface HeartbeatMetrics {
  callCount: number;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  lastDurationMs: number;
  lastValid: boolean | null;
  lastError: string | null;
}

const heartbeatMetrics: HeartbeatMetrics = {
  callCount: 0,
  successCount: 0,
  failureCount: 0,
  totalDurationMs: 0,
  lastDurationMs: 0,
  lastValid: null,
  lastError: null,
};

export function getHeartbeatMetrics(): HeartbeatMetrics {
  return { ...heartbeatMetrics };
}

export function resetHeartbeatMetrics(): void {
  heartbeatMetrics.callCount = 0;
  heartbeatMetrics.successCount = 0;
  heartbeatMetrics.failureCount = 0;
  heartbeatMetrics.totalDurationMs = 0;
  heartbeatMetrics.lastDurationMs = 0;
  heartbeatMetrics.lastValid = null;
  heartbeatMetrics.lastError = null;
}

// ─── Modal de Confirmação de Saída ─────────────────────────────────────────────

function ExitConfirmModal({ show, onConfirm, onCancel }: {
  show: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onCancel}
      onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}>
      <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-warning-strong flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h3 className="font-bold text-ink text-lg">
              Sair da conta
            </h3>
            <p className="text-xs text-muted">
              Sua sessão será encerrada.
            </p>
          </div>
        </div>
        <p className="text-sm text-ink mb-4">
          Deseja realmente sair da conta?
        </p>
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} autoFocus
            className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas transition-colors">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm}
            className="ui-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm hover:opacity-90 transition-all"
            >
            Sim, sair
          </button>
        </div>
      </DialogSurface>
    </div>
  );
}

// ─── App Principal ─────────────────────────────────────────────────────────────

function AppInner() {
  const { user, setAuth, clearAuth } = useAuth();
  const { clearDrafts, hasDrafts } = useFormDraft();
  const [authReady, setAuthReady] = useState(false);
  const [loginConflict, setLoginConflict] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'admin' | 'recipe' | 'pending' | 'confirmed' | 'formulaDetail' | 'confirmedDetail' | 'history' | 'historyDetail' | 'cancelled' | 'cancelledDetail' | 'customers' | 'insumos' | 'savedFormulas' | 'settings'>('dashboard');
  const [confirmedStage, setConfirmedStage] = useState<'em_producao' | 'aguardando_retirada'>('em_producao');
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 900);
  const [formulasMenuOpen, setFormulasMenuOpen] = useState(true);
  const [managementMenuOpen, setManagementMenuOpen] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' } | null>(null);
  const [templateFormula, setTemplateFormula] = useState<Formula | null>(null);
  const [viewingFormula, setViewingFormula] = useState<Formula | null>(null);
  const [partialPaymentAmounts, setPartialPaymentAmounts] = useState<Record<number, string>>({});
  const [missingReasons, setMissingReasons] = useState<string[] | null>(null);
  const [missingReasonsTarget, setMissingReasonsTarget] = useState<'pending' | 'confirmed' | null>(null);
  const [autoUnlockFormula, setAutoUnlockFormula] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem('magisform.fontScale')) || 1);
  const canViewSavedFormulas = user?.role === 'pharmacist' || user?.role === 'admin' || user?.role === 'manager';

  useEffect(() => {
    if (!canViewSavedFormulas && activeTab === 'savedFormulas') {
      setActiveTab('dashboard');
    }
  }, [activeTab, canViewSavedFormulas]);

  const isTabActive = useCallback((tab: string) => {
    if (activeTab === tab) return true;
    if (tab === 'pending' && activeTab === 'formulaDetail') return true;
    if (tab === 'confirmed' && activeTab === 'confirmedDetail') return true;
    if (tab === 'history' && activeTab === 'historyDetail') return true;
    if (tab === 'cancelled' && activeTab === 'cancelledDetail') return true;
    return false;
  }, [activeTab]);

  useEffect(() => {
    if (['recipe', 'pending', 'confirmed', 'formulaDetail', 'confirmedDetail', 'history', 'historyDetail', 'cancelled', 'cancelledDetail', 'insumos'].includes(activeTab)) {
      setFormulasMenuOpen(true);
    }
    if (['customers', 'savedFormulas'].includes(activeTab)) {
      setManagementMenuOpen(true);
    }
  }, [activeTab]);

  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInactivityLogoutRef = useRef<() => Promise<void>>();
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

  const handleInactivityLogout = useCallback(async () => {
    await db.auth.logout().catch(() => {});
    clearDrafts();
    clearAuth();
    setPartialPaymentAmounts({});

    setActiveTab('dashboard');
    setLoginError('Sessão encerrada por inatividade (5 min).');
  }, [clearAuth, clearDrafts]);

  useEffect(() => {
    handleInactivityLogoutRef.current = handleInactivityLogout;
  }, [handleInactivityLogout]);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => handleInactivityLogoutRef.current?.(), INACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
    localStorage.setItem('magisform.fontScale', String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    if (!viewingFormula) setAutoUnlockFormula(false);
  }, [viewingFormula]);

  useEffect(() => {
    const formulaId = Number(new URLSearchParams(window.location.search).get('formulaId'));
    if (!user || !Number.isSafeInteger(formulaId) || formulaId <= 0) return;
    let active = true;
    void db.formulas.get(formulaId).then(formula => {
      if (!active || !formula) return;
      setViewingFormula(formula);
      setActiveTab(formula.status === 'confirmed' ? 'confirmedDetail' : formula.status === 'delivered' ? 'historyDetail' : formula.status === 'cancelled' ? 'cancelledDetail' : 'formulaDetail');
    }).catch(error => {
      if (active) setToast({ msg: error instanceof Error ? error.message : 'Não foi possível abrir a fórmula solicitada.', type: 'info' });
    });
    return () => { active = false; };
  }, [user, window.location.search]);

  useEffect(() => {
    if (!user) return;

    const activityEvents = ['mousemove', 'keydown', 'click', 'touchstart'] as const;

    const handleActivity = () => resetInactivityTimer();

    activityEvents.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));

    resetInactivityTimer();

    return () => {
      activityEvents.forEach(event => window.removeEventListener(event, handleActivity));
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [user, resetInactivityTimer]);

  useEffect(() => {
    let active = true;
    void db.auth.current().then(res => {
      if (!active) return;
      if (res.success && res.user) setAuth(res.user);
      setAuthReady(true);
    }).catch(() => {
      if (!active) return;
      setLoginError('Não foi possível verificar a sessão. Confira a conexão e tente entrar novamente.');
      setAuthReady(true);
    });
    return () => { active = false; };
  }, [setAuth]);

  useEffect(() => db.auth.onExpired(() => {
    db.auth.invalidateSession();
    clearDrafts(); clearAuth(); setPartialPaymentAmounts({});
    setLoginError('Sua sessão expirou ou foi encerrada em outro dispositivo. Entre novamente.');
  }), [clearAuth, clearDrafts]);

  const showToast = (msg: string, type: 'success' | 'info' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const doLogin = async (force: boolean) => {
    setLoginLoading(true); setLoginError('');
    try {
      const res = await db.auth.login(force);
      if (res.success) {
        clearDrafts();
        setAuth(res.user);

        setActiveTab('dashboard');
        setLoginConflict(false);
      } else if (res.conflict) {
        setLoginConflict(true);
      } else {
        setLoginError(res.error ?? 'Erro ao fazer login.');
      }
    } catch (error) {
      setLoginError('Erro ao conectar ao servidor.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    doLogin(false);
  };

  const handleLogout = () => {
    setShowExitConfirm(true);
  };

  const handleExitConfirm = async () => {
    await db.auth.logout().catch(() => {});
    clearDrafts();
    clearAuth();
    setPartialPaymentAmounts({});
    setActiveTab('dashboard');
    setShowExitConfirm(false);
  };

  const handleExitCancel = () => {
    setShowExitConfirm(false);
  };

  const exitModal = (
    <ExitConfirmModal
      show={showExitConfirm}
      onConfirm={handleExitConfirm}
      onCancel={handleExitCancel}
    />
  );

  // Consulta a validade sem renovar a inatividade; sessão revogada retorna ao login.
  const isHeartbeatRunningRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const runHeartbeat = async () => {
      if (isHeartbeatRunningRef.current) return;
      isHeartbeatRunningRef.current = true;
      const start = performance.now();
      try {
        heartbeatMetrics.callCount++;
        const res = await db.auth.heartbeat();
        const duration = performance.now() - start;
        heartbeatMetrics.totalDurationMs += duration;
        heartbeatMetrics.lastDurationMs = duration;
        heartbeatMetrics.lastValid = res.valid;
        heartbeatMetrics.lastError = null;
        if (res.valid) {
          heartbeatMetrics.successCount++;
        } else {
          heartbeatMetrics.failureCount++;
        }
        if (!res.valid) {
          clearDrafts();
          clearAuth();
          setPartialPaymentAmounts({});

          setLoginError('Sua sessão foi encerrada em outro dispositivo.');
        }
      } catch (e: any) {
        const duration = performance.now() - start;
        heartbeatMetrics.totalDurationMs += duration;
        heartbeatMetrics.lastDurationMs = duration;
        heartbeatMetrics.failureCount++;
        heartbeatMetrics.lastError = e.message ?? 'Erro desconhecido';
        /* servidor fora do ar: mantém a sessão local */
      } finally {
        isHeartbeatRunningRef.current = false;
      }
    };

    runHeartbeat();
    timer = setInterval(runHeartbeat, 30_000);
    return () => {
      if (timer) clearInterval(timer);
      isHeartbeatRunningRef.current = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !hasDrafts) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [user, hasDrafts]);

  useEffect(() => {
    const adaptNavigationWidth = () => setIsSidebarOpen(window.innerWidth >= 900);
    window.addEventListener('resize', adaptNavigationWidth);
    adaptNavigationWidth();
    return () => window.removeEventListener('resize', adaptNavigationWidth);
  }, []);

  if (!authReady) return <div className="flex-1 grid place-items-center bg-canvas text-muted">Verificando sessão…</div>;

  if (!user) {
    return (
      <>
        <div className="ui-login flex-1 min-h-0 flex flex-col items-center p-4 bg-canvas">
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="ui-login-card ui-panel w-full max-w-md bg-surface rounded-2xl  border border-line overflow-hidden"
          >
            <div className="h-1.5 w-full" style={{ background: COLORS.secondary }} />
            <div className="flex justify-center px-8 pt-5">
              <div style={{ maxWidth: 408 }}>
                <BrandLogo size="lg" />
              </div>
            </div>
            <div className="px-8 py-6">
            <div className="flex flex-col items-center mb-8">
            <p className="text-muted text-sm mt-2">Acesso protegido pelo Cloudflare</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
              <p className="text-sm text-muted text-center">O Cloudflare Access verifica o código enviado ao e-mail autorizado para esta farmácia.</p>
              {loginError && (
                <div className="flex items-center gap-2 text-danger text-sm bg-danger-soft px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 shrink-0" />{loginError}
                </div>
              )}
              <button type="submit" disabled={loginLoading}
                className="ui-button ui-button-primary ui-popover w-full hover:opacity-90 disabled:opacity-60 text-on-coral font-semibold py-2.5 rounded-lg transition-all  "

              >
                {loginLoading ? 'Conectando...' : 'Continuar'}
              </button>
            </form>
            </div>
          </motion.div>

          {loginConflict && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={() => setLoginConflict(false)}
              onKeyDown={e => { if (e.key === 'Escape') setLoginConflict(false); }}>
              <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-warning-strong flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-5 h-5 text-warning" />
                  </div>
                  <div>
                    <h3 className="font-bold text-ink text-lg">Usuário já logado</h3>
                    <p className="text-xs text-muted">Este usuário já está logado em outro dispositivo.</p>
                  </div>
                </div>
                <p className="text-sm text-ink mb-4">Deseja entrar mesmo assim? A sessão do outro dispositivo será encerrada.</p>
                <div className="flex gap-3">
                  <button type="button" onClick={() => setLoginConflict(false)} autoFocus
                    className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas transition-colors">
                    Cancelar
                  </button>
                  <button type="button" onClick={() => doLogin(true)} disabled={loginLoading}
                    className="ui-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-60"
                    >
                    {loginLoading ? 'Entrando...' : 'Entrar mesmo assim'}
                  </button>
                </div>
              </DialogSurface>
            </div>
          )}
        </div>
        {exitModal}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-1 min-h-0">

      {/* Toast de notificação */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className="ui-popover fixed top-10 right-4 z-50 px-4 py-3 rounded-xl  text-sm font-semibold text-white flex items-center gap-2 pointer-events-none"
            style={{ background: toast.type === 'success' ? COLORS.success : COLORS.secondary }}
          >
            {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
        {/* Sidebar */}
        <aside data-collapsed={!isSidebarOpen} className={`ui-sidebar border-r border-line ${isSidebarOpen ? 'w-[256px]' : 'w-[80px]'} flex flex-col shrink-0 h-full overflow-hidden`}
          style={{ background: COLORS.secondary }}>
          <div className="p-5 w-full">
            <BrandLogo size={isSidebarOpen ? 'sidebar' : 'icon'} />
          </div>

          <nav className="flex-1 min-h-0 overflow-y-auto px-4 space-y-1">
              <>
                <NavItem icon={<BarChart3 />} label="Dashboard" active={isTabActive('dashboard')} onClick={() => setActiveTab('dashboard')} collapsed={!isSidebarOpen} />
                <button type="button" onClick={() => {
                  if (!isSidebarOpen) {
                    setIsSidebarOpen(true);
                    setFormulasMenuOpen(true);
                  } else {
                    setFormulasMenuOpen(open => !open);
                  }
                }} title={!isSidebarOpen ? 'Fórmulas' : undefined} aria-label={!isSidebarOpen ? 'Fórmulas' : undefined} aria-expanded={isSidebarOpen && formulasMenuOpen}
                  className={`ui-button ui-nav w-full flex items-center justify-between rounded-lg text-nav-muted ${isSidebarOpen ? 'hover:text-surface hover:bg-nav-active' : 'justify-center hover:text-surface hover:bg-nav-active'}`}>
                  <span className="flex items-center gap-3 truncate"><FlaskConical className="w-5 h-5 shrink-0" />{isSidebarOpen && 'Fórmulas'}</span>
                  {isSidebarOpen && <ChevronDown className={`w-4 h-4 transition-transform ${formulasMenuOpen ? 'rotate-180' : ''}`} />}
                </button>
                {formulasMenuOpen && <div className={`${isSidebarOpen ? 'pl-3 ' : ''}space-y-1`}>
                  <NavItem icon={<PlusCircle />} label="Nova Fórmula" active={isTabActive('recipe')} onClick={() => setActiveTab('recipe')} collapsed={!isSidebarOpen} />
                  <NavItem icon={<Clock />} label="Pendentes" active={isTabActive('pending')} onClick={() => setActiveTab('pending')} collapsed={!isSidebarOpen} />
                  <NavItem icon={<CheckCircle2 />} label="Confirmadas" active={isTabActive('confirmed')} onClick={() => { setConfirmedStage('em_producao'); setActiveTab('confirmed'); }} collapsed={!isSidebarOpen} />
                  <NavItem icon={<History />} label="Histórico" active={isTabActive('history')} onClick={() => setActiveTab('history')} collapsed={!isSidebarOpen} />
                  <NavItem icon={<X />} label="Canceladas" active={isTabActive('cancelled')} onClick={() => setActiveTab('cancelled')} collapsed={!isSidebarOpen} />
                  <NavItem icon={<Cross />} label="Insumos" active={isTabActive('insumos')} onClick={() => setActiveTab('insumos')} collapsed={!isSidebarOpen} />
                </div>}
                <button type="button" onClick={() => {
                  if (!isSidebarOpen) {
                    setIsSidebarOpen(true);
                    setManagementMenuOpen(true);
                  } else {
                    setManagementMenuOpen(open => !open);
                  }
                }} title={!isSidebarOpen ? 'Gerenciamento' : undefined} aria-label={!isSidebarOpen ? 'Gerenciamento' : undefined} aria-expanded={isSidebarOpen && managementMenuOpen}
                  className={`ui-button ui-nav w-full flex items-center justify-between rounded-lg text-nav-muted ${isSidebarOpen ? 'hover:text-surface hover:bg-nav-active' : 'justify-center hover:text-surface hover:bg-nav-active'}`}>
                  <span className="flex items-center gap-3 truncate"><Cog className="w-5 h-5 shrink-0" />{isSidebarOpen && 'Gerenciamento'}</span>
                  {isSidebarOpen && <ChevronDown className={`w-4 h-4 transition-transform ${managementMenuOpen ? 'rotate-180' : ''}`} />}
                </button>
                {managementMenuOpen && <div className={`${isSidebarOpen ? 'pl-3 ' : ''}space-y-1`}>
                  <NavItem icon={<Users />} label="Clientes" active={isTabActive('customers')} onClick={() => setActiveTab('customers')} collapsed={!isSidebarOpen} />
                  {canViewSavedFormulas && <NavItem icon={<Bookmark />} label="Minhas Fórmulas" active={isTabActive('savedFormulas')} onClick={() => setActiveTab('savedFormulas')} collapsed={!isSidebarOpen} />}
                </div>}
              </>
          </nav>

          <div className="shrink-0 px-4 pb-3">
            {user.role !== 'employee' && (
              <NavItem icon={<Settings />} label="Administração" active={isTabActive('admin')} onClick={() => setActiveTab('admin')} collapsed={!isSidebarOpen} />
            )}
          </div>

          <div className="shrink-0 p-4" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            <div className={`ui-user flex items-center gap-3 p-2 rounded-lg ${isSidebarOpen ? '' : ''}`}
              style={{ background: 'rgba(255,255,255,0.07)' }}>
              <div className="w-[32px] h-[32px] rounded-full flex items-center justify-center shrink-0 cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.15)' }}
                onClick={() => !isSidebarOpen && setIsSidebarOpen(true)}
                title={!isSidebarOpen ? 'Clique para abrir o menu' : ''}>
                <UserIcon className="w-4 h-4 text-nav-muted" />
              </div>
              {isSidebarOpen && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{user.name}</p>
                  <p className="text-xs text-nav-muted">{USER_ROLE_LABELS[user.role]}</p>
                </div>
              )}
              {isSidebarOpen && (
                <button onClick={handleLogout} aria-label="Sair da conta"
                  className="ui-button ui-icon-button transition-colors text-nav-muted hover:text-surface">
                  <LogOut className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col min-w-0">
          <header className="ui-header bg-surface border-b border-line flex items-center justify-between px-8 shrink-0">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} aria-label={isSidebarOpen ? 'Recolher menu' : 'Expandir menu'} aria-expanded={isSidebarOpen} className="ui-button ui-icon-button text-muted hover:text-ink">
              <Menu className="w-6 h-6" />
            </button>

            <div className="flex items-center gap-4 flex-wrap justify-end">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setFontScale(Math.max(0.75, fontScale - 0.125))}
                  disabled={fontScale <= 0.75}
                  title="Diminuir fonte"
                  aria-label="Diminuir fonte"
                  className="ui-button ui-button-secondary w-11 h-11 rounded-lg font-bold text-surface disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"

                >
                  a&minus;
                </button>
                <button
                  onClick={() => setFontScale(Math.min(1.5, fontScale + 0.125))}
                  disabled={fontScale >= 1.5}
                  title="Aumentar fonte"
                  aria-label="Aumentar fonte"
                  className="ui-button ui-button-primary w-11 h-11 rounded-lg font-bold text-on-coral disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"

                >
                  A+
                </button>
              </div>
              <div className="ui-header-date text-sm text-muted text-right">
                {new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
            </div>
          </header>

          <div className="ui-content flex-1 overflow-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'dashboard' && <Dashboard user={user} onNavigate={setActiveTab} />}
              {activeTab === 'admin' && <AdminPanel user={user} />}
              {activeTab === 'recipe' && <RecipeForm user={user} template={templateFormula} onClearTemplate={() => setTemplateFormula(null)} onComplete={(dest) => { setTemplateFormula(null); setActiveTab(dest); }} />}
              {activeTab === 'formulaDetail' && viewingFormula && <RecipeForm user={user} formula={viewingFormula} initialLocked={!autoUnlockFormula} partialPaymentAmount={partialPaymentAmounts[viewingFormula.id] ?? ''} onPartialPaymentAmountChange={value => setPartialPaymentAmounts(current => value ? { ...current, [viewingFormula.id]: value } : Object.fromEntries(Object.entries(current).filter(([id]) => Number(id) !== viewingFormula.id)))} onComplete={(dest) => { setViewingFormula(null); setTemplateFormula(null); setAutoUnlockFormula(false); setActiveTab(dest); }} />}
              {activeTab === 'confirmedDetail' && viewingFormula && <RecipeForm user={user} formula={viewingFormula} confirmed partialPaymentAmount={partialPaymentAmounts[viewingFormula.id] ?? ''} onPartialPaymentAmountChange={value => setPartialPaymentAmounts(current => value ? { ...current, [viewingFormula.id]: value } : Object.fromEntries(Object.entries(current).filter(([id]) => Number(id) !== viewingFormula.id)))} onComplete={(dest) => { setViewingFormula(null); setTemplateFormula(null); setActiveTab('confirmed'); }} />}
              {activeTab === 'pending' && <FormulaList screenKey="pending" variant="pending" title="Fórmulas Pendentes" subtitle="Fórmulas pendentes aguardando confirmação" statuses={['pending']} onSelect={(f) => { setViewingFormula(f); setActiveTab('formulaDetail'); }} onConfirm={(f, reasons) => { if (reasons.length === 0) { setConfirmedStage('em_producao'); setActiveTab('confirmed'); } else { setViewingFormula(f); setMissingReasons(reasons); setMissingReasonsTarget('pending'); setActiveTab('formulaDetail'); } }} />}
              {activeTab === 'confirmed' && <>
                <div className="mb-5 flex gap-2 border-b border-line">
                  <button onClick={() => setConfirmedStage('em_producao')} className={`ui-button px-4 py-2.5 text-sm font-bold border-b-2 ${confirmedStage === 'em_producao' ? 'border-brand text-brand bg-sage' : 'border-transparent text-muted'}`}>Em produção</button>
                  <button onClick={() => setConfirmedStage('aguardando_retirada')} className={`ui-button px-4 py-2.5 text-sm font-bold border-b-2 ${confirmedStage === 'aguardando_retirada' ? 'border-brand text-brand bg-sage' : 'border-transparent text-muted'}`}>Aguardando retirada</button>
                </div>
                <FormulaList screenKey={`confirmed-${confirmedStage}`} variant="confirmed" statuses={['confirmed']} title={confirmedStage === 'em_producao' ? 'Fórmulas em produção' : 'Fórmulas aguardando retirada'} subtitle="Fórmulas confirmadas para manipulação" deliveryStatusFilter={confirmedStage} onSelect={(f) => { setViewingFormula(f); setActiveTab('confirmedDetail'); }} />
              </>}
              {activeTab === 'history' && <FormulaList screenKey="history" variant="confirmed" title="Histórico" subtitle="Fórmulas entregues" statuses={['delivered']} showAndamento={false} showVerification monthlySummary onSelect={(f) => { setViewingFormula(f); setActiveTab('historyDetail'); }} onRepeat={(f) => { setTemplateFormula(f); setActiveTab('recipe'); }} />}
              {activeTab === 'historyDetail' && viewingFormula && <RecipeForm user={user} formula={viewingFormula} readOnly partialPaymentAmount={partialPaymentAmounts[viewingFormula.id] ?? ''} onPartialPaymentAmountChange={value => setPartialPaymentAmounts(current => value ? { ...current, [viewingFormula.id]: value } : Object.fromEntries(Object.entries(current).filter(([id]) => Number(id) !== viewingFormula.id)))} onComplete={() => { setViewingFormula(null); setTemplateFormula(null); setActiveTab('history'); }} />}
              {activeTab === 'cancelled' && <FormulaList screenKey="cancelled" variant="pending" title="Fórmulas Canceladas" subtitle="Fórmulas canceladas com justificativa registrada" statuses={['cancelled']} onSelect={(f) => { setViewingFormula(f); setActiveTab('cancelledDetail'); }} />}
              {activeTab === 'cancelledDetail' && viewingFormula && <RecipeForm user={user} formula={viewingFormula} readOnly partialPaymentAmount={partialPaymentAmounts[viewingFormula.id] ?? ''} onPartialPaymentAmountChange={value => setPartialPaymentAmounts(current => value ? { ...current, [viewingFormula.id]: value } : Object.fromEntries(Object.entries(current).filter(([id]) => Number(id) !== viewingFormula.id)))} onComplete={() => { setViewingFormula(null); setActiveTab('cancelled'); }} />}
              {activeTab === 'customers' && <CustomerManager />}
              {activeTab === 'insumos' && <InsumoManager />}
              {activeTab === 'savedFormulas' && canViewSavedFormulas && <SavedFormulaManager />}
            </AnimatePresence>
          </div>
        </main>
      </div>

      {missingReasons && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={() => { setMissingReasons(null); setMissingReasonsTarget(null); }}
          onKeyDown={e => { if (e.key === 'Escape') { setMissingReasons(null); setMissingReasonsTarget(null); } }}>
          <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-danger-strong flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 className="font-bold text-ink text-lg">Informações necessárias</h3>
                <p className="text-xs text-muted">Preencha os campos abaixo para confirmar esta fórmula.</p>
              </div>
            </div>
            <ul className="space-y-2">
              {missingReasons.map(r => (
                <li key={r} className="flex items-center gap-2 text-sm text-ink">
                  <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                  {r}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => { setMissingReasons(null); setMissingReasonsTarget(null); }} autoFocus
                className="ui-button flex-1 py-2.5 rounded-xl border border-control-line font-semibold text-sm text-ink hover:bg-canvas transition-colors">
                Entendi
              </button>
              <button type="button" onClick={() => { const target = missingReasonsTarget; setMissingReasons(null); setMissingReasonsTarget(null); setAutoUnlockFormula(target === 'pending'); if (target === 'confirmed') setActiveTab('confirmedDetail'); }}
                className="ui-button ui-button-secondary flex-1 py-2.5 rounded-xl text-surface font-semibold text-sm hover:opacity-90 transition-all"
                >
                Editar
              </button>
            </div>
          </DialogSurface>
        </div>
      )}
      {exitModal}
    </>
  );
}

export default function App() {
  const isTenantRoute=/^\/t\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/|$)/.test(window.location.pathname);
  const isManagementRoute=window.location.pathname==='/management' || window.location.pathname==='/management/';
  return (
    <MotionConfig reducedMotion="user">
      {isTenantRoute ? <AuthProvider>
        <FormDraftProvider>
          <div className="h-screen overflow-hidden bg-canvas flex flex-col" onKeyDown={handleEnterAsTab}>
            <AppInner />
          </div>
        </FormDraftProvider>
      </AuthProvider> : isManagementRoute ? <PlatformManagement/> : <TenantSelector/>}
    </MotionConfig>
  );
}


