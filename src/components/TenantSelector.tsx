import { useEffect, useState } from 'react';
import { Building2, LoaderCircle, RotateCw } from 'lucide-react';

type TenantOption={slug:string;name:string;status:'active'|'suspended';invited:boolean};

export function TenantSelector() {
  const [tenants,setTenants]=useState<TenantOption[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const load=async()=>{
    setLoading(true);setError('');
    try {
      const response=await fetch('/api/platform/v1/tenants',{credentials:'same-origin',cache:'no-store'});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(payload?.error?.message ?? 'Não foi possível consultar suas farmácias.');
      setTenants(payload.data ?? []);
    } catch(cause) {setError(cause instanceof Error ? cause.message : 'Falha ao carregar suas farmácias.');}
    finally {setLoading(false);}
  };
  useEffect(()=>{void load();},[]);
  return <main className="min-h-screen bg-canvas px-5 py-12 text-ink">
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-8"><p className="text-sm font-semibold uppercase tracking-widest text-muted">MagisForm</p><h1 className="ui-page-title mt-2 text-3xl">Suas farmácias</h1><p className="mt-2 text-muted">Acesse uma instalação vinculada à sua identidade Cloudflare.</p></header>
      {loading && <div className="flex items-center gap-2 text-muted"><LoaderCircle className="h-5 w-5 animate-spin"/> Consultando acesso...</div>}
      {error && <div className="ui-panel flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-5"><p className="text-sm">{error}</p><button className="ui-button ui-button-secondary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm" onClick={()=>void load()}><RotateCw className="h-4 w-4"/> Tentar novamente</button></div>}
      {!loading && !error && tenants.length===0 && <section className="ui-panel rounded-xl border border-line bg-surface p-6"><h2 className="font-semibold">Nenhuma farmácia vinculada</h2><p className="mt-2 text-sm text-muted">Peça a um administrador da farmácia que envie um convite para o e-mail autorizado no Cloudflare Access.</p></section>}
      {!loading && !error && tenants.length>0 && <ul className="grid gap-3">{tenants.map(tenant=><li key={tenant.slug}><button disabled={tenant.status!=='active'} onClick={()=>window.location.assign(`/t/${encodeURIComponent(tenant.slug)}/`)} className="ui-panel flex w-full items-center gap-4 rounded-xl border border-line bg-surface p-5 text-left transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"><span className="rounded-xl bg-sage p-3"><Building2 className="h-5 w-5 text-brand"/></span><span className="flex-1"><strong className="block">{tenant.name}</strong><span className="text-sm text-muted">{tenant.invited?'Convite pendente':tenant.status==='active'?'Acessar farmácia':'Instalação suspensa'}</span></span></button></li>)}</ul>}
    </div>
  </main>;
}
