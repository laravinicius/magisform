import { describe, expect, it } from 'vitest';
import { fixtureOrder, fixtureUser } from './fixtures/contracts';

describe('contratos de pedidos', () => {
  it('mantém os dados de usuário e pedido livres de credenciais e tokens', () => {
    expect(JSON.stringify({ user: fixtureUser, order: fixtureOrder })).not.toMatch(/password|token|secret|credential/i);
  });

  it('preserva composição, valores decimais e data civil', () => {
    expect(fixtureOrder.items[0]).toMatchObject({ name: 'Insumo QA', quantity: 0.5, unit: 'mg' });
    expect(fixtureOrder.budget_items[0].value).toBe(12.5);
    expect(fixtureOrder.delivery_date).toBe('2026-12-01');
  });
});
