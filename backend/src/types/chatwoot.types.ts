// ============================================
// Chatwoot API Types
// ============================================

export interface ChatwootAgent {
  id: number;
  uid: string;
  name: string;
  available_name: string;
  display_name: string;
  email: string;
  account_id: number;
  role: 'agent' | 'administrator';
  confirmed: boolean;
  availability_status: 'online' | 'busy' | 'offline';
  auto_offline: boolean;
  custom_attributes: Record<string, any>;
  thumbnail?: string;
}

export interface ChatwootLabel {
  id: number;
  title: string;
  description?: string;
  color: string;
  show_on_sidebar: boolean;
}

export interface ChatwootInbox {
  id: number;
  channel_id: number;
  name: string;
  channel_type: 'Channel::Whatsapp' | 'Channel::FacebookPage' | 'Channel::TwitterProfile' | 'Channel::TwilioSms' | 'Channel::Api' | 'Channel::WebWidget' | 'Channel::Email' | 'Channel::Telegram' | 'Channel::Line' | 'Channel::Sms';
  avatar_url?: string;
  widget_color?: string;
  website_url?: string;
  greeting_enabled: boolean;
  greeting_message?: string;
  working_hours_enabled: boolean;
  timezone?: string;
  phone_number?: string;
}

export interface ChatwootContact {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
  thumbnail?: string;
  additional_attributes: Record<string, any>;
  custom_attributes: Record<string, any>;
  created_at: number;
  last_activity_at?: number;
}

export interface ChatwootConversation {
  id: number;
  account_id: number;
  inbox_id: number;
  status: 'open' | 'resolved' | 'pending' | 'snoozed';
  priority?: 'urgent' | 'high' | 'medium' | 'low' | null;
  assignee_id?: number;
  team_id?: number;
  contact_id: number;
  labels: string[];
  additional_attributes: Record<string, any>;
  custom_attributes: Record<string, any>;
  created_at: number;
  can_reply: boolean;
  contact_last_seen_at?: number;
  agent_last_seen_at?: number;
  first_reply_created_at?: number;
  waiting_since?: number;
  snoozed_until?: number;
  unread_count: number;
  last_non_activity_message?: ChatwootMessage;
  messages_count: number;
  meta?: {
    sender?: ChatwootContact;
    assignee?: ChatwootAgent;
    hmac_verified?: boolean;
    channel?: string;
  };
}

export interface ChatwootMessage {
  id: number;
  content?: string;
  content_type?: 'text' | 'input_text' | 'input_textarea' | 'input_email' | 'input_select' | 'cards' | 'form' | 'article' | 'incoming_email' | 'input_csat' | 'integrations';
  content_attributes?: Record<string, any>;
  message_type: 'incoming' | 'outgoing' | 'activity' | 'template';
  created_at: number;
  private: boolean;
  source_id?: string;
  sender_type?: 'user' | 'contact' | 'agent_bot';
  sender?: {
    id: number;
    name: string;
    email?: string;
    type: string;
  };
  conversation_id: number;
  inbox_id: number;
}

// ============================================
// Webhook Event Types
// ============================================

export type ChatwootWebhookEventType =
  | 'conversation_created'
  | 'conversation_status_changed'
  | 'conversation_updated'
  | 'conversation_opened'
  | 'conversation_resolved'
  | 'message_created'
  | 'message_updated'
  | 'webwidget_triggered'
  | 'contact_created'
  | 'contact_updated';

export interface ChatwootWebhookEvent {
  event: ChatwootWebhookEventType;
  id?: number;
  account: {
    id: number;
    name: string;
  };
  conversation?: ChatwootConversation;
  contact?: ChatwootContact;
  message?: ChatwootMessage;
  inbox?: ChatwootInbox;
  sender?: ChatwootAgent;
  labels?: ChatwootLabel[];
  changed_attributes?: Array<{
    previous_value?: any;
    current_value?: any;
  }>;
  event_info?: Record<string, any>;
}

// ============================================
// API Response Types
// ============================================

export interface ChatwootAgentsResponse {
  payload: ChatwootAgent[];
}

export interface ChatwootLabelsResponse {
  payload: ChatwootLabel[];
}

export interface ChatwootInboxesResponse {
  payload: ChatwootInbox[];
}

export interface ChatwootConversationsResponse {
  data: {
    meta: {
      mine_count: number;
      unassigned_count: number;
      all_count: number;
    };
    payload: ChatwootConversation[];
  };
}

export interface ChatwootContactsSearchResponse {
  payload: ChatwootContact[];
}

// ============================================
// Metrics Types
// ============================================

export interface ChatwootAccountMetrics {
  open: number;
  unattended: number;
  pending: number;
  resolved: number;
  all: number;
}

export interface ChatwootAgentMetrics {
  id: number;
  name: string;
  email: string;
  thumbnail?: string;
  open: number;
  pending: number;
  unattended: number;
  resolved: number;
  avg_first_response_time?: number;
  avg_resolution_time?: number;
}

export interface ChatwootReportMetrics {
  conversations_count: number;
  incoming_messages_count: number;
  outgoing_messages_count: number;
  avg_first_response_time: number;
  avg_resolution_time: number;
  resolutions_count: number;
  reply_time?: number;
}

// ============================================
// Request Types
// ============================================

export interface CreateLabelInput {
  title: string;
  description?: string;
  color?: string;
  show_on_sidebar?: boolean;
}

export interface UpdateLabelInput {
  title?: string;
  description?: string;
  color?: string;
  show_on_sidebar?: boolean;
}

export interface ConversationFilters {
  status?: 'open' | 'resolved' | 'pending' | 'snoozed' | 'all';
  inbox_id?: number;
  assignee_type?: 'me' | 'unassigned' | 'all';
  team_id?: number;
  labels?: string[];
  page?: number;
}

export interface DateRange {
  since?: string; // ISO 8601 date string
  until?: string; // ISO 8601 date string
}

// ============================================
// Error Types
// ============================================

export class ChatwootApiError extends Error {
  constructor(
    public statusCode: number,
    public responseBody: string,
    message?: string
  ) {
    super(message || `Chatwoot API Error: ${statusCode}`);
    this.name = 'ChatwootApiError';
  }

  static isRateLimited(error: ChatwootApiError): boolean {
    return error.statusCode === 429;
  }

  static isUnauthorized(error: ChatwootApiError): boolean {
    return error.statusCode === 401;
  }

  static isNotFound(error: ChatwootApiError): boolean {
    return error.statusCode === 404;
  }
}

// ============================================
// Internal Types
// ============================================

export interface ChatwootAccountConfig {
  baseUrl: string;
  accountId: string;
  apiKey: string;
}
