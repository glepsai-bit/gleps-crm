/**
 * Routes Configuration
 * 
 * Centralized definition of all application routes.
 * Used for navigation, permissions, and route guards.
 */

export const ROUTES = {
  // ============= PUBLIC ROUTES =============
  PUBLIC: {
    LOGIN: '/login',
    UNAUTHORIZED: '/unauthorized',
    FORGOT_PASSWORD: '/forgot-password',
    RESET_PASSWORD: '/reset-password',
  },

  // ============= SUPER ADMIN ROUTES =============
  SUPER_ADMIN: {
    DASHBOARD: '/super-admin',
    ACCOUNTS: '/super-admin/accounts',
    ACCOUNT_DETAIL: (id: string) => `/super-admin/accounts/${id}`,
    USERS: '/super-admin/users',
    EVENTS: '/super-admin/events',
    SETTINGS: '/super-admin/settings',
  },

  // ============= ADMIN ROUTES =============
  ADMIN: {
    DASHBOARD: '/admin',
    KANBAN: '/admin/kanban',
    LEADS: '/admin/leads',
    SALES: '/admin/sales',
    FINANCE: '/admin/finance',
    PRODUCTS: '/admin/products',
    AGENDA: '/admin/agenda',
    INSIGHTS: '/admin/insights',
    EVENTS: '/admin/events',
    PROSPECCAO: '/admin/prospeccao',
    EMAILS: '/admin/emails',
    SETTINGS: '/admin/settings',
    USERS: '/admin/users',
  },

  // ============= AGENT ROUTES =============
  AGENT: {
    HOME: '/agent',
    KANBAN: '/agent/kanban',
    LEADS: '/agent/leads',
    AGENDA: '/agent/agenda',
  },
} as const;

// Route to permission mapping
export const ROUTE_PERMISSIONS: Record<string, string> = {
  [ROUTES.ADMIN.DASHBOARD]: 'dashboard',
  [ROUTES.ADMIN.KANBAN]: 'kanban',
  [ROUTES.ADMIN.LEADS]: 'leads',
  [ROUTES.ADMIN.SALES]: 'sales',
  [ROUTES.ADMIN.FINANCE]: 'finance',
  [ROUTES.ADMIN.PRODUCTS]: 'products',
  [ROUTES.ADMIN.AGENDA]: 'agenda',
  [ROUTES.ADMIN.INSIGHTS]: 'insights',
  [ROUTES.ADMIN.EVENTS]: 'events',
  [ROUTES.ADMIN.PROSPECCAO]: 'extracao',
  [ROUTES.ADMIN.EMAILS]: 'emails',
};

// Default routes by role
export const DEFAULT_ROUTES_BY_ROLE = {
  super_admin: ROUTES.SUPER_ADMIN.DASHBOARD,
  admin: ROUTES.ADMIN.DASHBOARD,
  agent: ROUTES.ADMIN.KANBAN, // Agents default to kanban
} as const;

export default ROUTES;
