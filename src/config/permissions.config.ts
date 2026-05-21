/**
 * Permissions Configuration
 * 
 * Centralized definition of all permissions and role-based access rules.
 */

// All available permissions
export const PERMISSIONS = {
  // Dashboard & Reports
  DASHBOARD: 'dashboard',
  INSIGHTS: 'insights',
  EVENTS: 'events',
  
  // CRM Features
  KANBAN: 'kanban',
  LEADS: 'leads',
  CONVERSATIONS: 'conversations',
  
  // Sales & Finance
  SALES: 'sales',
  FINANCE: 'finance',
  PRODUCTS: 'products',
  REFUNDS: 'refunds',
  
  // Calendar
  AGENDA: 'agenda',
  
  // Extraction
  EXTRACAO: 'extracao',
  
  // Email
  EMAILS: 'emails',
  
  // Administration
  USERS: 'users',
  SETTINGS: 'settings',
  FUNNEL: 'funnel',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

// Permissions by role
export const ROLE_PERMISSIONS = {
  super_admin: Object.values(PERMISSIONS), // All permissions
  admin: Object.values(PERMISSIONS), // All permissions within account
  agent: [] as Permission[], // Defined per-user
} as const;

// Permission groups for UI organization
export const PERMISSION_GROUPS = {
  ATENDIMENTO: {
    label: 'Atendimento',
    permissions: [PERMISSIONS.KANBAN, PERMISSIONS.LEADS, PERMISSIONS.CONVERSATIONS],
  },
  VENDAS: {
    label: 'Vendas',
    permissions: [PERMISSIONS.SALES, PERMISSIONS.FINANCE, PERMISSIONS.PRODUCTS],
  },
  RELATORIOS: {
    label: 'Relatórios',
    permissions: [PERMISSIONS.DASHBOARD, PERMISSIONS.INSIGHTS, PERMISSIONS.EVENTS],
  },
  AGENDA: {
    label: 'Agenda',
    permissions: [PERMISSIONS.AGENDA],
  },
  PROSPECCAO: {
    label: 'Prospecção',
    permissions: [PERMISSIONS.EXTRACAO],
  },
  EMAILS: {
    label: 'E-mails',
    permissions: [PERMISSIONS.EMAILS],
  },
  ADMIN: {
    label: 'Administração',
    permissions: [PERMISSIONS.USERS, PERMISSIONS.SETTINGS, PERMISSIONS.FUNNEL],
  },
} as const;

// Required permissions for specific actions
export const ACTION_PERMISSIONS = {
  createSale: [PERMISSIONS.SALES],
  refundSale: [PERMISSIONS.SALES, PERMISSIONS.REFUNDS],
  moveLead: [PERMISSIONS.KANBAN],
  manageUsers: [PERMISSIONS.USERS],
  manageFunnel: [PERMISSIONS.FUNNEL],
  viewDashboard: [PERMISSIONS.DASHBOARD],
  viewInsights: [PERMISSIONS.INSIGHTS],
} as const;

export default PERMISSIONS;
