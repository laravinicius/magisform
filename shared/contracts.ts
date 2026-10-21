/** Contratos serializáveis compartilhados entre renderer e adapters. */
export type UserRole = 'employee' | 'pharmacist' | 'manager' | 'admin';

export interface UserDto {
  id: number;
  name: string;
  username: string;
  role: UserRole;
}

export interface CustomerDto {
  id: number;
  name: string;
  phone: string | null;
  responsible_id?: number | null;
  responsible_name?: string | null;
  responsible_phone?: string | null;
  created_at?: string;
}

export interface InsumoDto { id: number; name: string; created_at?: string }
export interface FormulaItemDto { insumo_id: number; insumo_name: string; quantity: number; unit?: string }
export interface BudgetItemDto { quantity: number; unit: string; value: number; is_selected?: boolean | number }
export type FormulaStatus = 'pending' | 'confirmed' | 'cancelled' | 'delivered';

export type PaymentStatus = 'pago' | 'parcial' | 'pagar_na_retirada';
export type SummaryPaymentStatus = PaymentStatus | 'nao_pago';
export interface FormulaPaymentUpdate { payment_status: PaymentStatus; partial_payment_amount: number | null }

export interface FormulaDto {
  created_by_name: string | null;
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  responsible_name?: string | null;
  attendant_name: string;
  status: FormulaStatus;
  created_at: string;
  items: FormulaItemDto[];
  budget_number?: string;
  budget_items?: BudgetItemDto[];
  delivery_date?: string | null;
  delivered_at?: string | null;
  payment_status?: string;
  partial_payment_amount?: number | string | null;
  payment_method?: string | null;
  delivery_status?: string;
  manager_verified?: boolean | number;
  cancel_reason?: string | null;
}

export interface FormulaListQueryDto {
  cursor?: string | null;
  limit: number;
  statuses?: FormulaStatus[];
  deliveryStatus?: string;
  search?: string;
}
export interface FormulaListPageDto {
  rows: FormulaDto[];
  nextCursor: string | null;
  total: number;
  limit: number;
}
export interface FormulaSummaryDto {
  total: number;
  pending: number;
  confirmed: number;
  deliveredMonthlyTotal: number;
  deliveredYears: number[];
}

export interface SavedFormulaItemDto { insumo_id: number; insumo_name?: string; quantity: number; unit?: string }
export interface SavedFormulaDto {
  created_by_name: string | null;
  id: number;
  name: string;
  budget_number?: string;
  created_at?: string;
  items: SavedFormulaItemDto[];
  budget_items?: BudgetItemDto[];
}

export interface UserInputDto { name: string; username: string; password: string; role: UserRole }
export interface CustomerInputDto { name: string; phone: string | null; responsible_customer_id?: number | null }
export interface FormulaInputDto {
  customer_id: number;
  attendant_name: string;
  items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
  budget_number?: string;
  budget_items?: Array<{ quantity: number; unit: string; value: number; is_selected?: boolean | number }>;
  delivery_date?: string | null;
  payment_status?: string;
  partial_payment_amount?: number | null;
  payment_method?: string | null;
  delivery_status?: string;
  cancel_reason?: string | null;
  status?: FormulaStatus;
}
export interface SavedFormulaInputDto {
  name: string;
  budget_number?: string;
  items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
  budget_items: Array<{ quantity: number; unit: string; value: number }>;
}
export interface AdminCredentialsDto { username: string; password: string }
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
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(error: AppErrorDto) {
    super(error.message);
    this.name = 'AppError';
    this.code = error.code;
    this.requestId = error.requestId;
    this.fieldErrors = error.fieldErrors;
  }
}
export interface OperationResultDto {
  success: boolean;
  id?: number;
  user?: UserDto;
  error?: string;
  code?: ErrorCode;
  conflict?: boolean;
}
export interface SessionStateDto {
  /** Validade da sessão consultada pelo heartbeat. */
  valid?: boolean;
  authenticated: boolean;
  user: UserDto | null;
  /** Metadados para o adapter; tokens de browser nunca fazem parte do estado do renderer. */
  expiresAt?: string | null;
}

export interface BusinessOperations {
  users: { list(): Promise<UserDto[]>; add(input: UserInputDto): Promise<OperationResultDto>; update(id: number, input: Partial<UserInputDto>): Promise<OperationResultDto>; remove(id: number, credentials?: AdminCredentialsDto): Promise<OperationResultDto> };
  customers: { list(): Promise<CustomerDto[]>; add(input: CustomerInputDto): Promise<OperationResultDto>; update(id: number, input: Partial<CustomerInputDto>): Promise<OperationResultDto>; remove(id: number, credentials?: AdminCredentialsDto): Promise<OperationResultDto> };
  insumos: { list(): Promise<InsumoDto[]>; add(name: string): Promise<OperationResultDto>; update(id: number, name: string): Promise<OperationResultDto>; remove(id: number, credentials?: AdminCredentialsDto): Promise<OperationResultDto> };
  formulas: { list(query: FormulaListQueryDto): Promise<FormulaListPageDto>; get(id: number): Promise<FormulaDto | null>; summary(month: number, year: number, paymentStatus?: SummaryPaymentStatus, activity?: 'user' | 'passive'): Promise<FormulaSummaryDto>; add(input: FormulaInputDto): Promise<OperationResultDto>; update(id: number, input: FormulaInputDto): Promise<OperationResultDto>; updateStatus(id: number, status: string): Promise<OperationResultDto>; updatePayment(id: number, payment: FormulaPaymentUpdate): Promise<OperationResultDto>; updateDeliveryStatus(id: number, status: string): Promise<OperationResultDto>; verify(id: number): Promise<OperationResultDto>; updateDeliveriesStatus(ids: number[], status: string): Promise<OperationResultDto>; remove(id: number, credentials?: AdminCredentialsDto): Promise<OperationResultDto> };
  savedFormulas: { list(): Promise<SavedFormulaDto[]>; add(input: SavedFormulaInputDto): Promise<OperationResultDto>; update(id: number, input: SavedFormulaInputDto): Promise<OperationResultDto>; remove(id: number, credentials?: AdminCredentialsDto): Promise<OperationResultDto> };
  logs: { list(filters?: LogFiltersDto): Promise<LogPageDto> };
}

export interface PlatformCapabilities {
  window: boolean; updater: boolean; connectionConfiguration: boolean;
  nativeDialogs: boolean; externalLinks: boolean; exitConfirmation: boolean;
}
export interface PlatformOperations {
  capabilities(): PlatformCapabilities;
  version(): Promise<string>;
}
export interface SessionOperations {
  current(): Promise<SessionStateDto>;
  login(username: string, password: string, force?: boolean): Promise<OperationResultDto>;
  logout(): Promise<void>;
  heartbeat(): Promise<SessionStateDto>;
}

