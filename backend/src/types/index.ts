import { Request } from 'express';
import { UserRole, UserStatus, AccountStatus } from '@prisma/client';

// Authenticated User payload from JWT
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  accountId: string | null;
  permissions: string[];
  iat: number;
  exp: number;
}

// Extended Express Request with authenticated user
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
    accountId: string | null;
    permissions: string[];
    nome: string;
    status: UserStatus;
  };
  account?: {
    id: string;
    nome: string;
    status: AccountStatus;
    timezone: string;
    chatwootBaseUrl: string | null;
    chatwootAccountId: string | null;
    chatwootApiKey: string | null;
  };
}

// Pagination
export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
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

// API Response types
export interface ApiResponse<T = unknown> {
  data?: T;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Sort params
export interface SortParams {
  field: string;
  order: 'asc' | 'desc';
}

// Date range filter
export interface DateRangeFilter {
  startDate?: Date;
  endDate?: Date;
}

// Permission types
export type Permission =
  | 'dashboard'
  | 'kanban'
  | 'leads'
  | 'agenda'
  | 'sales'
  | 'finance'
  | 'products'
  | 'events'
  | 'insights'
  | 'refunds'
  | 'emails'
  | 'extracao';

export const ALL_PERMISSIONS: Permission[] = [
  'dashboard',
  'kanban',
  'leads',
  'agenda',
  'sales',
  'finance',
  'products',
  'events',
  'insights',
  'refunds',
  'emails',
  'extracao',
];

// Event types for audit
export type EventType =
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.token.refresh'
  | 'auth.password.reset'
  | 'account.created'
  | 'account.updated'
  | 'account.paused'
  | 'account.activated'
  | 'account.deleted'
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.suspended'
  | 'user.impersonated'
  | 'lead.created'
  | 'lead.updated'
  | 'lead.stage.changed'
  | 'lead.tag.added'
  | 'lead.tag.removed'
  | 'sale.created'
  | 'sale.paid'
  | 'sale.refunded'
  | 'sale.item.refunded'
  | 'funnel.stage.created'
  | 'funnel.stage.updated'
  | 'funnel.stage.deleted'
  | 'funnel.stage.reordered';
