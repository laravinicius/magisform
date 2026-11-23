import React, { useState } from 'react';
import { Building2, UserPlus } from 'lucide-react';
import { db } from '../services/lanDatabase';
import { useData } from '../hooks/useData';
import { ErrorState, LoadingState } from './Feedback';

const field = 'ui-field w-full px-3 py-2 rounded-lg border border-control-line bg-surface';
const label = 'block text-xs font-semibold text-muted uppercase mb-1';
const secondary = 'ui-button ui-button-secondary px-4 py-2 rounded-lg font-semibold text-sm';

export function PartnerManager() {
  const { data: pharmacies, loading, error, reload } = useData('partner-pharmacies', activity => db.partners.list(activity));
  const [name, setName] = useState('');
  const [pharmacyId, setPharmacyId] = useState('');
  const [userName, setUserName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetUser, setResetUser] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setFailure(''); setMessage('');
    try { await operation(); setMessage(success); await reload(); }
    catch (err) { setFailure(err instanceof Error ? err.message : 'Não foi possível concluir a operação.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6 max-w-6xl">
    <div><h2 className="ui-page-title text-3xl text-ink">Farmácias clientes</h2><p className="text-muted">Cadastre as farmácias e os usuários que poderão enviar pedidos.</p></div>
    {message && <p role="status" className="bg-sage text-brand p-3 rounded-lg">{message}</p>}{failure && <p role="alert" className="bg-danger-soft text-danger p-3 rounded-lg">{failure}</p>}
    <div className="grid gap-5 lg:grid-cols-2">
      <form className="ui-panel p-5 rounded-2xl space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { await db.partners.add(name.trim()); setName(''); }, 'Farmácia cadastrada.'); }}>
        <h3 className="font-semibold text-ink"><Building2 size={18} className="inline mr-2" />Nova farmácia</h3>
        <div><label htmlFor="partner-name" className={label}>Nome da farmácia</label><input id="partner-name" className={field} required maxLength={255} value={name} onChange={e => setName(e.target.value)} /></div>
        <button className="ui-button ui-button-primary px-4 py-2 rounded-lg font-semibold" disabled={busy}>Cadastrar farmácia</button>
      </form>
      <form className="ui-panel p-5 rounded-2xl space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { await db.partners.addUser(Number(pharmacyId), { name: userName.trim(), username: username.trim(), password }); setUserName(''); setUsername(''); setPassword(''); }, 'Acesso criado para a farmácia.'); }}>
        <h3 className="font-semibold text-ink"><UserPlus size={18} className="inline mr-2" />Novo acesso</h3>
        <div><label htmlFor="partner-user-pharmacy" className={label}>Farmácia</label><select id="partner-user-pharmacy" required className={field} value={pharmacyId} onChange={e => setPharmacyId(e.target.value)}><option value="">Selecione</option>{pharmacies?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="partner-user-name" className={label}>Nome</label><input id="partner-user-name" required maxLength={255} className={field} value={userName} onChange={e => setUserName(e.target.value)} /></div><div><label htmlFor="partner-user-login" className={label}>Usuário</label><input id="partner-user-login" required maxLength={50} autoComplete="off" className={field} value={username} onChange={e => setUsername(e.target.value)} /></div></div>
        <div><label htmlFor="partner-user-password" className={label}>Senha inicial</label><input id="partner-user-password" type="password" required minLength={8} maxLength={255} autoComplete="new-password" className={field} value={password} onChange={e => setPassword(e.target.value)} /><p className="text-xs text-muted mt-1">Mínimo de 8 caracteres.</p></div>
        <button className="ui-button ui-button-primary px-4 py-2 rounded-lg font-semibold" disabled={busy || !pharmacyId}>Criar acesso</button>
      </form>
    </div>
    {loading && <LoadingState />}{error && <ErrorState message={error} onRetry={() => void reload()} />}
    {!loading && !error && <div className="space-y-4">{pharmacies?.map(pharmacy => <section key={pharmacy.id} className="ui-panel p-5 rounded-2xl space-y-3"><h3 className="font-semibold text-lg text-ink">{pharmacy.name}</h3>{pharmacy.users.length === 0 && <p className="text-sm text-muted">Nenhum acesso cadastrado.</p>}{pharmacy.users.map(user => <div key={user.id} className="border-t border-line pt-3 space-y-2"><div className="flex flex-wrap justify-between gap-3 items-center"><div><p className="font-medium">{user.name}</p><p className="text-sm text-muted">{user.username} · {user.active ? 'Ativo' : 'Desativado'}</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={secondary} onClick={() => { setResetUser(resetUser === user.id ? null : user.id); setResetPassword(''); }}>Alterar senha</button><button type="button" disabled={busy} className={secondary} onClick={() => void run(() => db.partners.updateUser(user.id, { active: !user.active }), user.active ? 'Acesso desativado.' : 'Acesso ativado.')}>{user.active ? 'Desativar' : 'Ativar'}</button></div></div>{resetUser === user.id && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { await db.partners.updateUser(user.id, { password: resetPassword }); setResetUser(null); setResetPassword(''); }, 'Senha alterada e sessão encerrada.'); }}><div><label className={label} htmlFor={`partner-reset-${user.id}`}>Nova senha</label><input id={`partner-reset-${user.id}`} type="password" autoComplete="new-password" minLength={8} required className={field} value={resetPassword} onChange={e => setResetPassword(e.target.value)} /></div><button disabled={busy} className={secondary}>Salvar senha</button></form>}</div>)}</section>)}{pharmacies?.length === 0 && <p className="text-muted">Nenhuma farmácia cadastrada.</p>}</div>}
  </div>;
}
