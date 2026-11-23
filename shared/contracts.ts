/** Contratos serializáveis compartilhados entre renderer e adapters. */
export type UserRole = 'employee' | 'pharmacist' | 'manager' | 'admin';

export interface UserDto {
  id: number;
  name: string;
  username: string;
  role: UserRole;
  pharmacy_id?: number | null;
  pharmacy_name?: string | null;
}

export interface PartnerUserDto { id: number; name: string; username: string; active: boolean }
export interface PartnerPharmacyDto { id: number; name: string; created_at: string; users: PartnerUserDto[] }
export interface PartnerPatientDto { id: number; name: string; phone: string }
export interface OrderItemDto { name: string; quantity: number; unit: string }
export interface OrderDataDto {
  patient_name: string;
  patient_phone: string;
  attendant_name: string;
  items: OrderItemDto[];
  budget_number: string;
  budget_items: BudgetItemDto[];
  delivery_date: string | null;
}
export type OrderStatus = 'submitted' | 'under_review' | 'awaiting_approval' | 'accepted';
export type OrderAction = 'submitted' | 'imported' | 'reviewed' | 'accepted' | 'proposed' | 'approved' | 'rejected';
export interface OrderEventDto { id: number; actor_name: string; action: OrderAction; snapshot: OrderDataDto | null; note: string | null; created_at: string }
export interface OrderDto {
  id: number;
  pharmacy_id: number;
  pharmacy_name: string;
  status: OrderStatus;
  original_data: OrderDataDto;
  current_data: OrderDataDto;
  proposed_data: OrderDataDto | null;
  revision: number;
  created_at: string;
  updated_at: string;
  events: OrderEventDto[];
}

export interface InsumoDto { id: number; name: string; created_at?: string }
export interface BudgetItemDto { quantity: number; unit: string; value: number; is_selected?: boolean | number }
export interface UserInputDto { name: string; username: string; role: UserRole; password?: string }
export interface LogFiltersDto {
  userId?: number; action?: string; entity?: string; from?: string; to?: string;
  search?: string; page?: number; pageSize?: number;
}
export interface AuditLogDto {
  id: number; user_id: number | null; user_name: string; action: string; entity: string;
  entity_id: number | null; details: string; created_at: string;
}
export interface LogPageDto { rows: AuditLogDto[]; total: number }
export interface PublicConfigDto {
  installationName: string;
  brand: string;
  brandTheme: {
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    ink: string;
    muted: string;
  };
  version: string;
  capabilities: string[];
}
export interface DataEnvelopeDto<T> { data: T }
export interface ErrorEnvelopeDto { error: AppErrorDto }

export type ErrorCode = 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'SESSION_CONFLICT' | 'CONFLICT' | 'UNAVAILABLE';
export interface AppErrorDto {
  code: ErrorCode;
  message: string;
  requestId?: string;
  fieldErrors?: Record<string, string[]>;
}
export interface OperationResultDto {
  success: boolean;
  id?: number;
  user?: UserDto;
  error?: string;
  code?: ErrorCode;
  conflict?: boolean;
}
export interface BusinessOperations {
  users: { list(): Promise<UserDto[]>; add(input: UserInputDto): Promise<OperationResultDto>; update(id: number, input: Partial<UserInputDto>): Promise<OperationResultDto>; remove(id: number, credentials: { username: string; password: string }): Promise<OperationResultDto> };
  insumos: { list(): Promise<InsumoDto[]>; add(name: string): Promise<OperationResultDto>; update(id: number, name: string): Promise<OperationResultDto>; remove(id: number, credentials: { username: string; password: string }): Promise<OperationResultDto> };
  logs: { list(filters?: LogFiltersDto): Promise<LogPageDto> };
}

