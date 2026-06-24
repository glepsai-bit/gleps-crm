/**
 * Inboxes Backend Service (T-022)
 *
 * CRUD dos canais de atendimento (`Inbox` no schema Prisma).
 * Suporta whatsapp / email / facebook / instagram.
 *
 * Backend: backend/src/routes/inbox.routes.ts (controller -> inboxChannelService)
 * Auth: JWT + (super_admin|admin) + accountId obrigatório.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export type InboxChannelType = 'whatsapp' | 'email' | 'facebook' | 'instagram';

/**
 * Estado da conexão Evolution para um inbox whatsapp (DISP-07).
 * - `open`: pareado e pronto pra enviar
 * - `connecting`: aguardando QR / handshake
 * - `close`: deslogado/expirado
 * - `unknown`: Evolution não respondeu ou instance não existe na global
 * - `null`: não aplicável (inbox não-whatsapp ou sem evolutionInstance)
 */
export type InboxConnectionState =
  | 'open'
  | 'connecting'
  | 'close'
  | 'unknown'
  | null;

export interface InboxBusinessHours {
  // Ex.: { mon: { open: '08:00', close: '18:00' }, ... }
  [day: string]: { open: string; close: string };
}

export interface Inbox {
  id: string;
  accountId: string;
  name: string;
  channelType: InboxChannelType;
  evolutionInstance: string | null;
  greeting: string | null;
  businessHours: InboxBusinessHours | null;
  defaultTeamId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * DISP-07: estado da conexão Evolution. Devolvido por GET /api/inboxes;
   * endpoints individuais (GET /:id, POST/PUT) podem não populá-lo —
   * defaulta a `undefined` nesse caso.
   */
  connectionState?: InboxConnectionState;
}

export interface CreateInboxInput {
  name: string;
  channelType: InboxChannelType;
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: InboxBusinessHours | null;
  defaultTeamId?: string | null;
}

export interface UpdateInboxInput {
  name?: string;
  channelType?: InboxChannelType;
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: InboxBusinessHours | null;
  defaultTeamId?: string | null;
  active?: boolean;
}

/**
 * Backend devolve campos em camelCase (Prisma client). Mapeamos
 * defensivamente caso algum endpoint volte snake_case — alinhado com o
 * padrão de outros services (users/tags).
 */
function mapInbox(raw: any): Inbox {
  // DISP-07: connectionState pode vir como snake_case do legacy; só populamos
  // se o backend enviou explicitamente, senão fica undefined (consumers tratam
  // como "estado desconhecido — não bloquear").
  const connectionStateRaw =
    raw.connectionState ?? raw.connection_state ?? undefined;
  const allowed: InboxConnectionState[] = ['open', 'connecting', 'close', 'unknown', null];
  const connectionState: InboxConnectionState | undefined =
    connectionStateRaw === undefined
      ? undefined
      : allowed.includes(connectionStateRaw as InboxConnectionState)
        ? (connectionStateRaw as InboxConnectionState)
        : 'unknown';

  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id,
    name: raw.name,
    channelType: raw.channelType ?? raw.channel_type,
    evolutionInstance: raw.evolutionInstance ?? raw.evolution_instance ?? null,
    greeting: raw.greeting ?? null,
    businessHours: raw.businessHours ?? raw.business_hours ?? null,
    defaultTeamId: raw.defaultTeamId ?? raw.default_team_id ?? null,
    active: raw.active ?? true,
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at,
    connectionState,
  };
}

function unwrap<T = any>(response: any): T {
  // Controllers do T-022 retornam { data: ... }. Mantém compat com
  // endpoints legados que devolvem o objeto cru.
  return (response?.data ?? response) as T;
}

export const inboxesBackendService = {
  async listInboxes(): Promise<Inbox[]> {
    const response = await apiClient.get<any>(API_ENDPOINTS.INBOXES.LIST);
    const raw = unwrap<any[]>(response);
    return (Array.isArray(raw) ? raw : []).map(mapInbox);
  },

  async getInbox(id: string): Promise<Inbox> {
    const response = await apiClient.get<any>(API_ENDPOINTS.INBOXES.GET(id));
    return mapInbox(unwrap(response));
  },

  async createInbox(body: CreateInboxInput): Promise<Inbox> {
    const response = await apiClient.post<any>(API_ENDPOINTS.INBOXES.CREATE, body);
    return mapInbox(unwrap(response));
  },

  async updateInbox(id: string, body: UpdateInboxInput): Promise<Inbox> {
    // Backend usa PUT em /inboxes/:id (ver inbox.routes.ts).
    const response = await apiClient.put<any>(API_ENDPOINTS.INBOXES.UPDATE(id), body);
    return mapInbox(unwrap(response));
  },

  async deleteInbox(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.INBOXES.DELETE(id));
  },
};

export default inboxesBackendService;
