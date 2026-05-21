// CRM Multi-Tenant Types - Matching ARCHITECTURE.md schema exactly

// ============= ENUMS =============
export type UserRole = 'super_admin' | 'admin' | 'agent';
export type AccountStatus = 'active' | 'paused' | 'cancelled';
export type UserStatus = 'active' | 'inactive' | 'suspended';
export type ConversationStatus = 'open' | 'pending' | 'resolved';
export type AssigneeType = 'user' | 'agent_bot';
export type SaleStatus = 'pending' | 'paid' | 'refunded' | 'partial_refund';
export type PaymentMethod = 'pix' | 'boleto' | 'debito' | 'credito' | 'dinheiro' | 'convenio';
export type ActorType = 'user' | 'agent_bot' | 'system' | 'external';
export type TransactionType = 'charge' | 'refund';
export type ContactOrigin = 'whatsapp' | 'instagram' | 'site' | 'indicacao' | 'outro';
export type Channel = 'whatsapp' | 'instagram' | 'webchat';

// ============= CORE ENTITIES =============

export interface Account {
  id: string;
  nome: string;
  timezone: string;
  plano: string | null;
  status: AccountStatus;
  limite_usuarios: number;
  chatwoot_account_id: string | null;
  chatwoot_api_key: string | null;
  chatwoot_base_url: string | null; // Ex: https://app.chatwoot.com ou https://chatwoot.empresa.com
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  account_id: string | null;
  nome: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  permissions?: string[]; // Agent-specific permissions: leads, conversations, sales, events, reports
  chatwoot_agent_id?: number | null; // ID do agente vinculado no Chatwoot
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============= CHATWOOT INTEGRATION =============

export interface ChatwootAgent {
  id: number;
  name: string;
  email: string;
  role: 'agent' | 'administrator';
  availability_status?: 'online' | 'busy' | 'offline';
  thumbnail?: string;
}

export interface AgentBot {
  id: string;
  account_id: string;
  nome: string;
  provider: 'openai' | 'anthropic' | 'custom' | null;
  ativo: boolean;
  config: Record<string, unknown> | null;
  created_at: string;
}

// ============= CONTACTS & CONVERSATIONS =============

export interface Contact {
  id: string;
  account_id: string;
  nome: string | null;
  telefone: string | null;
  email: string | null;
  origem: ContactOrigin | null;
  chatwoot_contact_id?: number | null;
  chatwoot_conversation_id?: number | null;
  followup_count?: number;
  last_followup_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  account_id: string;
  contact_id: string;
  channel: Channel | null;
  status: ConversationStatus;
  assignee_type: AssigneeType | null;
  assignee_id: string | null;
  opened_at: string;
  resolved_at: string | null;
  // UI enrichment
  contact?: Contact;
  assignee?: User | AgentBot;
}

// ============= FUNNEL / KANBAN =============

export interface Funnel {
  id: string;
  account_id: string;
  nome: string;
  ativo: boolean;
  created_at: string;
}

export interface FunnelStage {
  id: string;
  funnel_id: string;
  nome: string;
  ordem: number;
  cor: string | null;
  ativo: boolean;
  created_at: string;
}

export interface LeadFunnelState {
  contact_id: string;
  funnel_stage_id: string | null;
  updated_at: string;
}

export interface LeadFunnelHistory {
  id: string;
  contact_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  reason: string | null;
  created_at: string;
}

// ============= TAGS / ETIQUETAS (CHATWOOT ↔ KANBAN) =============
// CONCEITO: Tags DO Chatwoot = Etapas DO Kanban (são a MESMA entidade)
// - Criar tag "gol" no Chatwoot → aparece etapa "gol" no Kanban
// - Criar etapa "bola" no Kanban → aparece tag "bola" no Chatwoot
// - Tags operacionais (urgente, lead-frio) são complementares e não movem etapa

export type TagType = 'stage' | 'operational';

/**
 * Tag = Etiqueta do Chatwoot que também representa uma Etapa do Kanban (se type === 'stage')
 * A tag é a fonte única de verdade para a estrutura do funil.
 */
export interface Tag {
  id: string;
  account_id: string;
  funnel_id: string; // Vinculada a um funil específico
  name: string;
  slug: string; // slug único usado no Chatwoot (ex: "qualificado", "urgente")
  type: TagType; // 'stage' = etapa do funil, 'operational' = tag complementar
  color: string;
  ordem: number; // Ordem no funil (apenas para type === 'stage')
  ativo: boolean;
  created_at: string;
}

/**
 * Relacionamento Lead ↔ Tag
 * Um lead pode ter UMA tag de stage (sua posição no funil) e MÚLTIPLAS tags operacionais
 */
export interface LeadTag {
  id: string;
  contact_id: string;
  tag_id: string;
  applied_by_type: ActorType;
  applied_by_id: string | null;
  source: 'kanban' | 'chatwoot' | 'system';
  created_at: string;
}

/**
 * Histórico imutável de todas as alterações de tags
 */
export interface TagHistory {
  id: string;
  contact_id: string;
  tag_id: string;
  action: 'added' | 'removed' | 'tag_created';
  actor_type: ActorType;
  actor_id: string | null;
  source: 'kanban' | 'chatwoot' | 'system';
  reason: string | null;
  created_at: string;
}

// ============= LEAD NOTES =============

export interface LeadNote {
  id: string;
  contact_id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: string;
}

// ============= FINANCIAL =============

export interface Product {
  id: string;
  account_id: string;
  nome: string;
  valor_padrao: number;
  metodos_pagamento: PaymentMethod[];
  convenios_aceitos: string[];
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Item individual de uma venda (produto com quantidade e valor)
 */
export interface SaleItem {
  id: string;
  product_id: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
  refunded?: boolean;
  refunded_at?: string | null;
  refund_reason?: string | null;
  // UI enrichment
  product?: Product;
}

export interface Sale {
  id: string;
  account_id: string;
  contact_id: string;
  /** @deprecated Use items[] para múltiplos produtos */
  product_id?: string;
  /** Lista de itens/produtos da venda */
  items: SaleItem[];
  valor: number;
  status: SaleStatus;
  metodo_pagamento: PaymentMethod | null;
  convenio_nome?: string | null;
  responsavel_id: string;
  is_recurring?: boolean;
  refund_reason?: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  // UI enrichment
  contact?: Contact;
  /** @deprecated Use items[].product */
  product?: Product;
}

export interface SaleTransaction {
  id: string;
  sale_id: string;
  tipo: TransactionType;
  valor: number;
  actor_type: ActorType | null;
  actor_id: string | null;
  motivo: string | null;
  created_at: string;
}

// ============= EVENTS / AUDIT =============

export type EventType =
  // Auth
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.session.revoked'
  | 'auth.password.reset'
  // Accounts
  | 'account.created'
  | 'account.updated'
  | 'account.paused'
  | 'account.deleted'
  // Users
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.impersonated'
  // Conversations
  | 'conversation.opened'
  | 'message.received'
  | 'message.sent'
  | 'conversation.assigned.bot'
  | 'conversation.assigned.human'
  | 'conversation.resolved'
  // Funnel
  | 'lead.stage.changed'
  | 'funnel.stage.created'
  | 'funnel.stage.reordered'
  // Tags
  | 'tag.added'
  | 'tag.removed'
  | 'tag.stage.auto_created'
  // Sales
  | 'sale.created'
  | 'sale.paid'
  | 'sale.refunded';

export interface CRMEvent {
  id: string;
  account_id: string | null;
  event_type: EventType;
  actor_type: ActorType;
  actor_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  channel: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// ============= UI TYPES =============

export interface AuthState {
  user: User | null;
  account: Account | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface KanbanLead extends Contact {
  stage_id: string | null;
  conversation?: Conversation;
  last_message?: string;
}

// Dashboard KPIs
export interface SuperAdminKPIs {
  total_accounts: number;
  total_users: number;
  events_count: number;
  active_accounts: number;
  paused_accounts: number;
}

export interface AdminKPIs {
  total_leads: number;
  ia_percentage: number;
  human_percentage: number;
  avg_response_time_minutes: number;
  conversion_rate: number;
  total_revenue: number;
  avg_ticket: number;
  open_conversations: number;
  resolved_today: number;
}

export interface AgentKPIs {
  atendimentos_realizados: number;
  conversoes: number;
  tempo_medio_atendimento_minutes: number;
  leads_atribuidos: number;
}

// Navigation
export interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}
