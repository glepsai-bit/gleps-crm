import { useAuth } from '@/contexts/AuthContext';

export type AgentPermission = 
  | 'dashboard' 
  | 'kanban' 
  | 'leads' 
  | 'agenda'
  | 'sales' 
  | 'finance'
  | 'products'
  | 'events' 
  | 'insights'
  | 'extracao'
  | 'emails'
  | 'refunds';

// Map routes to required permissions
const routePermissionMap: Record<string, AgentPermission> = {
  '/admin': 'dashboard',
  '/admin/kanban': 'kanban',
  '/admin/leads': 'leads',
  '/admin/agenda': 'agenda',
  '/admin/sales': 'sales',
  '/admin/finance': 'finance',
  '/admin/products': 'products',
  '/admin/events': 'events',
  '/admin/insights': 'insights',
  '/admin/extracao': 'extracao',
  '/admin/prospeccao': 'extracao',
  '/admin/emails': 'emails',
};

export function usePermissions() {
  const { user } = useAuth();
  
  const hasPermission = (permission: AgentPermission): boolean => {
    // Super Admin and Admin have all permissions
    if (user?.role === 'super_admin' || user?.role === 'admin') {
      return true;
    }
    // Agents check their permissions array
    return user?.permissions?.includes(permission) ?? false;
  };
  
  const canAccessRoute = (route: string): boolean => {
    // Super Admin and Admin can access all routes
    if (user?.role === 'super_admin' || user?.role === 'admin') {
      return true;
    }
    
    const permission = routePermissionMap[route];
    return permission ? hasPermission(permission) : true;
  };

  const getFirstAllowedRoute = (): string => {
    // Super Admin and Admin default to dashboard
    if (user?.role === 'super_admin' || user?.role === 'admin') {
      return '/admin';
    }

    // For agents, find the first permitted route
    const routeOrder = [
      '/admin',
      '/admin/kanban',
      '/admin/leads',
      '/admin/agenda',
      '/admin/sales',
      '/admin/finance',
      '/admin/products',
      '/admin/events',
      '/admin/insights',
      '/admin/extracao',
      '/admin/prospeccao',
      '/admin/emails',
    ];

    for (const route of routeOrder) {
      if (canAccessRoute(route)) {
        return route;
      }
    }

    return '/admin'; // Fallback
  };
  
  return { hasPermission, canAccessRoute, getFirstAllowedRoute };
}
