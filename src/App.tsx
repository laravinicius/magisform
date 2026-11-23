import { DialogSurface } from './components/DialogSurface';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Cross, User as UserIcon, PlusCircle, LogOut, Menu, Settings, AlertCircle,
  AlertTriangle, ClipboardList, Building2,
} from 'lucide-react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { db } from './services/lanDatabase';
import { USER_ROLE_LABELS } from './types';
import { BrandLogo } from './components/Logo';
import { COLORS } from '../config/branding';
import { NavItem } from './components/NavItem';
import { AdminPanel } from './components/UserManager';
import { InsumoManager } from './components/InsumoManager';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FormDraftProvider, useFormDraft } from './context/FormDraftContext';
import { handleDialogArrowNavigation, handleEnterAsTab } from './utils/enterNavigation';
import { TenantSelector } from './components/TenantSelector';
import { PlatformManagement } from './components/PlatformManagement';
import { OrdersWorkspace } from './components/OrdersWorkspace';
import { PartnerManager } from './components/PartnerManager';

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
  const isPartner = user?.pharmacy_id != null;
  const [authReady, setAuthReady] = useState(false);
  const [loginConflict, setLoginConflict] = useState(false);
  const [activeTab, setActiveTab] = useState<'orders' | 'newOrder' | 'pharmacies' | 'insumos' | 'admin'>('orders');
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 900);
  const [loginError, setLoginError] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem('magisform.fontScale')) || 1);
  const canManage = user?.role === 'pharmacist' || user?.role === 'admin' || user?.role === 'manager';

  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInactivityLogoutRef = useRef<() => Promise<void>>();
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

  const handleInactivityLogout = useCallback(async () => {
    await db.auth.logout().catch(() => {});
    clearDrafts();
    clearAuth();
    setActiveTab('orders');
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
    clearDrafts(); clearAuth();
    setLoginError('Sua sessão expirou ou foi encerrada em outro dispositivo. Entre novamente.');
  }), [clearAuth, clearDrafts]);

  const doLogin = async (force: boolean) => {
    setLoginLoading(true); setLoginError('');
    try {
      const res = await db.auth.login(force, { username: loginUsername.trim(), password: loginPassword });
      if (res.success) {
        clearDrafts();
        setAuth(res.user);

        setActiveTab('orders');
        setLoginPassword('');
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
    setActiveTab('orders');
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
      try {
        const { valid } = await db.auth.heartbeat();
        if (!valid) {
          clearDrafts();
          clearAuth();
          setLoginError('Sua sessão foi encerrada em outro dispositivo.');
        }
      } catch {
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
            <p className="text-muted text-sm mt-2">Entre para acessar o MagisForm</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
              <>
                <div><label htmlFor="login-username" className="block text-sm font-semibold text-ink mb-1">Usuário</label><input id="login-username" required autoComplete="username" className="ui-field w-full px-3 py-2 rounded-lg" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} /></div>
                <div><label htmlFor="login-password" className="block text-sm font-semibold text-ink mb-1">Senha</label><input id="login-password" type="password" required autoComplete="current-password" className="ui-field w-full px-3 py-2 rounded-lg" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} /></div>
              </>
              {loginError && (
                <div className="flex items-center gap-2 text-danger text-sm bg-danger-soft px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 shrink-0" />{loginError}
                </div>
              )}
              <button type="submit" disabled={loginLoading}
                className="ui-button ui-button-primary ui-popover w-full hover:opacity-90 disabled:opacity-60 text-on-coral font-semibold py-2.5 rounded-lg transition-all  "

              >
                {loginLoading ? 'Conectando...' : 'Entrar'}
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

        {/* Sidebar */}
        <aside data-collapsed={!isSidebarOpen} className={`ui-sidebar border-r border-line ${isSidebarOpen ? 'w-[256px]' : 'w-[80px]'} flex flex-col shrink-0 h-full overflow-hidden`}
          style={{ background: COLORS.secondary }}>
          <div className="p-5 w-full">
            <BrandLogo size={isSidebarOpen ? 'sidebar' : 'icon'} />
          </div>

          <nav className="flex-1 min-h-0 overflow-y-auto px-4 space-y-1">
            {isPartner ? <>
              <NavItem icon={<ClipboardList />} label="Meus pedidos" active={activeTab === 'orders'} onClick={() => setActiveTab('orders')} collapsed={!isSidebarOpen} />
              <NavItem icon={<PlusCircle />} label="Novo pedido" active={activeTab === 'newOrder'} onClick={() => setActiveTab('newOrder')} collapsed={!isSidebarOpen} />
            </> : <>
              <NavItem icon={<ClipboardList />} label="Pedidos recebidos" active={activeTab === 'orders'} onClick={() => setActiveTab('orders')} collapsed={!isSidebarOpen} />
              {canManage && <NavItem icon={<Building2 />} label="Farmácias clientes" active={activeTab === 'pharmacies'} onClick={() => setActiveTab('pharmacies')} collapsed={!isSidebarOpen} />}
              <NavItem icon={<Cross />} label="Insumos" active={activeTab === 'insumos'} onClick={() => setActiveTab('insumos')} collapsed={!isSidebarOpen} />
            </>}
          </nav>

          <div className="shrink-0 px-4 pb-3">
            {!isPartner && user.role !== 'employee' && (
              <NavItem icon={<Settings />} label="Administração" active={activeTab === 'admin'} onClick={() => setActiveTab('admin')} collapsed={!isSidebarOpen} />
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
                  <p className="text-xs text-nav-muted">{isPartner ? user.pharmacy_name : USER_ROLE_LABELS[user.role]}</p>
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
              {(activeTab === 'orders' || activeTab === 'newOrder') && <OrdersWorkspace pharmacyId={user.pharmacy_id} userName={user.name} startNew={isPartner && activeTab === 'newOrder'} onList={() => setActiveTab('orders')} />}
              {!isPartner && activeTab === 'pharmacies' && canManage && <PartnerManager />}
              {!isPartner && activeTab === 'insumos' && <InsumoManager />}
              {!isPartner && activeTab === 'admin' && canManage && <AdminPanel user={user} />}
            </AnimatePresence>
          </div>
        </main>
      </div>

      {exitModal}
    </>
  );
}

export default function App() {
  const isTenantRoute=/^\/t\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/|$)/.test(window.location.pathname);
  const isManagementRoute=window.location.pathname==='/management' || window.location.pathname==='/management/';
  const [rootRuntime, setRootRuntime] = useState<'loading' | 'web' | 'platform'>(isTenantRoute || isManagementRoute ? 'platform' : 'loading');
  useEffect(() => {
    if (isTenantRoute || isManagementRoute) return;
    let active = true;
    void fetch('/api/v1/public-config', { credentials: 'same-origin' }).then(async response => {
      const payload = response.ok ? await response.json() : null;
      if (active) setRootRuntime(payload?.data?.capabilities?.includes('web') ? 'web' : 'platform');
    }).catch(() => { if (active) setRootRuntime('platform'); });
    return () => { active = false; };
  }, [isTenantRoute, isManagementRoute]);
  return (
    <MotionConfig reducedMotion="user">
      {isTenantRoute ? <div className="p-8 text-muted">O piloto Cloudflare ainda não oferece o novo fluxo de pedidos.</div> : rootRuntime === 'web' ? <AuthProvider>
        <FormDraftProvider>
          <div className="h-screen overflow-hidden bg-canvas flex flex-col" onKeyDown={handleEnterAsTab}>
            <AppInner />
          </div>
        </FormDraftProvider>
      </AuthProvider> : isManagementRoute ? <PlatformManagement/> : rootRuntime === 'loading' ? <div className="p-8 text-muted">Carregando...</div> : <TenantSelector/>}
    </MotionConfig>
  );
}


