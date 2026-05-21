/**
 * Configuration Barrel Export
 * 
 * Central export point for all configuration files.
 */

export { apiConfig, apiFeatures } from './api.config';
export { useBackend, useSupabase } from './backend.config';
export { ROUTES, ROUTE_PERMISSIONS, DEFAULT_ROUTES_BY_ROLE } from './routes.config';
export { PERMISSIONS, ROLE_PERMISSIONS, PERMISSION_GROUPS, ACTION_PERMISSIONS } from './permissions.config';
export type { Permission } from './permissions.config';
