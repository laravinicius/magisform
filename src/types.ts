import type {
  BudgetItemDto,
  CustomerDto,
  FormulaDto,
  FormulaItemDto,
  InsumoDto,
  SavedFormulaDto,
  SavedFormulaItemDto,
  UserDto,
  UserRole,
} from '../shared/contracts';

export type User = UserDto;
export type Customer = CustomerDto;
export type Insumo = InsumoDto;
export type FormulaItem = FormulaItemDto;
export type BudgetItem = BudgetItemDto;
export type Formula = FormulaDto;
export type SavedFormulaItem = SavedFormulaItemDto;
export type SavedFormula = SavedFormulaDto;
export type { UserRole };

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  employee: 'Funcionário',
  pharmacist: 'Farmacêutico',
  manager: 'Gerente',
  admin: 'Administrador',
};

export const canManageUsers = (role: UserRole) => role !== 'employee';

export type { PaymentStatus, SummaryPaymentStatus, FormulaPaymentUpdate } from '../shared/contracts';
