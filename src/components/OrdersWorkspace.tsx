import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardList, Plus, Trash2 } from 'lucide-react';
import type { OrderDataDto, OrderDto, OrderEventDto, OrderStatus, PartnerPatientDto } from '../../shared/contracts';
import { db } from '../services/lanDatabase';
import { useData } from '../hooks/useData';
import { useFormDraft } from '../context/FormDraftContext';
import { ErrorState, LoadingState } from './Feedback';
import { BUDGET_UNITS, INGREDIENT_UNITS, UnitCycle } from './UnitCycle';

const statusLabels: Record<OrderStatus, string> = {
  submitted: 'Enviado', under_review: 'Em análise', awaiting_approval: 'Aguardando aprovação', accepted: 'Aceito',
};
const eventLabels: Record<OrderEventDto['action'], string> = {
  submitted: 'Pedido enviado', imported: 'Pedido registrado anteriormente', reviewed: 'Pedido em análise', accepted: 'Pedido aceito',
  proposed: 'Alteração proposta', approved: 'Alteração aprovada', rejected: 'Alteração rejeitada',
};
const fieldClass = 'ui-field w-full px-3 py-2 rounded-lg border border-control-line bg-surface';
const labelClass = 'block text-xs font-semibold text-muted uppercase mb-1';
const buttonClass = 'ui-button ui-button-secondary px-4 py-2 rounded-lg font-semibold text-sm';
const emptyOrder = (attendant: string): OrderDataDto => ({
  patient_name: '', patient_phone: '', attendant_name: attendant,
  items: [{ name: '', quantity: 0, unit: 'mg' }], budget_number: '', budget_items: [], delivery_date: null,
});
const dateLabel = (date: string) => new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function DecimalInput({ id, value, onChange, places, allowZero = false }: { id: string; value: number; onChange: (value: number) => void; places: number; allowZero?: boolean }) {
  const format = (number: number) => number || allowZero ? String(number).replace('.', ',') : '';
  const [text, setText] = useState(() => format(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(format(value)); }, [value, focused, allowZero]);
  return <input id={id} type="text" inputMode="decimal" required maxLength={16} pattern={`[0-9]+([,.][0-9]{1,${places}})?`} className={fieldClass} value={text}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    onChange={event => {
      const next = event.target.value;
      if (!new RegExp(`^\\d*(?:[,.]\\d{0,${places}})?$`).test(next)) return;
      setText(next);
      onChange(Number(next.replace(',', '.')) || 0);
    }} />;
}

