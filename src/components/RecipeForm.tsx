import { DialogSurface } from './DialogSurface';
import React, { useState, useEffect, useRef } from 'react';
import {
  Users, Search, X, PlusCircle, RefreshCw, Trash2, AlertCircle, Calendar, ClipboardList, Bookmark, Save, Check, Phone,
} from 'lucide-react';
import { COLORS } from '../../config/branding';
import { motion } from 'motion/react';
import { db } from '../services/lanDatabase';
import { User, Customer, Insumo, Formula, FormulaItem, BudgetItem, SavedFormula } from '../types';
import { formatCurrency, parseCurrency, currencyCaretPosition, formatDateBR, parseDateBR, formatDateToBR, stripDiacritics, formatQuantity, formatQuantityInput, parseQuantity, formatUnit } from '../utils/format';
import { handleDialogArrowNavigation } from '../utils/enterNavigation';
import { useData } from '../hooks/useData';
import { useFormDraft } from '../context/FormDraftContext';
import { CustomerManager } from './CustomerManager';
import { InsumoManager } from './InsumoManager';
import { UnitCycle, INGREDIENT_UNITS, BUDGET_UNITS } from './UnitCycle';

export function RecipeForm({ user, template, formula, confirmed = false, readOnly = false, initialLocked = true, partialPaymentAmount: savedPartialPaymentAmount = '', onPartialPaymentAmountChange, onClearTemplate, onComplete }: { user: User; template?: Formula | null; formula?: Formula | null; confirmed?: boolean; readOnly?: boolean; initialLocked?: boolean; partialPaymentAmount?: string; onPartialPaymentAmountChange?: (value: string | null) => void; onClearTemplate?: () => void; onComplete: (dest: 'pending' | 'confirmed') => void }) {
  const { data: customers, reload: reloadCustomers } = useData('customers', activity => db.customers.list(activity));
  const { data: insumos, reload: reloadInsumos } = useData('insumos', activity => db.insumos.list(activity));
  const { data: savedFormulas } = useData('savedFormulas', activity => db.savedFormulas.list(activity));
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | ''>('');
  const [items, setItems] = useState<FormulaItem[]>([]);
  const [editingIngredientId, setEditingIngredientId] = useState<number | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [showTemplateBanner, setShowTemplateBanner] = useState(false);
  const [insumoQuery, setInsumoQuery] = useState('');
  const [selectedInsumoId, setSelectedInsumoId] = useState<number | ''>('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('mg');
  const [showAddInsumo, setShowAddInsumo] = useState(false);
  const [itemError, setItemError] = useState('');
  const [savedFormulaQuery, setSavedFormulaQuery] = useState('');
  const [appliedSavedFormula, setAppliedSavedFormula] = useState<SavedFormula | null>(null);
  const [budgetNumber, setBudgetNumber] = useState('');
  const [bQty, setBQty] = useState('');
  const [bUnit, setBUnit] = useState('doses');
  const [bValue, setBValue] = useState('');
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>([]);
  const [selectedBudgetIndex, setSelectedBudgetIndex] = useState<number | null>(null);
  const [budgetError, setBudgetError] = useState('');
  const [attendantName, setAttendantName] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [partialPaymentAmount, setPartialPaymentAmount] = useState(savedPartialPaymentAmount);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(formula ? initialLocked : false);
  const [deliveryDateEditing, setDeliveryDateEditing] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [customerFocusIdx, setCustomerFocusIdx] = useState(-1);
  const [insumoFocusIdx, setInsumoFocusIdx] = useState(-1);
  const [savedFormulaFocusIdx, setSavedFormulaFocusIdx] = useState(-1);
  const deliveryDateTextInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const insumoQueryRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const bQtyRef = useRef<HTMLInputElement>(null);
  const budgetNumberRef = useRef<HTMLInputElement>(null);
  const customerQueryRef = useRef<HTMLInputElement>(null);
  const savedFormulaQueryRef = useRef<HTMLInputElement>(null);
  const customerListRef = useRef<HTMLDivElement>(null);
  const insumoListRef = useRef<HTMLDivElement>(null);
  const savedFormulaListRef = useRef<HTMLDivElement>(null);
  const pendingCustomerName = useRef('');
  const pendingInsumoName = useRef('');
  const { getDraft, saveDraft, removeDraft } = useFormDraft();
  const DRAFT_KEY = 'recipe-new';
  const isDraftMode = !formula && !readOnly;

  const draftRef = useRef({ selectedCustomerId, items, budgetNumber, budgetItems, selectedBudgetIndex, attendantName, deliveryDate, paymentStatus, paymentMethod });
  const skipFirstCleanupRef = useRef(true);
  const completedDraftRef = useRef(false);
  useEffect(() => {
    draftRef.current = { selectedCustomerId, items, budgetNumber, budgetItems, selectedBudgetIndex, attendantName, deliveryDate, paymentStatus, paymentMethod };
  });

  useEffect(() => {
    if (!isDraftMode) return;
    const draft = getDraft<{
      selectedCustomerId: number | '';
      items: FormulaItem[];
      budgetNumber: string;
      budgetItems: BudgetItem[];
      selectedBudgetIndex: number | null;
      attendantName: string;
      deliveryDate: string;
      paymentStatus: string;
      paymentMethod: string;
    }>(DRAFT_KEY);
    if (!draft) return;
    if (draft.selectedCustomerId !== undefined) setSelectedCustomerId(draft.selectedCustomerId);
    if (draft.items?.length) setItems(draft.items);
    if (draft.budgetNumber) setBudgetNumber(draft.budgetNumber);
    if (draft.budgetItems?.length) setBudgetItems(draft.budgetItems);
    if (draft.selectedBudgetIndex != null) setSelectedBudgetIndex(draft.selectedBudgetIndex);
    if (draft.attendantName) setAttendantName(draft.attendantName);
    if (draft.deliveryDate) setDeliveryDate(draft.deliveryDate);
    if (draft.paymentStatus) setPaymentStatus(draft.paymentStatus);
    if (draft.paymentMethod) setPaymentMethod(draft.paymentMethod);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (!isDraftMode) return;
      if (skipFirstCleanupRef.current) { skipFirstCleanupRef.current = false; return; }
      if (completedDraftRef.current) return;
      saveDraft(DRAFT_KEY, draftRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraftMode]);

  useEffect(() => {
    if (formula) {
      resetIngredientFields();
      setDeliveryDateEditing(false);
      setSelectedCustomerId(formula.customer_id);
      setItems(formula.items.map(i => ({ ...i })));
      setBudgetNumber(formula.budget_number ?? '');
      setBudgetItems((formula.budget_items ?? []).map(bi => ({ ...bi })));
      const budgetItems = formula.budget_items ?? [];
      const selIdx = budgetItems.findIndex(bi => bi.is_selected);
      setSelectedBudgetIndex(selIdx >= 0 ? selIdx : null);
      setAttendantName((formula.attendant_name ?? '').toUpperCase());
      setDeliveryDate(formula.delivery_date ? formatDateToBR(formula.delivery_date) : '');
      setPaymentStatus(formula.payment_status ?? '');
      setPartialPaymentAmount(formula.payment_status === 'parcial' && formula.partial_payment_amount != null
        ? formatCurrency(String(formula.partial_payment_amount).replace('.', ','))
        : '');
      setPaymentMethod(formula.payment_method ?? '');
      setDeliveryStatus(formula.delivery_status ?? (formula.status === 'confirmed' ? 'em_producao' : ''));
    }
  }, [formula]);

  useEffect(() => {
    if (template) {
      resetIngredientFields();
      setSelectedCustomerId(template.customer_id);
      setItems(template.items.map(i => ({ ...i })));
      setShowTemplateBanner(true);
    }
  }, [template]);

  useEffect(() => {
    if (formula) {
      setLocked(initialLocked);
    }
  }, [formula, initialLocked]);

  const clearForm = () => {
    resetIngredientFields();
    draftRef.current = {
      selectedCustomerId: '', items: [], budgetNumber: '', budgetItems: [], selectedBudgetIndex: null,
      attendantName: '', deliveryDate: '', paymentStatus: '', paymentMethod: '',
    };
    removeDraft(DRAFT_KEY);
    if (template) onClearTemplate?.();
    setSelectedCustomerId('');
    setItems([]);
    setCustomerQuery('');
    setShowAddCustomer(false);
    setShowTemplateBanner(false);
    setSavedFormulaQuery('');
    setAppliedSavedFormula(null);
    setBudgetNumber('');
    setBQty('');
    setBUnit('doses');
    setBValue('');
    setBudgetItems([]);
    setSelectedBudgetIndex(null);
    setBudgetError('');
    setAttendantName('');
    setDeliveryDate('');
    setPaymentStatus('');
    setPartialPaymentAmount('');
    onPartialPaymentAmountChange?.(null);
    setPaymentMethod('');
  };

  const allInsumos = (insumos as Insumo[]) ?? [];
  const selectedInsumo = allInsumos.find(m => m.id === selectedInsumoId) ?? null;
  const editingIngredient = items.find(item => item.insumo_id === editingIngredientId);
  // Preserva quantidades decimais existentes ao alterar apenas a unidade.
  const ingredientQuantity = editingIngredient && quantity === formatQuantity(editingIngredient.quantity)
    ? Number(editingIngredient.quantity) : parseQuantity(quantity);
  const canEditComposition = !locked && !confirmed && !readOnly && !saving;
  const mq = stripDiacritics(insumoQuery.trim().toLowerCase());
  const filteredInsumos = mq
    ? allInsumos
        .filter(m => stripDiacritics((m.name ?? '').toLowerCase()).includes(mq))
        .sort((a, b) => {
          const nameA = stripDiacritics((a.name ?? '').toLowerCase());
          const nameB = stripDiacritics((b.name ?? '').toLowerCase());
          const diff = (nameB.startsWith(mq) ? 1 : 0) - (nameA.startsWith(mq) ? 1 : 0);
          if (diff !== 0) return diff;
          return nameA.localeCompare(nameB);
        })
    : [];

  const resetIngredientFields = () => {
    setEditingIngredientId(null);
    setSelectedInsumoId('');
    setInsumoQuery('');
    setInsumoFocusIdx(-1);
    setQuantity('');
    setUnit('mg');
    setShowAddInsumo(false);
    setItemError('');
  };

  const startIngredientEdit = (item: FormulaItem) => {
    if (!canEditComposition) return;
    resetIngredientFields();
    setEditingIngredientId(item.insumo_id);
    setQuantity(formatQuantity(item.quantity));
    setUnit(item.unit ?? 'mg');
    requestAnimationFrame(() => {
      quantityRef.current?.focus();
      quantityRef.current?.select();
    });
  };

  const cancelIngredientEdit = () => {
    resetIngredientFields();
    requestAnimationFrame(() => insumoQueryRef.current?.focus());
  };

  const updateIngredient = () => {
    if (!canEditComposition || !editingIngredient) return;
    const parsedQuantity = ingredientQuantity;
    if (parsedQuantity <= 0) { setItemError('Informe uma quantidade maior que zero.'); return; }
    setItems(current => current.map(item => item.insumo_id === editingIngredientId
      ? { ...item, quantity: parsedQuantity, unit } : item));
    cancelIngredientEdit();
  };

  const removeIngredient = (id: number) => {
    if (!canEditComposition) return;
    setItems(current => current.filter(item => item.insumo_id !== id));
    if (editingIngredientId === id) cancelIngredientEdit();
    setItemError('');
  };

  const addIngredient = () => {
    if (!canEditComposition || editingIngredientId !== null || !selectedInsumoId) return;
    const parsedQuantity = parseQuantity(quantity);
    if (parsedQuantity <= 0) { setItemError('Informe uma quantidade maior que zero.'); return; }
    if (items.find(i => i.insumo_id === Number(selectedInsumoId))) {
      setItemError('Este insumo já foi adicionado à fórmula.');
      return;
    }
    setItems([...items, { insumo_id: Number(selectedInsumoId), insumo_name: selectedInsumo?.name ?? '', quantity: parsedQuantity, unit }]);
    setSelectedInsumoId('');
    setInsumoQuery('');
    setQuantity('');
    setItemError('');
    requestAnimationFrame(() => insumoQueryRef.current?.focus());
  };

  const allSavedFormulas = (savedFormulas as SavedFormula[]) ?? [];
  const sfq = stripDiacritics(savedFormulaQuery.trim().toLowerCase());
  const filteredSavedFormulas = sfq
    ? allSavedFormulas
        .filter(f => {
          const name = stripDiacritics((f.name ?? '').toLowerCase());
          const budgetNumber = stripDiacritics((f.budget_number ?? '').toLowerCase());
          return name.includes(sfq) || budgetNumber.includes(sfq);
        })
        .sort((a, b) => {
          const nameA = stripDiacritics((a.name ?? '').toLowerCase());
          const nameB = stripDiacritics((b.name ?? '').toLowerCase());
          const diff = (nameB.startsWith(sfq) ? 1 : 0) - (nameA.startsWith(sfq) ? 1 : 0);
          if (diff !== 0) return diff;
          return nameA.localeCompare(nameB);
        })
    : [];

  const applySavedFormula = (f: SavedFormula) => {
    resetIngredientFields();
    setItems(f.items.map(i => ({ insumo_id: i.insumo_id, insumo_name: i.insumo_name ?? '', quantity: i.quantity, unit: i.unit ?? 'mg' })));
    setAppliedSavedFormula(f);
    setSavedFormulaQuery('');
    setItemError('');
    if (f.budget_items && f.budget_items.length > 0) {
      setBudgetItems(f.budget_items.map(b => ({ ...b })));
      setSelectedBudgetIndex(null);
    }
  };

  const addBudgetItem = () => {
    if (!bQty || !bValue) return;
    const next = [...budgetItems, { quantity: Number(bQty), unit: bUnit, value: parseCurrency(bValue) }];
    setBudgetItems(next);
    setBQty('');
    setBValue('');
    setBudgetError('');
    requestAnimationFrame(() => bQtyRef.current?.focus());
  };

  const removeBudgetItem = (idx: number) => {
    const next = budgetItems.filter((_, i) => i !== idx);
    setBudgetItems(next);
    if (selectedBudgetIndex === idx) setSelectedBudgetIndex(null);
    else if (selectedBudgetIndex !== null && selectedBudgetIndex > idx) setSelectedBudgetIndex(selectedBudgetIndex - 1);
  };

  const parsedDeliveryDate = parseDateBR(deliveryDate);
  const selectedBudgetValue = selectedBudgetIndex !== null
    ? budgetItems[selectedBudgetIndex]?.value ?? null
    : null;
  const parsedPartialPaymentAmount = parseCurrency(partialPaymentAmount);
  const partialPaymentIsInvalid = paymentStatus === 'parcial' && (
    selectedBudgetValue === null ||
    parsedPartialPaymentAmount <= 0 ||
    parsedPartialPaymentAmount > selectedBudgetValue
  );
  const canSave = editingIngredientId === null && !!selectedCustomerId && items.length > 0 &&
    !!budgetNumber && budgetItems.length > 0 &&
    !!attendantName && (!deliveryDate || !!parsedDeliveryDate) &&
    !partialPaymentIsInvalid;
  const canConfirm = canSave && !!paymentStatus && selectedBudgetIndex !== null && !!parsedDeliveryDate;

  const getSaveErrorMessage = (err: any) => {
    const message = String(err?.message ?? '');
    if (message.includes('Número de orçamento já utilizado') || message.includes('Duplicate entry')) {
      return 'Número de orçamento já utilizado. Informe outro número para continuar.';
    }
    return message || 'Não foi possível salvar. Verifique a conexão com o servidor e tente novamente.';
  };

  const buildPayload = (status: import('../../shared/contracts').FormulaStatus, soloSelected = false) => {
    const payloadBudgetItems = soloSelected && selectedBudgetIndex !== null
      ? budgetItems.filter((_, i) => i === selectedBudgetIndex).map(bi => ({ ...bi, is_selected: true }))
      : budgetItems.map((bi, i) => ({ ...bi, is_selected: selectedBudgetIndex === i }));
    return {
      customer_id: selectedCustomerId as number,
      attendant_name: attendantName,
      items: items.map(i => ({ insumo_id: i.insumo_id, quantity: i.quantity, unit: i.unit ?? 'mg' })),
      budget_number: budgetNumber || undefined,
      budget_items: payloadBudgetItems.length > 0 ? payloadBudgetItems : undefined,
      delivery_date: parseDateBR(deliveryDate),
      payment_status: paymentStatus || undefined,
      partial_payment_amount: paymentStatus === 'parcial' ? parsedPartialPaymentAmount : null,
      payment_method: paymentMethod || null,
      delivery_status: status === 'confirmed' ? (deliveryStatus || 'em_producao') : deliveryStatus,
      status,
    };
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (formula) await db.formulas.update(formula.id, buildPayload('pending'));
      else {
        await db.formulas.add(buildPayload('pending'));
        completedDraftRef.current = true;
        removeDraft(DRAFT_KEY);
        clearForm();
      }
      onComplete('pending');
    } catch (err: any) {
      setSaveError(getSaveErrorMessage(err));
    } finally { setSaving(false); }
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      if (formula) await db.formulas.update(formula.id, buildPayload('confirmed', true));
      else {
        await db.formulas.add(buildPayload('confirmed', true));
        completedDraftRef.current = true;
        removeDraft(DRAFT_KEY);
        clearForm();
      }
      onComplete('confirmed');
    } catch (err: any) {
      setSaveError(getSaveErrorMessage(err));
    } finally { setSaving(false); }
  };

  const handleSaveConfirmed = async () => {
    if (!formula) return;
    if (deliveryDate && !parsedDeliveryDate) { setSaveError('Informe uma previsão de entrega válida.'); return; }
    setSaving(true);
    try {
      await db.formulas.update(formula.id, buildPayload(
        deliveryStatus === 'entregue' ? 'delivered' : 'confirmed'
      ));
      onComplete('confirmed');
    } catch (err: any) {
      setSaveError(getSaveErrorMessage(err));
    } finally { setSaving(false); }
  };

  const handleCancelFormula = async () => {
    if (!formula || !cancelReason.trim()) return;
    setSaving(true);
    try {
      await db.formulas.update(formula.id, {
        ...buildPayload('cancelled'),
        cancel_reason: cancelReason.trim(),
        payment_status: paymentStatus || undefined,
        payment_method: paymentMethod || null,
      });
      onComplete(formula.status === 'pending' ? 'pending' : 'confirmed');
    } catch (err: any) {
      setSaveError(getSaveErrorMessage(err));
    } finally { setSaving(false); }
  };

  const allCustomers = (customers as Customer[]) ?? [];
  const selectedCustomer = allCustomers.find(c => c.id === selectedCustomerId) ?? null;
  const q = stripDiacritics(customerQuery.trim().toLowerCase());
  const qDigits = customerQuery.replace(/\D/g, '');
  const filteredCustomers = (q || qDigits)
    ? allCustomers
        .filter(c => {
          const name = stripDiacritics((c.name ?? '').toLowerCase());
          const matchesName = q && name.includes(q);
          const matchesPhone = qDigits && (c.phone ?? c.responsible_phone ?? '').replace(/\D/g, '').includes(qDigits);
          return matchesName || matchesPhone;
        })
        .sort((a, b) => {
          const score = (c: Customer) => {
            const name = stripDiacritics((c.name ?? '').toLowerCase());
            const phone = (c.phone ?? c.responsible_phone ?? '').replace(/\D/g, '');
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
        })
    : [];

  const focusListOption = (listRef: React.RefObject<HTMLDivElement | null>, idx: number) => {
    listRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${idx}"]`)?.focus();
  };
  const moveListFocus = (listRef: React.RefObject<HTMLDivElement | null>, setIdx: React.Dispatch<React.SetStateAction<number>>, idx: number, dir: 1 | -1, length: number) => {
    const ni = dir === 1 ? (idx < length - 1 ? idx + 1 : 0) : (idx > 0 ? idx - 1 : length - 1);
    setIdx(ni);
    focusListOption(listRef, ni);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="ui-page-title text-2xl font-medium text-ink">
            {formula ? `Fórmula #${formula.id}` : template ? 'Repetir Fórmula' : 'Nova Fórmula'}
          </h2>
          <p className="text-muted text-sm">Funcionário: <strong>{formula ? (formula.created_by_name || 'Não identificado') : user.name}</strong></p>
        </div>
        <div className="flex items-center gap-3">
          {formula && !readOnly && (formula.status === 'pending' || (formula.status === 'confirmed' && (formula.delivery_status ?? 'em_producao') === 'em_producao')) && (
            <button type="button" disabled={saving} onClick={() => setShowCancelModal(true)}
              className="ui-button flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl border border-danger-line text-danger hover:bg-danger-soft transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <X className="w-3.5 h-3.5" /> Cancelar fórmula
            </button>
          )}
          {formula && locked && !confirmed && !readOnly && (
            <button type="button" onClick={() => setLocked(false)}
              className="ui-button ui-button-secondary flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl text-surface hover:opacity-90 transition-all"
              >
              <RefreshCw className="w-3.5 h-3.5" /> Editar
            </button>
          )}
          {formula && confirmed && locked && !readOnly && (
            <button type="button" disabled={saving} onClick={() => {
              setDeliveryDateEditing(true);
              requestAnimationFrame(() => {
                deliveryDateTextInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                deliveryDateTextInputRef.current?.focus();
              });
            }}
              className="ui-button ui-button-secondary flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl text-surface hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
              <RefreshCw className="w-3.5 h-3.5" /> Editar previsão
            </button>
          )}
          {!formula && (
            <>
              {(items.length > 0 || selectedCustomerId || budgetItems.length > 0 || budgetNumber || attendantName || deliveryDate || paymentStatus || paymentMethod) && (
                <button type="button" onClick={clearForm}
                  className="ui-button flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl border border-control-line text-muted hover:border-danger-line hover:text-danger hover:bg-danger-soft transition-all">
                  <Trash2 className="w-3.5 h-3.5" /> Limpar
                </button>
              )}
              <div className="w-12 h-12 bg-sage rounded-xl flex items-center justify-center"><PlusCircle className="w-6 h-6 text-brand" /></div>
            </>
          )}
        </div>
      </div>

      {showTemplateBanner && template && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
          style={{ background: COLORS.sage, border: `1px solid ${COLORS.sageBorder}`, color: COLORS.secondary }}>
          <RefreshCw className="w-4 h-4 shrink-0" />
          Baseado na fórmula #{template.id} de <strong className="ml-1">{template.customer_name}</strong>.
          Verifique e ajuste antes de finalizar.
        </div>
      )}
      {formula && locked && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
          style={{ background: COLORS.dangerSoft, border: `1px solid ${COLORS.dangerBorder}`, color: COLORS.danger }}>
          <AlertCircle className="w-4 h-4 shrink-0" />
          {readOnly ? (formula?.status === 'cancelled' ? 'Fórmula cancelada — visualização somente leitura.' : 'Fórmula no histórico — visualização somente leitura.') : confirmed ? 'Fórmula confirmada — previsão de entrega, pagamento, forma de pagamento e andamento podem ser alterados.' : 'Fórmula em modo visualização. Clique em "Editar" para alterar os campos.'}
        </div>
      )}
      {formula?.status === 'cancelled' && (
        <div className="px-4 py-3 rounded-xl text-sm" style={{ background: COLORS.dangerSoft, border: `1px solid ${COLORS.dangerBorder}`, color: COLORS.danger }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-1">Justificativa do cancelamento</p>
          <p className="whitespace-pre-wrap">{formula.cancel_reason?.trim() || 'Justificativa não informada.'}</p>
        </div>
      )}
      {/* Linha 1 — Seleção do Cliente */}
      <div className="ui-panel bg-surface p-5 rounded-2xl border border-line ">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-ink text-sm">1. Cliente</h3>
        </div>

        {showAddCustomer && (
          <div className="border border-dashed border-line rounded-xl overflow-hidden mb-4">
            <CustomerManager compact initialName={pendingCustomerName.current} onCreated={async (c: Customer) => { await reloadCustomers(); setSelectedCustomerId(c.id); setShowAddCustomer(false); setCustomerQuery(''); requestAnimationFrame(() => insumoQueryRef.current?.focus()); }} />
          </div>
        )}

        {selectedCustomer ? (
          <div className="flex items-center justify-between p-3 rounded-xl border border-line bg-canvas">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-sage flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-brand" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-ink text-sm truncate">{selectedCustomer.name}</p>
                <p className="text-xs text-muted flex items-center gap-1.5"><Phone size={14} aria-hidden="true" />{selectedCustomer.phone ?? selectedCustomer.responsible_phone ?? 'Sem celular cadastrado'}</p>
              </div>
            </div>
            {!locked && (
              <button type="button" onClick={() => { setSelectedCustomerId(''); setCustomerQuery(''); }}
                className="ui-button ui-icon-button p-2 text-muted hover:text-danger transition-colors ml-3" title="Trocar cliente">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
            <input
              className="ui-field w-full pl-9 pr-9 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm uppercase disabled:opacity-60 disabled:cursor-not-allowed"
              value={customerQuery}
              disabled={locked}
              ref={customerQueryRef}
              onChange={e => { setCustomerQuery(e.target.value.toUpperCase()); setCustomerFocusIdx(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' && filteredCustomers.length) {
                  e.preventDefault();
                  setCustomerFocusIdx(prev => (prev < filteredCustomers.length - 1 ? prev + 1 : 0));
                } else if (e.key === 'ArrowUp' && filteredCustomers.length) {
                  e.preventDefault();
                  setCustomerFocusIdx(prev => (prev > 0 ? prev - 1 : filteredCustomers.length - 1));
                } else if (e.key === 'Enter') {
                  if (filteredCustomers.length) {
                    e.preventDefault();
                    const targetIdx = customerFocusIdx >= 0 && customerFocusIdx < filteredCustomers.length ? customerFocusIdx : 0;
                    setCustomerFocusIdx(targetIdx);
                    focusListOption(customerListRef, targetIdx);
                  } else if (customerQuery.trim()) {
                    e.preventDefault();
                    pendingCustomerName.current = customerQuery.trim();
                    setShowAddCustomer(true); setCustomerQuery(''); setCustomerFocusIdx(-1);
                  }
                } else if (e.key === 'Escape') {
                  setCustomerQuery(''); setCustomerFocusIdx(-1);
                }
              }}
             aria-label="Buscar cliente" />
            {customerQuery && (
              <button onClick={() => { setCustomerQuery(''); setCustomerFocusIdx(-1); }} title="Limpar busca"
                className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-danger transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
            {filteredCustomers.length > 0 && (
              <div ref={customerListRef} className="ui-popover absolute left-0 right-0 mt-1 bg-surface border border-line rounded-xl  overflow-hidden z-10 max-h-64 overflow-y-auto">
                {filteredCustomers.map((c, idx) => (
                  <button key={c.id} type="button" data-idx={idx}
                    onClick={() => { setSelectedCustomerId(c.id); setCustomerQuery(''); setCustomerFocusIdx(-1); }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveListFocus(customerListRef, setCustomerFocusIdx, idx, 1, filteredCustomers.length);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveListFocus(customerListRef, setCustomerFocusIdx, idx, -1, filteredCustomers.length);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        setSelectedCustomerId(c.id); setCustomerQuery(''); setCustomerFocusIdx(-1);
                        requestAnimationFrame(() => insumoQueryRef.current?.focus());
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setCustomerQuery(''); setCustomerFocusIdx(-1);
                        customerQueryRef.current?.focus();
                      }
                    }}
                    className={`ui-button w-full text-left px-3 py-2 transition-colors flex items-center gap-2 ${idx === customerFocusIdx ? 'bg-sage text-brand font-medium' : 'hover:bg-sage'}`}>
                    <Users className="w-3.5 h-3.5 text-muted shrink-0" />
                    <span className="text-sm truncate flex-1">{c.name}</span>
                    <span className="text-xs text-muted shrink-0">{c.phone ?? c.responsible_phone ?? ''}</span>
                  </button>
                ))}
              </div>
            )}
            {q || qDigits ? (
              filteredCustomers.length === 0 && (
                <div className="px-1 mt-1">
                  <p className="text-xs text-muted mb-2">Nenhum cliente encontrado.</p>
                  <button
                    type="button"
                    onClick={() => { pendingCustomerName.current = customerQuery.trim(); setShowAddCustomer(true); setCustomerQuery(''); setCustomerFocusIdx(-1); }}
                    className="ui-button w-full text-left px-3 py-2 text-sm font-medium text-brand hover:bg-sage rounded-lg transition-colors flex items-center gap-2"
                  >
                    <PlusCircle className="w-4 h-4 shrink-0" />
                    Criar novo cliente "{customerQuery.trim()}"
                  </button>
                </div>
              )
            ) : (
              <p className="text-xs text-muted mt-1 px-1">Digite para buscar por nome ou telefone.</p>
            )}
          </div>
        )}
      </div>
      {/* Linha 2 — Insumo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <div className={`ui-panel bg-surface p-5 rounded-2xl border border-line  ${locked ? 'lg:col-span-2' : ''}`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-ink text-sm">2.1 Insumo</h3>
        </div>

        {editingIngredient || selectedInsumo ? (
          <div className="flex items-center justify-between p-3 rounded-xl border border-line bg-canvas mb-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-info-strong flex items-center justify-center shrink-0">
                <ClipboardList className="w-4 h-4 text-brand" />
              </div>
              <p className="font-semibold text-ink text-sm truncate">{editingIngredient ? editingIngredient.insumo_name : selectedInsumo?.name}</p>
            </div>
            {canEditComposition && !editingIngredient && (
              <button type="button" onClick={() => { setSelectedInsumoId(''); setInsumoQuery(''); }}
                className="ui-button ui-icon-button p-2 text-muted hover:text-danger transition-colors ml-3" title="Trocar insumo">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          <div className="relative mb-4">
            {showAddInsumo && (
              <div className="border border-dashed border-line rounded-xl overflow-hidden mb-4">
                <InsumoManager compact initialName={pendingInsumoName.current} onCreated={async (m: Insumo) => { await reloadInsumos(); setSelectedInsumoId(m.id); setShowAddInsumo(false); setInsumoQuery(''); requestAnimationFrame(() => quantityRef.current?.focus()); }} />
              </div>
            )}
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
            <input
              className="ui-field w-full pl-9 pr-9 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              value={insumoQuery}
              disabled={!canEditComposition}
              ref={insumoQueryRef}
              onChange={e => { setInsumoQuery(e.target.value.toUpperCase()); setInsumoFocusIdx(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' && filteredInsumos.length) {
                  e.preventDefault();
                  setInsumoFocusIdx(prev => (prev < filteredInsumos.length - 1 ? prev + 1 : 0));
                } else if (e.key === 'ArrowUp' && filteredInsumos.length) {
                  e.preventDefault();
                  setInsumoFocusIdx(prev => (prev > 0 ? prev - 1 : filteredInsumos.length - 1));
                } else if (e.key === 'Enter') {
                  if (filteredInsumos.length) {
                    e.preventDefault();
                    const targetIdx = insumoFocusIdx >= 0 && insumoFocusIdx < filteredInsumos.length ? insumoFocusIdx : 0;
                    setInsumoFocusIdx(targetIdx);
                    focusListOption(insumoListRef, targetIdx);
                  } else if (insumoQuery.trim()) {
                    e.preventDefault();
                    pendingInsumoName.current = insumoQuery.trim();
                    setShowAddInsumo(true); setInsumoQuery(''); setInsumoFocusIdx(-1);
                  }
                } else if (e.key === 'Escape') {
                  setInsumoQuery(''); setInsumoFocusIdx(-1);
                }
              }}
             aria-label="Buscar insumo" />
            {insumoQuery && (
              <button onClick={() => { setInsumoQuery(''); setInsumoFocusIdx(-1); }} title="Limpar busca"
                className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-danger transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
            {filteredInsumos.length > 0 && (
              <div ref={insumoListRef} className="ui-popover absolute left-0 right-0 mt-1 bg-surface border border-line rounded-xl  overflow-hidden z-10 max-h-64 overflow-y-auto">
                {filteredInsumos.map((m, idx) => (
                  <button key={m.id} type="button" data-idx={idx}
                    onClick={() => { setSelectedInsumoId(m.id); setInsumoQuery(''); setInsumoFocusIdx(-1); }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveListFocus(insumoListRef, setInsumoFocusIdx, idx, 1, filteredInsumos.length);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveListFocus(insumoListRef, setInsumoFocusIdx, idx, -1, filteredInsumos.length);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        setSelectedInsumoId(m.id); setInsumoQuery(''); setInsumoFocusIdx(-1);
                        requestAnimationFrame(() => quantityRef.current?.focus());
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setInsumoQuery(''); setInsumoFocusIdx(-1);
                        insumoQueryRef.current?.focus();
                      }
                    }}
                    className={`ui-button w-full text-left px-3 py-2 transition-colors flex items-center gap-2 ${idx === insumoFocusIdx ? 'bg-sage text-brand font-medium' : 'hover:bg-sage'}`}>
                    <ClipboardList className="w-3.5 h-3.5 text-muted shrink-0" />
                    <span className="text-sm truncate flex-1">{m.name}</span>
                  </button>
                ))}
              </div>
            )}
            {mq && filteredInsumos.length === 0 && (
              <div className="px-1 mt-1">
                <p className="text-xs text-muted mb-2">Nenhum insumo encontrado.</p>
                <button
                  type="button"
                  onClick={() => {
                    pendingInsumoName.current = insumoQuery.trim();
                    setShowAddInsumo(true);
                    setInsumoQuery('');
                    setInsumoFocusIdx(-1);
                  }}
                  className="ui-button w-full text-left px-3 py-2 text-sm font-medium text-brand hover:bg-sage rounded-lg transition-colors flex items-center gap-2"
                >
                  <PlusCircle className="w-4 h-4 shrink-0" />
                  Criar novo insumo "{insumoQuery.trim()}"
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[110px]">
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="recipe-ingredient-quantity" >Quantidade</label>
            <input
              id="recipe-ingredient-quantity"
              ref={quantityRef}
              inputMode="numeric"
              maxLength={8}
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm text-right disabled:opacity-60 disabled:cursor-not-allowed"
              value={quantity}
              disabled={!canEditComposition}
              onChange={e => { setQuantity(formatQuantityInput(e.target.value)); setItemError(''); }}
             />
          </div>
          <div className="flex-1 min-w-[110px]">
            <label className="block text-xs font-semibold text-muted uppercase mb-1">Unidade</label>
            <UnitCycle value={unit} onChange={setUnit} options={INGREDIENT_UNITS} disabled={!canEditComposition} />
          </div>
          <div className="flex-1 min-w-[160px] space-y-1">
            {itemError && <p className="text-xs text-danger font-medium bg-danger-soft px-2 py-1 rounded">{itemError}</p>}
            {quantity !== '' && ingredientQuantity <= 0 && <p className="text-xs font-medium" style={{ color: COLORS.primary }}>Informe uma quantidade maior que zero.</p>}
            {canEditComposition && (
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={(!editingIngredient && !selectedInsumoId) || ingredientQuantity <= 0} onClick={editingIngredient ? updateIngredient : addIngredient}
                  className="ui-button ui-button-secondary flex-1 text-surface px-3 py-2 rounded-lg font-medium text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: COLORS.secondary }}>
                  {editingIngredient ? 'Atualizar ingrediente' : '+ Adicionar à fórmula'}
                </button>
                {editingIngredient && <button type="button" onClick={cancelIngredientEdit} className="ui-button px-3 py-2 rounded-lg bg-sage text-muted hover:bg-sage text-sm font-semibold transition-colors">Cancelar</button>}
              </div>
            )}
          </div>
        </div>

        {editingIngredient && <p role="status" className="mt-2 text-xs text-brand">Atualize ou cancele a edição do ingrediente antes de salvar a fórmula.</p>}

        <div className="mt-4 pt-3 border-t border-line">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Insumos adicionados</h4>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: COLORS.sage, color: COLORS.secondary }}>
              {items.length} {items.length === 1 ? 'insumo' : 'insumos'}
            </span>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-muted">Nenhum insumo adicionado ainda.</p>
          ) : (
            <div className="space-y-2">
              {items.map((item, idx) => (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} key={item.insumo_id}
                  className="flex items-center justify-between p-3 rounded-xl border border-line"
                  style={{ background: editingIngredientId === item.insumo_id ? COLORS.infoSoft : idx % 2 === 0 ? COLORS.rowAlt : COLORS.surface, borderColor: editingIngredientId === item.insumo_id ? COLORS.infoBorder : undefined }}>
                  <div className="min-w-0">
                    <p className="font-semibold text-ink text-sm truncate">{item.insumo_name}</p>
                    <p className="text-xs text-muted">{formatQuantity(item.quantity)} {item.unit ?? 'mg'}</p>
                  </div>
                  {canEditComposition && (
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <button type="button" onClick={() => editingIngredientId === item.insumo_id ? cancelIngredientEdit() : startIngredientEdit(item)}
                        aria-label={`${editingIngredientId === item.insumo_id ? 'Cancelar edição de' : 'Editar'} ${item.insumo_name}`}
                        aria-pressed={editingIngredientId === item.insumo_id}
                        className={`ui-button text-xs font-semibold px-3 py-1 rounded-lg transition-colors ${editingIngredientId === item.insumo_id ? 'bg-sage text-muted hover:bg-sage' : 'hover:bg-sage'}`}
                        style={editingIngredientId === item.insumo_id ? undefined : { color: COLORS.secondary }}>
                        {editingIngredientId === item.insumo_id ? 'Cancelar' : 'Editar'}
                      </button>
                      <button type="button" onClick={() => removeIngredient(item.insumo_id)}
                        className="ui-button ui-icon-button text-muted hover:text-danger transition-colors p-1" title="Remover insumo" aria-label={`Remover ${item.insumo_name}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Linha 2.2 — Fórmula Salva */}
      {!locked && (
        <div className="ui-panel bg-surface p-5 rounded-2xl border border-line ">
          <h3 className="font-semibold text-ink text-sm mb-1">2.2 Fórmula Salva</h3>
          <p className="text-xs text-muted mb-4">Selecione uma fórmula salva para preencher automaticamente os insumos (substitui a lista atual).</p>

          {appliedSavedFormula && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium mb-4"
              style={{ background: COLORS.sage, border: `1px solid ${COLORS.sageBorder}`, color: COLORS.secondary }}>
              <RefreshCw className="w-4 h-4 shrink-0" />
              <span className="flex-1 min-w-0">
                Fórmula salva <strong>{appliedSavedFormula.name}</strong> aplicada — os insumos da lista foram substituídos.
              </span>
              <button type="button" onClick={() => setAppliedSavedFormula(null)}
                className="ui-button ui-icon-button text-muted hover:text-danger transition-colors" title="Dispensar aviso">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {allSavedFormulas.length === 0 ? (
            <p className="text-sm text-muted">Nenhuma fórmula salva cadastrada. Cadastre uma na tela "Minhas Fórmulas".</p>
          ) : (
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
              <input
                className="ui-field w-full pl-9 pr-9 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm"
                value={savedFormulaQuery}
                ref={savedFormulaQueryRef}
                onChange={e => { setSavedFormulaQuery(e.target.value); setSavedFormulaFocusIdx(-1); }}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown' && filteredSavedFormulas.length) {
                    e.preventDefault();
                    setSavedFormulaFocusIdx(prev => (prev < filteredSavedFormulas.length - 1 ? prev + 1 : 0));
                  } else if (e.key === 'ArrowUp' && filteredSavedFormulas.length) {
                    e.preventDefault();
                    setSavedFormulaFocusIdx(prev => (prev > 0 ? prev - 1 : filteredSavedFormulas.length - 1));
                  } else if (e.key === 'Enter' && filteredSavedFormulas.length) {
                    e.preventDefault();
                    const targetIdx = savedFormulaFocusIdx >= 0 && savedFormulaFocusIdx < filteredSavedFormulas.length ? savedFormulaFocusIdx : 0;
                    setSavedFormulaFocusIdx(targetIdx);
                    focusListOption(savedFormulaListRef, targetIdx);
                  } else if (e.key === 'Escape') {
                    setSavedFormulaQuery(''); setSavedFormulaFocusIdx(-1);
                  }
                }}
               aria-label="Buscar fórmula salva" />
              {savedFormulaQuery && (
                <button onClick={() => { setSavedFormulaQuery(''); setSavedFormulaFocusIdx(-1); }} title="Limpar busca"
                  className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-danger transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
              {filteredSavedFormulas.length > 0 && (
                <div ref={savedFormulaListRef} className="ui-popover absolute left-0 right-0 mt-1 bg-surface border border-line rounded-xl  overflow-hidden z-10 max-h-64 overflow-y-auto">
                  {filteredSavedFormulas.map((f, idx) => (
                    <button key={f.id} type="button" data-idx={idx}
                      onClick={() => { applySavedFormula(f); setSavedFormulaFocusIdx(-1); }}
                      onKeyDown={e => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveListFocus(savedFormulaListRef, setSavedFormulaFocusIdx, idx, 1, filteredSavedFormulas.length);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          moveListFocus(savedFormulaListRef, setSavedFormulaFocusIdx, idx, -1, filteredSavedFormulas.length);
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          applySavedFormula(f); setSavedFormulaFocusIdx(-1);
                          requestAnimationFrame(() => budgetNumberRef.current?.focus());
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setSavedFormulaQuery(''); setSavedFormulaFocusIdx(-1);
                          savedFormulaQueryRef.current?.focus();
                        }
                      }}
                      className={`ui-button w-full text-left px-3 py-2 transition-colors flex items-center gap-2 ${idx === savedFormulaFocusIdx ? 'bg-sage text-brand font-medium' : 'hover:bg-sage'}`}>
                      <Bookmark className="w-3.5 h-3.5 text-muted shrink-0" />
                      <div className="flex items-center gap-2 w-full min-w-0">
                        <span className="text-sm truncate flex-1">{f.name}</span>
                        {f.budget_number && (
                          <span className="text-xs text-muted shrink-0 whitespace-nowrap">
                            {f.budget_number}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {sfq && filteredSavedFormulas.length === 0 && (
                <p className="text-xs text-muted mt-1 px-1">Nenhuma fórmula salva encontrada.</p>
              )}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Linha 3 — Orçamento */}
      <div className="ui-panel bg-surface p-5 rounded-2xl border border-line ">
        <h3 className="font-semibold text-ink text-sm mb-4">3. Orçamento</h3>
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-end">
          <div className="w-36">
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-2" >Número de orçamento</label>
            <input
              ref={budgetNumberRef}
              inputMode="numeric"
              maxLength={6}
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm text-right disabled:opacity-60 disabled:cursor-not-allowed"
              value={budgetNumber}
              disabled={locked}
              onChange={e => setBudgetNumber(e.target.value.replace(/\D/g, '').slice(0, 6))}
             id="mf-recipeform-2" />
          </div>

          <div>
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[110px]">
                <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-3" >Quantidade</label>
                <input
                  ref={bQtyRef}
                  inputMode="numeric"
                  maxLength={3}
                  className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm text-right disabled:opacity-60 disabled:cursor-not-allowed"
                  value={bQty}
                  disabled={locked}
                  onChange={e => { setBudgetError(''); setBQty(e.target.value.replace(/\D/g, '').slice(0, 3)); }}
                 id="mf-recipeform-3" />
              </div>
              <div className="flex-1 min-w-[110px]">
                <label className="block text-xs font-semibold text-muted uppercase mb-1">Unidade</label>
                <UnitCycle value={bUnit} onChange={setBUnit} options={BUDGET_UNITS} disabled={locked} />
              </div>
              <div className="flex-1 min-w-[130px]">
                <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-4" >Valor (R$)</label>
                <input
                  inputMode="numeric"
                  className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm text-right disabled:opacity-60 disabled:cursor-not-allowed"
                  value={bValue}
                  disabled={locked}
                  onChange={e => {
                    setBudgetError('');
                    const input = e.currentTarget;
                    const formatted = formatCurrency(input.value);
                    const caret = currencyCaretPosition(input.value, input.selectionStart ?? input.value.length);
                    setBValue(formatted);
                    requestAnimationFrame(() => input.setSelectionRange(caret, caret));
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && bQty && bValue) {
                      e.preventDefault();
                      addBudgetItem();
                    }
                  }}
                 id="mf-recipeform-4" />
              </div>
              <div className="space-y-1">
                {!locked && (
                  <button type="button" disabled={!bQty || !bValue} onClick={addBudgetItem}
                    className="ui-button ui-button-secondary w-full sm:w-auto text-surface px-4 py-2 rounded-lg font-medium text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                    + Adicionar
                  </button>
                )}
                {budgetError && <p className="text-xs text-danger font-medium bg-danger-soft px-2 py-1 rounded">{budgetError}</p>}
              </div>
            </div>

            {budgetItems.length > 0 && (
              <div className="mt-3 space-y-2">
                {budgetItems.map((bi, idx) => {
                  const isSelected = selectedBudgetIndex === idx;
                  return (
                    <div key={idx}
                      tabIndex={locked ? -1 : 0}
                      role="radio"
                      aria-checked={isSelected}
                      className={`flex items-center gap-3 p-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-brand ${!locked ? 'cursor-pointer' : ''} ${isSelected ? 'border-danger-line' : 'border-line'}`}
                      style={{ background: isSelected ? COLORS.sage : (idx % 2 === 0 ? COLORS.rowAlt : COLORS.surface) }}
                      onClick={() => { if (!locked) setSelectedBudgetIndex(idx); }}
                      onKeyDown={e => {
                        if (locked) return;
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          setSelectedBudgetIndex(idx);
                        } else if (e.key === 'ArrowDown' && idx < budgetItems.length - 1) {
                          e.preventDefault();
                          setSelectedBudgetIndex(idx + 1);
                        } else if (e.key === 'ArrowUp' && idx > 0) {
                          e.preventDefault();
                          setSelectedBudgetIndex(idx - 1);
                        }
                      }}>
                      <input type="radio" name="budgetSelection" className="w-4 h-4 accent-[var(--pf-primary)] shrink-0"
                        checked={isSelected}
                        disabled={locked}
                        onChange={() => { if (!locked) setSelectedBudgetIndex(idx); }}
                        onClick={e => e.stopPropagation()} />
                      <p className="text-sm text-ink flex-1 min-w-0">
                        <strong>{formatQuantity(bi.quantity)}</strong> {formatUnit(bi.unit)} · <span className="font-semibold text-ink">R$ {Number(bi.value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </p>
                      {!locked && (
                        <button type="button" onClick={e => { e.stopPropagation(); removeBudgetItem(idx); }}
                          className="ui-button ui-icon-button text-muted hover:text-danger transition-colors ml-4 p-1" title="Remover item do orçamento">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bloco 4 — Informações */}
      <div className="ui-panel bg-surface p-5 rounded-2xl border border-line ">
        <h3 className="font-semibold text-ink text-sm mb-4">4. Informações</h3>
        <div>
          <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-5" >Nome do Atendente</label>
          <input
            type="text"
            maxLength={100}
            className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            value={attendantName}
            disabled={locked}
            onChange={e => setAttendantName(e.target.value.toUpperCase())}
           id="mf-recipeform-5" />
        </div>
      </div>

      {/* Bloco 5 — Finalizar */}
      <div className="ui-panel bg-surface p-5 rounded-2xl border border-line ">
        <h3 className="font-semibold text-ink text-sm mb-4">5. Finalizar</h3>
        <div className={(confirmed || readOnly) ? 'grid grid-cols-1 gap-6 md:grid-cols-3' : 'ui-split-grid grid gap-6'}>
          <div>
            {/** Data liberada separadamente para fórmulas confirmadas. */}
            <label htmlFor="delivery-date" className="block text-xs font-semibold text-muted uppercase mb-1">Previsão de entrega</label>
            <div className="relative">
              <input
                ref={deliveryDateTextInputRef}
                id="delivery-date"
                type="text"
                inputMode="numeric"
                maxLength={10}
                className="ui-field w-full pr-10 px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                value={deliveryDate}
                disabled={readOnly || (confirmed ? !deliveryDateEditing : locked)}
                onChange={e => {
                  const masked = formatDateBR(e.target.value);
                  setDeliveryDate(masked);
                  if (dateInputRef.current) dateInputRef.current.value = parseDateBR(masked) ?? '';
                }}
               aria-label="Previsão de entrega" />
              {(!readOnly && (confirmed ? deliveryDateEditing : !locked)) && deliveryDate && (
                <button type="button" onClick={() => { setDeliveryDate(''); if (dateInputRef.current) dateInputRef.current.value = ''; }}
                  className="ui-button ui-icon-button absolute right-9 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-danger transition-colors" title="Limpar data">
                  <X className="w-4 h-4" />
                </button>
              )}
              <button type="button" onClick={() => dateInputRef.current?.showPicker()} disabled={readOnly || (confirmed ? !deliveryDateEditing : locked)}
                className="ui-button ui-icon-button absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted hover:text-danger transition-colors rounded-lg hover:bg-danger-soft disabled:opacity-40 disabled:cursor-not-allowed" title="Abrir calendário">
                <Calendar className="w-4 h-4" />
              </button>
              <input
                ref={dateInputRef}
                type="date"
                className="ui-field absolute inset-0 w-full opacity-0 pointer-events-none"
                tabIndex={-1}
                aria-hidden="true"
                onChange={e => {
                  const value = e.target.value ? formatDateToBR(e.target.value) : '';
                  setDeliveryDate(value);
                }}
              />
            </div>
            {deliveryDate && !parsedDeliveryDate && <p role="alert" className="mt-1 text-xs text-danger">Informe uma previsão de entrega válida.</p>}
            {formula && formula.status !== 'pending' && (
              <dl className="mt-3">
                <dt className="text-xs font-semibold text-muted uppercase mb-1">Data de entrega</dt>
                <dd className="text-sm text-ink">
                  {formula.delivered_at
                    ? formatDateToBR(formula.delivered_at.slice(0, 10))
                    : formula.delivery_status === 'entregue' || formula.status === 'delivered'
                      ? 'Não registrada'
                      : 'Ainda não entregue'}
                </dd>
              </dl>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-6" >Pagamento</label>
            <select className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              value={paymentStatus} disabled={locked && !confirmed} onChange={e => {
                const status = e.target.value;
                setPaymentStatus(status);
                if (status !== 'parcial') {
                  setPartialPaymentAmount('');
                  onPartialPaymentAmountChange?.(null);
                }
              }} id="mf-recipeform-6" >
              <option value="">Selecione...</option>
              <option value="pago">Pago</option>
              <option value="parcial">Parcial</option>
              <option value="pagar_na_retirada">Pagar na retirada</option>
            </select>
          </div>
          {paymentStatus === 'parcial' && (
            <div>
              <label className="block text-xs font-semibold text-muted uppercase mb-1">Quantia paga</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">R$</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={partialPaymentAmount}
                  disabled={locked && !confirmed}
                  onChange={e => {
                    const input = e.currentTarget;
                    const formattedValue = formatCurrency(input.value);
                    const value = selectedBudgetValue !== null && parseCurrency(formattedValue) > selectedBudgetValue
                      ? formatCurrency(selectedBudgetValue.toFixed(2).replace('.', ','))
                      : formattedValue;
                    const caret = value === formattedValue
                      ? currencyCaretPosition(input.value, input.selectionStart ?? input.value.length)
                      : value.length;
                    setPartialPaymentAmount(value);
                    onPartialPaymentAmountChange?.(value || null);
                    requestAnimationFrame(() => input.setSelectionRange(caret, caret));
                  }}
                  placeholder="0,00"
                  aria-label="Quantia paga"
                  className="ui-field w-full pl-9 pr-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              {selectedBudgetValue === null ? (
                <p className="mt-1 text-xs text-danger">Selecione uma opção de orçamento para validar o limite.</p>
              ) : !partialPaymentAmount || parsedPartialPaymentAmount <= 0 ? (
                <p className="mt-1 text-xs text-danger">Informe uma quantia maior que zero.</p>
              ) : parsedPartialPaymentAmount > selectedBudgetValue ? (
                <p className="mt-1 text-xs text-danger">A quantia paga não pode ser maior que o valor do orçamento selecionado (R$ {selectedBudgetValue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).</p>
              ) : null}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-7" >Forma de pagamento</label>
            <select className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              value={paymentMethod} disabled={locked && !confirmed} onChange={e => setPaymentMethod(e.target.value)} id="mf-recipeform-7" >
              <option value="">Selecione (opcional)...</option>
              <option value="cartao">Cartão</option>
              <option value="dinheiro">Dinheiro</option>
              <option value="pix">Pix</option>
            </select>
          </div>
        </div>
      </div>

      {/* Bloco 6 — Ações */}
      {!locked && (
        <div className="ui-split-grid grid gap-6">
          <div>
            <button type="button" disabled={!canSave || saving} onClick={handleSave}
              className="ui-button ui-button-secondary w-full disabled:opacity-50 disabled:cursor-not-allowed text-surface py-3.5 rounded-xl font-bold text-base hover:opacity-90 transition-all "
              >
              {saving ? 'Salvando...' : <span className="inline-flex items-center gap-2"><Save size={18} aria-hidden="true" />Salvar</span>}
            </button>
            <p className="text-center text-xs text-muted mt-2">
              {canSave ? 'Pronto para salvar' : 'Preencha os blocos 1 a 4 (cliente, insumos, orçamento e informações)'}
            </p>
          </div>
          <div>
            <button type="button" disabled={!canConfirm || saving} onClick={handleConfirm}
              className="ui-button ui-button-primary w-full disabled:opacity-50 disabled:cursor-not-allowed text-on-coral py-3.5 rounded-xl font-bold text-base hover:opacity-90 transition-all "
              >
              {saving ? 'Salvando...' : <span className="inline-flex items-center gap-2"><Check size={18} aria-hidden="true" />Confirmar</span>}
            </button>
            <p className="text-center text-xs text-muted mt-2">
              {canConfirm
                ? 'Pronto para confirmar'
                : budgetItems.length > 0 && selectedBudgetIndex === null
                  ? 'Selecione um orçamento (marcador ao lado) e preencha os demais blocos'
                  : 'Preencha cliente, insumos, orçamento, informações e o pagamento (blocos 1 a 5)'}
            </p>
          </div>
        </div>
      )}

      {formula && confirmed && (
        <div className="ui-split-grid grid gap-6">
          <div className="md:col-span-2">
            <button type="button" disabled={saving} onClick={handleSaveConfirmed}
              className="ui-button ui-button-secondary w-full text-surface py-3.5 rounded-xl font-bold text-base hover:opacity-90 transition-all  disabled:opacity-50 disabled:cursor-not-allowed"
              >
              {saving ? 'Salvando...' : <span className="inline-flex items-center gap-2"><Save size={18} aria-hidden="true" />Salvar alterações</span>}
            </button>
          </div>
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={() => { if (!saving) setShowCancelModal(false); }}
          onKeyDown={e => { if (e.key === 'Escape' && !saving) setShowCancelModal(false); }}>
          <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-sage flex items-center justify-center shrink-0">
                <X className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 className="font-bold text-ink text-lg">Cancelar fórmula</h3>
                <p className="text-xs text-muted">A fórmula sairá da fila de confirmadas.</p>
              </div>
            </div>
            <label className="block text-xs font-semibold text-muted uppercase mb-1" htmlFor="mf-recipeform-8" >Justificativa (obrigatória)</label>
            <textarea
              autoFocus
              className="ui-field w-full px-3 py-2 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none text-sm min-h-[90px] resize-none disabled:opacity-60 disabled:cursor-not-allowed"
              value={cancelReason} disabled={saving}
              onChange={e => setCancelReason(e.target.value)}  id="mf-recipeform-8" />
            <div className="flex gap-3 mt-4">
              <button type="button" disabled={saving} onClick={() => setShowCancelModal(false)}
                className="ui-button flex-1 py-2.5 rounded-xl border border-control-line text-muted font-semibold text-sm hover:bg-canvas transition-all disabled:opacity-50">
                Voltar
              </button>
              <button type="button" disabled={!cancelReason.trim() || saving} onClick={handleCancelFormula}
                className="ui-button ui-button-primary flex-1 py-2.5 rounded-xl text-on-coral font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                {saving ? 'Cancelando...' : 'Confirmar cancelamento'}
              </button>
            </div>
          </DialogSurface>
        </div>
      )}

      {saveError && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4"
          onClick={() => setSaveError('')}
          onKeyDown={e => { if (e.key === 'Escape') setSaveError(''); }}>
          <DialogSurface className="ui-dialog bg-surface rounded-2xl  w-full max-w-md p-6" onClick={e => e.stopPropagation()} onKeyDown={handleDialogArrowNavigation} role="dialog" aria-modal="true" aria-labelledby="save-error-title">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-sage flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 id="save-error-title" className="font-bold text-ink text-lg">Não foi possível salvar</h3>
                <p className="text-sm text-ink mt-2">{saveError}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setSaveError('')} autoFocus
                className="ui-button ui-button-primary px-5 py-2.5 rounded-xl text-on-coral font-semibold text-sm hover:opacity-90 transition-all"
                >
                Entendi
              </button>
            </div>
          </DialogSurface>
        </div>
      )}
    </motion.div>
  );
}
