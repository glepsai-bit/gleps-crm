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
  '/admin/extracao': 'extracao',
  '/admin/prospeccao': 'extracao',
  '/admin/emails': 'emails',
};

// Rotas restritas a admin/super_admin (sem permissao equivalente para agents)
const adminOnlyRoutes = new Set<string>([
  '/admin/whatsapp-templates',
  '/admin/warmup',
  '/admin/integracoes',
  '/admin/opt-outs',
  // Atendimento (T-022): o CHAT em si (/admin/chat) NAO e admin-only — e a
  // capacidade fundamental de todo agente num CRM de WhatsApp. O backend ja
  // libera a rota (requireRole inclui 'agent') e escopa as conversas por
  // agente (assigneeId/team/participant em conversation.service). O que fica
  // admin-only sao as telas de GESTAO/CONFIG do atendimento, abaixo.
  '/admin/chat/dashboard', // metricas de atendimento (visao gerencial)
  '/admin/inboxes',
  '/admin/teams',
  '/admin/canned-responses',
  // SLA oculto (rotas removidas do App.tsx). Entradas SLA retiradas daqui.
  '/admin/custom-attributes',
  // T-024 — admin gerencia agentes da propria conta
  '/admin/agentes',
]);

// Rotas que TODO agente acessa por padrao, independente da lista granular de
// permissions. Chat entra aqui porque e o nucleo do produto e o isolamento
// ja e garantido pelo backend (o agente so ve as proprias conversas).
const agentDefaultRoutes = new Set<string>(['/admin/chat']);

export function usePermissions() {
  const { user } = useAuth();

  // T-025/BUG-01 (PERMS-JWT-ADMIN): super_admin e admin tem acesso TOTAL ao
  // proprio painel. O JWT pode trazer user.permissions=['dashboard'] (default
  // do schema) quando o admin foi criado sem ajuste manual, mas isso NAO deve
  // bloquear a UI — o isolamento por conta ja eh garantido pelo backend
  // (requireAccountId). A checagem granular de permissions so se aplica a
  // role='agent'. Mantemos esse bypass explicito como contrato.
  const isAdminLike = user?.role === 'super_admin' || user?.role === 'admin';

  const hasPermission = (permission: AgentPermission): boolean => {
    // Super Admin and Admin have all permissions (bypass JWT permissions array)
    if (isAdminLike) {
      return true;
    }
    // Agents check their permissions array
    return user?.permissions?.includes(permission) ?? false;
  };

  const canAccessRoute = (route: string): boolean => {
    // Super Admin and Admin can access all routes — bypass total, sem olhar
    // adminOnlyRoutes nem permissions. (granular continua so para agent)
    if (isAdminLike) {
      return true;
    }

    // Rotas marcadas como admin-only nunca sao acessadas por agents
    if (adminOnlyRoutes.has(route)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('[canAccessRoute] DENY (admin-only):', route, 'role=', user?.role);
      }
      return false;
    }

    // Rotas liberadas a todo agente por padrao (chat). Precede o mapa granular.
    if (agentDefaultRoutes.has(route)) {
      return true;
    }

    const permission = routePermissionMap[route];
    if (permission) {
      const allowed = hasPermission(permission);
      if (import.meta.env.DEV && !allowed) {
        // eslint-disable-next-line no-console
        console.debug('[canAccessRoute] DENY (missing permission):', route, 'permission=', permission, 'userPerms=', user?.permissions);
      }
      return allowed;
    }

    // Por seguranca, rotas /admin/* nao mapeadas sao negadas para agents
    if (route.startsWith('/admin/')) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('[canAccessRoute] DENY (unmapped /admin/* route):', route);
      }
      return false;
    }

    return true;
  };

  const getFirstAllowedRoute = (): string => {
    // Super Admin and Admin default to dashboard
    if (isAdminLike) {
      return '/admin';
    }

    // For agents, find the first permitted route.
    // Chat vem primeiro: e onde o agente trabalha (atendimento).
    const routeOrder = [
      '/admin/chat',
      '/admin',
      '/admin/kanban',
      '/admin/leads',
      '/admin/agenda',
      '/admin/sales',
      '/admin/finance',
      '/admin/products',
      '/admin/events',
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
