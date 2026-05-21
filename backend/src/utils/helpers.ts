import { Request } from 'express';
import { PaginationParams, SortParams, DateRangeFilter } from '../types';

/**
 * Extract pagination parameters from request query
 */
export function getPaginationParams(req: Request): PaginationParams {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Extract sort parameters from request query
 */
export function getSortParams(
  req: Request,
  defaultField: string = 'createdAt',
  allowedFields: string[] = []
): SortParams {
  const field = req.query.sort as string || defaultField;
  const order = (req.query.order as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc';

  // Validate field if allowedFields provided
  if (allowedFields.length > 0 && !allowedFields.includes(field)) {
    return { field: defaultField, order };
  }

  return { field, order };
}

/**
 * Extract date range filter from request query
 */
export function getDateRangeFilter(req: Request): DateRangeFilter {
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

  return {
    startDate: startDate && !isNaN(startDate.getTime()) ? startDate : undefined,
    endDate: endDate && !isNaN(endDate.getTime()) ? endDate : undefined,
  };
}

/**
 * Calculate pagination metadata
 */
export function getPaginationMeta(total: number, params: PaginationParams) {
  return {
    page: params.page,
    limit: params.limit,
    total,
    totalPages: Math.ceil(total / params.limit),
  };
}

/**
 * Generate slug from name
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9]+/g, '-')     // Replace non-alphanumeric with -
    .replace(/^-+|-+$/g, '')         // Remove leading/trailing -
    .substring(0, 100);              // Limit length
}

/**
 * Mask sensitive data for logging
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const maskedLocal = local.length > 2
    ? `${local[0]}***${local[local.length - 1]}`
    : '***';
  return `${maskedLocal}@${domain}`;
}

/**
 * Parse ms string to milliseconds (e.g., "1h", "7d")
 */
export function parseTimeToMs(time: string): number {
  const match = time.match(/^(\d+)([smhd])$/);
  if (!match) return 0;

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

/**
 * Get expiration date from time string
 */
export function getExpirationDate(timeString: string): Date {
  const ms = parseTimeToMs(timeString);
  return new Date(Date.now() + ms);
}

/**
 * Check if string is valid UUID
 */
export function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Safe JSON parse
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Remove undefined values from object
 */
export function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

/**
 * Calculate percentage
 */
export function calculatePercentage(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100 * 100) / 100; // 2 decimal places
}

/**
 * Format currency (BRL)
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}
