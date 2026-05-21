/**
 * API Request/Response Types
 * 
 * Standardized types for API communication.
 * These types are used by services and hooks for type-safe API calls.
 */

// ============= COMMON TYPES =============

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DateRangeParams {
  startDate?: string;
  endDate?: string;
}

// ============= AUTH TYPES =============

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: {
    id: string;
    email: string;
    nome: string;
    role: 'super_admin' | 'admin' | 'agent';
    permissions?: string[];
  };
  account: {
    id: string;
    nome: string;
    status: 'active' | 'paused' | 'cancelled';
  } | null;
  token: string;
  refreshToken: string;
}

export interface RefreshTokenResponse {
  token: string;
  refreshToken: string;
}

// ============= CONTACT TYPES =============

export interface ContactListParams extends PaginationParams {
  search?: string;
  stageId?: string;
  origem?: string;
}

export interface CreateContactRequest {
  nome: string;
  telefone?: string;
  email?: string;
  origem?: 'whatsapp' | 'instagram' | 'site' | 'indicacao';
}

export interface UpdateContactRequest {
  nome?: string;
  telefone?: string;
  email?: string;
  origem?: 'whatsapp' | 'instagram' | 'site' | 'indicacao';
}

export interface MoveContactRequest {
  toStageId: string;
  reason?: string;
}

export interface AddNoteRequest {
  content: string;
}

// ============= SALE TYPES =============

export interface SaleListParams extends PaginationParams, DateRangeParams {
  status?: 'pending' | 'paid' | 'refunded';
  contactId?: string;
  responsavelId?: string;
  paymentMethod?: string;
}

export interface CreateSaleRequest {
  contactId: string;
  items: {
    productId: string;
    quantidade: number;
    valorUnitario: number;
  }[];
  metodoPagamento: 'pix' | 'boleto' | 'debito' | 'credito' | 'dinheiro' | 'convenio';
  convenioNome?: string;
  responsavelId: string;
  isRecurring?: boolean;
}

export interface RefundSaleRequest {
  reason: string;
}

export interface RefundItemRequest {
  reason: string;
  quantity?: number;
}

export interface SaleStatsResponse {
  totalRevenue: number;
  totalSales: number;
  pendingAmount: number;
  refundedAmount: number;
  avgTicket: number;
  byPaymentMethod: Record<string, { count: number; total: number }>;
}

// ============= PRODUCT TYPES =============

export interface ProductListParams extends PaginationParams {
  ativo?: boolean;
  search?: string;
}

export interface CreateProductRequest {
  nome: string;
  valorPadrao: number;
  metodosPagamento: ('pix' | 'boleto' | 'debito' | 'credito' | 'dinheiro' | 'convenio')[];
  conveniosAceitos?: string[];
}

export interface UpdateProductRequest {
  nome?: string;
  valorPadrao?: number;
  metodosPagamento?: ('pix' | 'boleto' | 'debito' | 'credito' | 'dinheiro' | 'convenio')[];
  conveniosAceitos?: string[];
  ativo?: boolean;
}

// ============= TAG TYPES =============

export interface TagListParams {
  funnelId?: string;
  type?: 'stage' | 'operational';
  ativo?: boolean;
}

export interface CreateTagRequest {
  name: string;
  type: 'stage' | 'operational';
  color: string;
  funnelId: string;
  ordem?: number;
}

export interface UpdateTagRequest {
  name?: string;
  color?: string;
  ordem?: number;
  ativo?: boolean;
}

export interface ReorderTagsRequest {
  tags: { id: string; ordem: number }[];
}

export interface ApplyTagRequest {
  tagId: string;
  source?: 'kanban' | 'chatwoot' | 'system';
}

// ============= USER TYPES =============

export interface UserListParams extends PaginationParams {
  role?: 'super_admin' | 'admin' | 'agent';
  status?: 'active' | 'inactive' | 'suspended';
  accountId?: string;
}

export interface CreateUserRequest {
  email: string;
  nome: string;
  password: string;
  role: 'admin' | 'agent';
  accountId: string;
  permissions?: string[];
  chatwootAgentId?: number;
}

export interface UpdateUserRequest {
  nome?: string;
  email?: string;
  role?: 'admin' | 'agent';
  status?: 'active' | 'inactive' | 'suspended';
  permissions?: string[];
  chatwootAgentId?: number;
}

// ============= ACCOUNT TYPES =============

export interface AccountListParams extends PaginationParams {
  status?: 'active' | 'paused' | 'cancelled';
  search?: string;
}

export interface CreateAccountRequest {
  nome: string;
  plano?: string;
  limiteUsuarios?: number;
  timezone?: string;
  chatwootAccountId?: string;
  chatwootApiKey?: string;
  chatwootBaseUrl?: string;
}

export interface UpdateAccountRequest {
  nome?: string;
  plano?: string;
  status?: 'active' | 'paused' | 'cancelled';
  limiteUsuarios?: number;
  timezone?: string;
  chatwootAccountId?: string;
  chatwootApiKey?: string;
  chatwootBaseUrl?: string;
}

// ============= CALENDAR TYPES =============

export interface CalendarEventListParams extends DateRangeParams {
  responsavelId?: string;
  status?: 'scheduled' | 'cancelled';
}

export interface CreateCalendarEventRequest {
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  contactId?: string;
  responsavelId: string;
  location?: string;
  isAllDay?: boolean;
}

export interface UpdateCalendarEventRequest {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  status?: 'scheduled' | 'cancelled';
  location?: string;
}

// ============= DASHBOARD TYPES =============

export interface DashboardParams extends DateRangeParams {
  agentId?: string;
}

export interface SuperAdminKPIsResponse {
  totalAccounts: number;
  activeAccounts: number;
  pausedAccounts: number;
  totalUsers: number;
  eventsCount: number;
}

export interface AdminKPIsResponse {
  totalLeads: number;
  iaPercentage: number;
  humanPercentage: number;
  avgResponseTimeMinutes: number;
  conversionRate: number;
  totalRevenue: number;
  avgTicket: number;
  openConversations: number;
  resolvedToday: number;
}

export interface AgentKPIsResponse {
  atendimentosRealizados: number;
  conversoes: number;
  tempoMedioAtendimentoMinutes: number;
  leadsAtribuidos: number;
}
