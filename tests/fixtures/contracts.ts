import type { CustomerDto, FormulaDto, UserDto } from '../../shared/contracts';

export const fixtureUser: UserDto = {
  id: 70001, name: 'QA Farmacêutica', username: 'qa-farmaceutica', role: 'pharmacist',
};

export const fixtureCustomer: CustomerDto = {
  id: 70001, name: 'QA Cliente Sintético', phone: '11900007001', responsible_id: null,
};

export const fixtureFormula: FormulaDto = {
  created_by_name: null,
  id: 70001,
  customer_id: fixtureCustomer.id,
  customer_name: fixtureCustomer.name,
  customer_phone: fixtureCustomer.phone ?? '',
  attendant_name: fixtureUser.name,
  status: 'pending',
  created_at: '2026-10-08 12:00:00',
  items: [{ insumo_id: 70001, insumo_name: 'Insumo QA', quantity: 1, unit: 'mg' }],
  budget_number: 'Q70001',
  budget_items: [{ quantity: 30, unit: 'caps', value: 12.5, is_selected: true }],
  payment_status: 'pendente',
  delivery_status: '',
};
