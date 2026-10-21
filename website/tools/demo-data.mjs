// Dados exclusivamente fictícios para capturar a interface.
export function demoData() {
  const user = { id: 1, name: 'Equipe Demo', username: 'demonstracao', role: 'manager' };
  const customers = [
    { id: 1, name: 'Cliente Exemplo A', phone: '(41) 00000-0000' },
    { id: 2, name: 'Cliente Exemplo B', phone: '(41) 00000-0000' },
    { id: 3, name: 'Cliente Exemplo C', phone: '(41) 00000-0000' },
    { id: 4, name: 'Cliente Exemplo D', phone: '(41) 00000-0000' },
    { id: 5, name: 'Cliente Exemplo E', phone: '(41) 00000-0000' },
    { id: 6, name: 'Dependente Exemplo', phone: '', responsible_id: 1, responsible_name: 'Cliente Exemplo A', responsible_phone: '(41) 00000-0000' },
  ].map(customer => ({ ...customer, created_at: '2026-10-01T09:00:00-03:00' }));
  const insumos = [{ id: 1, name: 'Insumo Exemplo A' }, { id: 2, name: 'Insumo Exemplo B' }, { id: 3, name: 'Insumo Exemplo C' }];
  const makeFormula = (id, customerId, status, deliveryStatus, paymentStatus, value) => ({
    id, customer_id: customerId, customer_name: customers[customerId - 1].name,
    customer_phone: '(41) 00000-0000', attendant_name: 'Atendente Demo',
    status, delivery_status: deliveryStatus, payment_status: paymentStatus,
    partial_payment_amount: paymentStatus === 'parcial' ? 72 : null, payment_method: 'pix',
    created_at: '2026-10-02T10:00:00-03:00', delivery_date: '2026-10-09',
    delivered_at: status === 'delivered' ? '2026-10-05T14:00:00-03:00' : null,
    budget_number: `MF-${String(id).padStart(3, '0')}`, manager_verified: id === 6,
    items: [{ insumo_id: 1, insumo_name: 'Insumo Exemplo A', quantity: 100, unit: 'mg' }, { insumo_id: 2, insumo_name: 'Insumo Exemplo B', quantity: 50, unit: 'mg' }],
    budget_items: [{ quantity: 30, unit: 'cápsulas', value: value / 2, is_selected: false }, { quantity: 60, unit: 'cápsulas', value, is_selected: true }],
  });
  const formulas = [
    makeFormula(1, 1, 'confirmed', 'em_producao', 'parcial', 180),
    makeFormula(2, 2, 'confirmed', 'em_producao', 'pago', 140),
    makeFormula(3, 3, 'confirmed', 'em_producao', 'pagar_na_retirada', 120),
    makeFormula(4, 4, 'confirmed', 'aguardando_retirada', 'pago', 160),
    makeFormula(5, 5, 'confirmed', 'aguardando_retirada', 'pagar_na_retirada', 100),
    makeFormula(6, 1, 'delivered', 'entregue', 'pago', 180),
    makeFormula(7, 2, 'delivered', 'entregue', 'pago', 140),
    makeFormula(8, 3, 'pending', '', '', 120),
    makeFormula(9, 4, 'pending', '', '', 160),
  ];
  return { user, customers, insumos, formulas };
}
