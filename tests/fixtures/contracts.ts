import type { OrderDataDto, UserDto } from '../../shared/contracts';

export const fixtureUser: UserDto = {
  id: 70001, name: 'QA Farmacêutica', username: 'qa-farmaceutica', role: 'pharmacist',
};

export const fixtureOrder: OrderDataDto = {
  patient_name: 'Paciente sintético', patient_phone: '11900007001', attendant_name: fixtureUser.name,
  items: [{ name: 'Insumo QA', quantity: 0.5, unit: 'mg' }],
  budget_number: 'Q70001', budget_items: [{ quantity: 30, unit: 'caps', value: 12.5, is_selected: true }],
  delivery_date: '2026-12-01',
};
