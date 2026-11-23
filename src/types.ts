import type { UserDto, UserRole, InsumoDto } from '../shared/contracts';

export type User = UserDto;
export type Insumo = InsumoDto;
export type { UserRole };

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  employee: 'Funcionário',
  pharmacist: 'Farmacêutico',
  manager: 'Gerente',
  admin: 'Administrador',
};

export const canManageUsers = (role: UserRole) => role !== 'employee';