function OrderContents({ data }: { data: OrderDataDto }) {
  return <div className="space-y-3 text-sm text-ink">
    <p><span className="text-muted">Paciente:</span> <strong>{data.patient_name}</strong>{data.patient_phone && ` · ${data.patient_phone}`}</p>
    <p><span className="text-muted">Atendente:</span> {data.attendant_name}</p>
    <div><p className="text-muted mb-1">Composição</p><ul className="list-disc pl-5 space-y-1">{data.items.map((item, index) => <li key={index}>{item.name} — {item.quantity.toLocaleString('pt-BR')} {item.unit}</li>)}</ul></div>
    <p><span className="text-muted">Orçamento:</span> {data.budget_number || 'Não informado'}</p>
    {data.budget_items.length > 0 && <ul className="list-disc pl-5">{data.budget_items.map((item, index) => <li key={index}>{Number(item.quantity).toLocaleString('pt-BR')} {item.unit} · {Number(item.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}{item.is_selected ? ' · selecionado' : ''}</li>)}</ul>}
    <p><span className="text-muted">Previsão de entrega:</span> {data.delivery_date ? data.delivery_date.split('-').reverse().join('/') : 'Não informada'}</p>
  </div>;
}

function OrderEditor({ initial, attendant, isPartner, draftKey, onCancel, onSubmit }: {
  initial?: OrderDataDto; attendant: string; isPartner: boolean; draftKey: string; onCancel: () => void; onSubmit: (data: OrderDataDto, note: string) => Promise<void>;
}) {
  const { getDraft, saveDraft, removeDraft } = useFormDraft();
  const [data, setData] = useState<OrderDataDto>(() => getDraft<{ data: OrderDataDto }>(draftKey)?.data || initial || emptyOrder(attendant));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState(() => getDraft<{ note?: string }>(draftKey)?.note || '');
  const [patients, setPatients] = useState<PartnerPatientDto[]>([]);
  const { data: insumos, loading: catalogLoading, error: catalogError, reload: reloadCatalog } = useData('order-insumos', db.orders.insumos);
  const catalogNames = new Set(insumos?.map(item => item.name));
  const catalogUnavailable = catalogLoading || !!catalogError;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; if (isPartner) void db.orders.patients().then(v => { if (active) setPatients(v); }).catch(() => {}); return () => { active = false; }; }, [isPartner]);
  useEffect(() => { if (dirty) saveDraft(draftKey, { data, note }); }, [data, note, dirty, draftKey, saveDraft]);
  const update = (value: OrderDataDto) => { setDirty(true); setData(value); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (catalogUnavailable) return;
    if (!data.items.length || data.items.some(item => !item.name || item.quantity <= 0 || item.quantity > 9999999)) { setError('Selecione um insumo e informe uma quantidade válida em cada linha.'); return; }
    if (isPartner && data.items.some(item => !catalogNames.has(item.name))) { setError('Selecione apenas insumos cadastrados no catálogo.'); return; }
    if (data.budget_items.some(item => item.quantity <= 0 || item.quantity > 9999999 || item.value < 0 || item.value > 99999999)) { setError('Confira a quantidade e o valor dos itens do orçamento.'); return; }
    setSaving(true);
    try {
      await onSubmit({ ...data, patient_name: data.patient_name.trim(), patient_phone: data.patient_phone.trim(), attendant_name: data.attendant_name.trim(), items: data.items.map(item => ({ ...item, name: item.name.trim() })) }, note.trim());
      if (draftKey) removeDraft(draftKey);
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível salvar o pedido.'); }
    finally { setSaving(false); }
  };
  return <form onSubmit={submit} className="space-y-5 max-w-5xl">
    <div><h2 className="ui-page-title text-3xl text-ink">{isPartner ? 'Novo pedido' : 'Propor alteração'}</h2><p className="text-muted">{isPartner ? 'Preencha a fórmula para enviar à manipulação.' : 'A farmácia precisará aprovar todas as alterações.'}</p></div>
    <section className="ui-panel p-5 rounded-2xl space-y-4"><h3 className="font-semibold text-ink">1. Paciente</h3>
      {patients.length > 0 && <div><label className={labelClass} htmlFor="order-patient-select">Paciente já cadastrado</label><select id="order-patient-select" className={fieldClass} defaultValue="" onChange={e => { const p = patients.find(item => item.id === Number(e.target.value)); if (p) update({ ...data, patient_name: p.name, patient_phone: p.phone }); }}><option value="">Selecionar ou preencher abaixo</option>{patients.map(p => <option key={p.id} value={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</option>)}</select></div>}
      <div className="grid gap-4 md:grid-cols-2"><div><label className={labelClass} htmlFor="order-patient-name">Nome do paciente</label><input id="order-patient-name" required maxLength={255} className={fieldClass} value={data.patient_name} onChange={e => update({ ...data, patient_name: e.target.value })} /></div><div><label className={labelClass} htmlFor="order-patient-phone">Telefone</label><input id="order-patient-phone" type="tel" maxLength={30} className={fieldClass} value={data.patient_phone} onChange={e => update({ ...data, patient_phone: e.target.value })} /></div></div>
    </section>
    <section className="ui-panel p-5 rounded-2xl space-y-4"><h3 className="font-semibold text-ink">2. Composição da fórmula</h3>
      {catalogLoading && <p role="status" className="text-sm text-muted">Carregando catálogo de insumos...</p>}
      {catalogError && <p role="alert" className="text-sm text-danger">Não foi possível carregar o catálogo. <button type="button" className="underline" onClick={() => void reloadCatalog().catch(() => {})}>Tentar novamente</button></p>}
      {!catalogUnavailable && insumos?.length === 0 && <p className="text-sm text-muted">Nenhum insumo cadastrado no catálogo.</p>}
      {data.items.map((item, index) => <div key={index} className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_120px_auto] items-end border-b border-line pb-4">
        <div className="min-w-0">
          <label className={labelClass} htmlFor={`order-item-name-${index}`}>Insumo {index + 1}</label>
          <select id={`order-item-name-${index}`} required disabled={catalogUnavailable} className={fieldClass}
            value={isPartner && !catalogNames.has(item.name) ? '' : item.name}
            onChange={e => update({ ...data, items: data.items.map((v, i) => i === index ? { ...v, name: e.target.value } : v) })}>
            <option value="" disabled>Selecione no catálogo</option>
            {!isPartner && item.name && !catalogNames.has(item.name) && <option value={item.name} disabled>{item.name} (fora do catálogo)</option>}
            {insumos?.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
          </select>
        </div>
        <div><label className={labelClass} htmlFor={`order-item-qty-${index}`}>Quantidade</label><DecimalInput id={`order-item-qty-${index}`} places={3} value={item.quantity} onChange={quantity => update({ ...data, items: data.items.map((v, i) => i === index ? { ...v, quantity } : v) })} /></div>
        <div><span className={labelClass}>Unidade</span><UnitCycle value={item.unit} options={INGREDIENT_UNITS} onChange={unit => update({ ...data, items: data.items.map((v, i) => i === index ? { ...v, unit } : v) })} /></div>
        <button type="button" disabled={data.items.length === 1} onClick={() => update({ ...data, items: data.items.filter((_, i) => i !== index) })} aria-label={`Remover insumo ${index + 1}`} className="ui-button ui-icon-button p-2 text-muted disabled:opacity-40"><Trash2 size={18} /></button>
      </div>)}
      <button type="button" className={buttonClass} onClick={() => update({ ...data, items: [...data.items, { name: '', quantity: 0, unit: 'mg' }] })}><Plus size={16} className="inline mr-1" />Adicionar insumo</button>
    </section>
    <section className="ui-panel p-5 rounded-2xl space-y-4"><h3 className="font-semibold text-ink">3. Orçamento</h3>
      <div className="max-w-xs"><label className={labelClass} htmlFor="order-budget-number">Número do orçamento</label><input id="order-budget-number" maxLength={20} className={fieldClass} value={data.budget_number} onChange={e => update({ ...data, budget_number: e.target.value })} /></div>
      {data.budget_items.map((item, index) => <div key={index} className="grid gap-3 sm:grid-cols-[1fr_130px_1fr_auto_auto] items-end">
        <div><label className={labelClass} htmlFor={`order-budget-qty-${index}`}>Quantidade</label><DecimalInput id={`order-budget-qty-${index}`} places={3} value={item.quantity} onChange={quantity => update({ ...data, budget_items: data.budget_items.map((v, i) => i === index ? { ...v, quantity } : v) })} /></div>
        <div><span className={labelClass}>Unidade</span><UnitCycle value={item.unit} options={BUDGET_UNITS} onChange={unit => update({ ...data, budget_items: data.budget_items.map((v, i) => i === index ? { ...v, unit } : v) })} /></div>
        <div><label className={labelClass} htmlFor={`order-budget-value-${index}`}>Valor (R$)</label><DecimalInput id={`order-budget-value-${index}`} places={2} allowZero value={item.value} onChange={value => update({ ...data, budget_items: data.budget_items.map((v, i) => i === index ? { ...v, value } : v) })} /></div>
        <label className="text-sm flex items-center gap-2 py-2"><input type="radio" name="selected-budget" checked={!!item.is_selected} onChange={() => update({ ...data, budget_items: data.budget_items.map((v, i) => ({ ...v, is_selected: i === index })) })} /> Selecionar</label>
        <button type="button" onClick={() => update({ ...data, budget_items: data.budget_items.filter((_, i) => i !== index) })} aria-label={`Remover orçamento ${index + 1}`} className="ui-button ui-icon-button p-2 text-muted"><Trash2 size={18} /></button>
      </div>)}
      <button type="button" className={buttonClass} onClick={() => update({ ...data, budget_items: [...data.budget_items, { quantity: 0, unit: 'caps', value: 0, is_selected: false }] })}><Plus size={16} className="inline mr-1" />Adicionar opção de orçamento</button>
    </section>
    <section className="ui-panel p-5 rounded-2xl space-y-4"><h3 className="font-semibold text-ink">4. Informações</h3><div className="grid gap-4 md:grid-cols-2"><div><label className={labelClass} htmlFor="order-attendant">Atendente</label><input id="order-attendant" required maxLength={255} className={fieldClass} value={data.attendant_name} onChange={e => update({ ...data, attendant_name: e.target.value })} /></div><div><label className={labelClass} htmlFor="order-date">Previsão de entrega</label><input id="order-date" type="date" className={fieldClass} value={data.delivery_date ?? ''} onChange={e => update({ ...data, delivery_date: e.target.value || null })} /></div></div>
      {!isPartner && <div><label className={labelClass} htmlFor="order-note">Observação para a farmácia</label><textarea id="order-note" maxLength={2000} rows={3} className={fieldClass} value={note} onChange={e => { setDirty(true); setNote(e.target.value); }} /></div>}
    </section>
    {error && <p role="alert" className="text-danger bg-danger-soft p-3 rounded-lg">{error}</p>}
    <div className="flex flex-wrap gap-3"><button type="submit" disabled={saving || catalogUnavailable} className="ui-button ui-button-primary px-5 py-3 rounded-lg font-semibold disabled:opacity-50">{saving ? 'Enviando...' : isPartner ? 'Enviar pedido' : 'Enviar proposta para aprovação'}</button><button type="button" onClick={onCancel} disabled={saving} className={buttonClass}>Voltar</button></div>
  </form>;
}

export function OrdersWorkspace({ pharmacyId, userName, startNew = false, onList }: { pharmacyId?: number | null; userName: string; startNew?: boolean; onList: () => void }) {
  const isPartner = pharmacyId != null;
  const { data: orders, loading, error, reload } = useData('orders', activity => db.orders.list(activity));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<OrderDto | null>(null);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setSelectedId(null); setSelected(null); setEditing(false); }, [startNew]);
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void reload(true, 'passive').catch(() => {});
      if (selectedId !== null && !editing) void db.orders.get(selectedId, 'passive').then(updated => { if (!cancelled) setSelected(previous => previous?.id === updated.id && previous.revision !== updated.revision ? updated : previous); }).catch(() => {});
    }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [reload, selectedId, editing]);
  const open = async (id: number) => {
    setSelectedId(id); setSelected(null); setDetailError('');
    try { setSelected(await db.orders.get(id)); } catch (err) { setDetailError(err instanceof Error ? err.message : 'Não foi possível abrir o pedido.'); }
  };
  const transition = async (action: 'review' | 'accept' | 'approve' | 'reject') => {
    if (!selected) return;
    setBusy(true); setDetailError('');
    try { await db.orders.transition(selected.id, action, selected.revision, note); setNote(''); await open(selected.id); await reload(); }
    catch (err) { setDetailError(err instanceof Error ? err.message : 'Não foi possível atualizar o pedido.'); }
    finally { setBusy(false); }
  };
  if (startNew && isPartner) return <OrderEditor attendant={userName} isPartner draftKey="partner-order-new" onCancel={onList} onSubmit={async data => { await db.orders.add(data); setNotice('Pedido enviado para a manipulação.'); onList(); }} />;
  if (editing && selected && !isPartner) return <OrderEditor initial={selected.current_data} attendant={userName} isPartner={false} draftKey={`order-proposal-${selected.id}-${selected.revision}`} onCancel={() => setEditing(false)} onSubmit={async (data, proposalNote) => { await db.orders.propose(selected.id, selected.revision, data, proposalNote); setEditing(false); await open(selected.id); await reload(); }} />;
  if (selectedId !== null) return <div className="space-y-5 max-w-6xl">
    <button type="button" className={buttonClass} onClick={() => { setSelectedId(null); setSelected(null); setDetailError(''); }}><ArrowLeft size={16} className="inline mr-2" />Voltar aos pedidos</button>
    {detailError && <div role="alert" className="text-danger bg-danger-soft p-3 rounded-lg">{detailError} <button type="button" className="underline" onClick={() => void open(selectedId)}>Recarregar pedido</button></div>}
    {!selected && !detailError && <LoadingState label="Carregando pedido..." />}
    {selected && <>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="ui-page-title text-3xl text-ink">Pedido #{selected.id}</h2><p className="text-muted">{selected.pharmacy_name} · {dateLabel(selected.created_at)}</p></div><span className="rounded-full bg-sage px-3 py-1 text-sm font-semibold text-brand">{statusLabels[selected.status]}</span></div>
      <div className={`grid gap-4 ${selected.proposed_data ? 'lg:grid-cols-2' : ''}`}><section className="ui-panel p-5 rounded-2xl"><h3 className="font-semibold mb-4">{selected.proposed_data ? 'Dados atuais' : 'Dados do pedido'}</h3><OrderContents data={selected.current_data} /></section>{selected.proposed_data && <section className="ui-panel p-5 rounded-2xl border border-brand"><h3 className="font-semibold mb-4">Alterações propostas</h3><OrderContents data={selected.proposed_data} /></section>}</div>
      {!isPartner && ['submitted', 'under_review'].includes(selected.status) && <section className="ui-panel p-5 rounded-2xl space-y-3"><h3 className="font-semibold">Atendimento</h3><p className="text-sm text-muted">Aceite como está ou proponha uma alteração para a farmácia avaliar.</p><div className="flex flex-wrap gap-3">{selected.status === 'submitted' && <button type="button" disabled={busy} className={buttonClass} onClick={() => void transition('review')}>Marcar em análise</button>}<button type="button" disabled={busy} className="ui-button ui-button-primary px-4 py-2 rounded-lg font-semibold" onClick={() => void transition('accept')}><CheckCircle2 size={16} className="inline mr-1" />Aceitar pedido</button><button type="button" disabled={busy} className={buttonClass} onClick={() => setEditing(true)}>Propor alteração</button></div></section>}
      {isPartner && selected.status === 'awaiting_approval' && <section className="ui-panel p-5 rounded-2xl space-y-3"><h3 className="font-semibold">Avaliar alteração</h3><p className="text-sm text-muted">Confira os dados propostos antes de aprovar. Ao rejeitar, o pedido volta para análise da manipulação.</p><label className={labelClass} htmlFor="order-decision-note">Observação (opcional)</label><textarea id="order-decision-note" className={fieldClass} rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /><div className="flex flex-wrap gap-3"><button type="button" disabled={busy} className="ui-button ui-button-primary px-4 py-2 rounded-lg font-semibold" onClick={() => void transition('approve')}>Aprovar alteração</button><button type="button" disabled={busy} className={buttonClass} onClick={() => void transition('reject')}>Rejeitar alteração</button></div></section>}
      <section className="ui-panel p-5 rounded-2xl"><h3 className="font-semibold mb-4">Histórico do pedido</h3><ol className="space-y-4">{selected.events.map(event => <li key={event.id} className="border-l-2 border-line pl-4"><p className="font-semibold text-sm">{eventLabels[event.action]}</p><p className="text-xs text-muted">{event.actor_name} · {dateLabel(event.created_at)}</p>{event.note && <p className="text-sm mt-2 whitespace-pre-wrap">{event.note}</p>}{event.snapshot && <details className="mt-2"><summary className="cursor-pointer text-sm text-brand">Ver dados registrados</summary><div className="mt-3"><OrderContents data={event.snapshot} /></div></details>}</li>)}</ol></section>
    </>}
  </div>;
  const filtered = (orders ?? []).filter(order => `${order.id} ${order.pharmacy_name} ${order.current_data.patient_name}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  return <div className="space-y-5">
    <div className="flex flex-wrap justify-between gap-4"><div><h2 className="ui-page-title text-3xl text-ink">{isPartner ? 'Meus pedidos' : 'Pedidos recebidos'}</h2><p className="text-muted">{isPartner ? 'Acompanhe as solicitações enviadas à manipulação.' : 'Acompanhe e atenda as solicitações das farmácias.'}</p></div></div>
    {notice && <p role="status" className="bg-sage text-brand rounded-lg p-3">{notice}</p>}
    <div className="max-w-md"><label className={labelClass} htmlFor="order-search">Buscar pedido ou paciente</label><input id="order-search" className={fieldClass} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {loading && <LoadingState />}{error && <ErrorState message={error} onRetry={() => void reload()} />}
    {!loading && !error && <div className="ui-panel overflow-x-auto rounded-2xl"><table className="ui-table w-full text-left"><thead><tr className="text-xs uppercase text-muted border-b border-line"><th className="p-4">Pedido</th>{!isPartner && <th className="p-4">Farmácia</th>}<th className="p-4">Paciente</th><th className="p-4">Data</th><th className="p-4">Situação</th><th className="p-4"><span className="sr-only">Ação</span></th></tr></thead><tbody>{filtered.map(order => <tr key={order.id} className="border-b border-line"><td className="p-4 font-semibold">#{order.id}</td>{!isPartner && <td className="p-4">{order.pharmacy_name}</td>}<td className="p-4">{order.current_data.patient_name}</td><td className="p-4 whitespace-nowrap">{dateLabel(order.created_at)}</td><td className="p-4"><span className="rounded-full bg-sage px-2 py-1 text-sm text-brand">{statusLabels[order.status]}</span></td><td className="p-4"><button type="button" className={buttonClass} onClick={() => void open(order.id)}>Abrir</button></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="py-12 text-center text-muted"><ClipboardList size={28} className="mx-auto mb-2" />Nenhum pedido encontrado.</div>}</div>}
  </div>;
}
