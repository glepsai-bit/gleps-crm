/**
 * Email Module Frontend Service
 * Dynamically switches between Express backend and Supabase Cloud.
 */

import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// ==================== TYPES ====================

export interface EmailCadenceStep {
  id: string;
  cadence_id: string;
  template_id?: string | null;
  day_number: number;
  subject: string;
  body_html: string;
  body_text?: string | null;
  ordem: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailCadenceRule {
  id: string;
  cadence_id: string;
  trigger_event: 'opened' | 'clicked' | 'not_opened' | 'bounced';
  target_cadence_id: string;
  delay_hours: number;
  timeout_hours?: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  target_cadence?: { id: string; name: string };
}

export interface EmailCadence {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  active: boolean;
  target_stage_ids?: string[];
  send_at_time?: string;
  start_date?: string;
  campaign_id?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  steps?: EmailCadenceStep[];
  rules?: EmailCadenceRule[];
}

export interface EmailTemplate {
  id: string;
  account_id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text?: string | null;
  category?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailEnrollment {
  id: string;
  account_id: string;
  cadence_id: string;
  contact_id: string;
  status: string;
  current_step: number;
  next_send_at?: string | null;
  enrolled_at: string;
  completed_at?: string | null;
  contact?: { id: string; nome?: string; email?: string };
  cadence?: EmailCadence;
}

export interface EmailSend {
  id: string;
  account_id: string;
  contact_id: string;
  to_email: string;
  subject: string;
  status: string;
  sent_at?: string | null;
  opened_at?: string | null;
  clicked_at?: string | null;
  bounced_at?: string | null;
  error_message?: string | null;
  created_at: string;
  contact?: { id: string; nome?: string; email?: string };
}

export interface SendStats {
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
}

export interface GeneratedEmail {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export interface EmailCampaign {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  audience_id?: string | null;
  active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  cadences?: EmailCadence[];
}

export interface EmailInboxMessage {
  id: string;
  account_id: string;
  contact_id?: string | null;
  from_email: string;
  to_email: string;
  subject: string;
  body_text?: string | null;
  body_html?: string | null;
  read: boolean;
  replied: boolean;
  replied_at?: string | null;
  received_at: string;
  enrollment_id?: string | null;
  contact?: { id: string; nome?: string; email?: string };
}

export interface InboxDiagnostics {
  webhookUrl: string;
  totalMessages: number;
  unreadMessages: number;
  latestReceivedAt: string | null;
  latestFromEmail: string | null;
  sendgridConfigured: boolean;
  sendgridFromEmail: string | null;
}

export interface EmailSearchResult {
  contact: any | null;
  enrollments: any[];
  sends: EmailSend[];
}

// ==================== MAPPER ====================

function mapCadence(c: any): EmailCadence {
  return {
    id: c.id,
    account_id: c.account_id ?? c.accountId,
    name: c.name,
    description: c.description,
    active: c.active,
    target_stage_ids: c.target_stage_ids ?? c.targetStageIds ?? [],
    send_at_time: c.send_at_time ?? c.sendAtTime ?? '09:00',
    start_date: c.start_date ?? c.startDate ?? null,
    campaign_id: c.campaign_id ?? c.campaignId ?? null,
    created_by: c.created_by ?? c.createdBy,
    created_at: c.created_at ?? c.createdAt,
    updated_at: c.updated_at ?? c.updatedAt,
    steps: (c.steps || []).map(mapStep),
    rules: (c.rulesFrom || c.rules || []).map(mapRule),
  };
}

function mapCampaign(c: any): EmailCampaign {
  return {
    id: c.id,
    account_id: c.account_id ?? c.accountId,
    name: c.name,
    description: c.description,
    audience_id: c.audience_id ?? c.audienceId ?? null,
    active: c.active ?? true,
    created_by: c.created_by ?? c.createdBy,
    created_at: c.created_at ?? c.createdAt,
    updated_at: c.updated_at ?? c.updatedAt,
    cadences: (c.cadences || []).map(mapCadence),
  };
}

function mapRule(r: any): EmailCadenceRule {
  return {
    id: r.id,
    cadence_id: r.cadence_id ?? r.cadenceId,
    trigger_event: r.trigger_event ?? r.triggerEvent,
    target_cadence_id: r.target_cadence_id ?? r.targetCadenceId,
    delay_hours: r.delay_hours ?? r.delayHours ?? 0,
    active: r.active ?? true,
    created_at: r.created_at ?? r.createdAt,
    updated_at: r.updated_at ?? r.updatedAt,
    target_cadence: r.target_cadence ?? r.targetCadence,
  };
}

function mapStep(s: any): EmailCadenceStep {
  return {
    id: s.id,
    cadence_id: s.cadence_id ?? s.cadenceId,
    template_id: s.template_id ?? s.templateId ?? null,
    day_number: s.day_number ?? s.dayNumber,
    subject: s.subject,
    body_html: s.body_html ?? s.bodyHtml,
    body_text: s.body_text ?? s.bodyText,
    ordem: s.ordem ?? 0,
    active: s.active ?? true,
    created_at: s.created_at ?? s.createdAt,
    updated_at: s.updated_at ?? s.updatedAt,
  };
}

function mapTemplate(t: any): EmailTemplate {
  return {
    id: t.id,
    account_id: t.account_id ?? t.accountId,
    name: t.name,
    subject: t.subject,
    body_html: t.body_html ?? t.bodyHtml,
    body_text: t.body_text ?? t.bodyText,
    category: t.category,
    created_by: t.created_by ?? t.createdBy,
    created_at: t.created_at ?? t.createdAt,
    updated_at: t.updated_at ?? t.updatedAt,
  };
}

function mapSend(s: any): EmailSend {
  return {
    id: s.id,
    account_id: s.account_id ?? s.accountId,
    contact_id: s.contact_id ?? s.contactId,
    to_email: s.to_email ?? s.toEmail,
    subject: s.subject,
    status: s.status,
    sent_at: s.sent_at ?? s.sentAt,
    opened_at: s.opened_at ?? s.openedAt,
    clicked_at: s.clicked_at ?? s.clickedAt,
    bounced_at: s.bounced_at ?? s.bouncedAt,
    error_message: s.error_message ?? s.errorMessage,
    created_at: s.created_at ?? s.createdAt,
    contact: s.contact,
  };
}

// ==================== SERVICE ====================

function unwrap<T>(res: any): T {
  return res?.data ?? res;
}

export const emailApiService = {
  // Cadences
  async listCadences(): Promise<EmailCadence[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.CADENCES);
    return (unwrap<any[]>(res) || []).map(mapCadence);
  },

  async getCadence(id: string): Promise<EmailCadence> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.CADENCE(id));
    return mapCadence(unwrap(res));
  },

  async createCadence(data: { name: string; description?: string; targetStageIds?: string[]; sendAtTime?: string; startDate?: string }): Promise<EmailCadence> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.CADENCES, data);
    return mapCadence(unwrap(res));
  },

  async updateCadence(id: string, data: Partial<{ name: string; description: string; targetStageIds: string[]; active: boolean; sendAtTime: string; startDate: string }>): Promise<EmailCadence> {
    const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.CADENCE(id), data);
    return mapCadence(unwrap(res));
  },

  async deleteCadence(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.CADENCE(id));
  },

  // Steps
  async createStep(cadenceId: string, data: { dayNumber: number; subject: string; bodyHtml: string; bodyText?: string; ordem?: number; templateId?: string | null }): Promise<EmailCadenceStep> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.CADENCE_STEPS(cadenceId), data);
    return mapStep(unwrap(res));
  },

  async updateStep(id: string, data: Partial<{ dayNumber: number; subject: string; bodyHtml: string; bodyText: string; active: boolean; ordem: number; templateId: string | null }>): Promise<EmailCadenceStep> {
    const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.STEP(id), data);
    return mapStep(unwrap(res));
  },

  async deleteStep(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.STEP(id));
  },

  // Templates
  async listTemplates(): Promise<EmailTemplate[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.TEMPLATES);
    return (unwrap<any[]>(res) || []).map(mapTemplate);
  },

  async createTemplate(data: { name: string; subject: string; bodyHtml: string; bodyText?: string; category?: string }): Promise<EmailTemplate> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.TEMPLATES, data);
    return mapTemplate(unwrap(res));
  },

  async updateTemplate(id: string, data: Partial<{ name: string; subject: string; bodyHtml: string; bodyText: string; category: string }>): Promise<EmailTemplate> {
    const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.TEMPLATE(id), data);
    return mapTemplate(unwrap(res));
  },

  async deleteTemplate(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.TEMPLATE(id));
  },

  // Enrollments
  async enroll(cadenceId: string, contactIds: string[]): Promise<EmailEnrollment[]> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.ENROLL, { cadenceId, contactIds });
    return unwrap<any[]>(res) || [];
  },

  async unenroll(cadenceId: string, contactIds: string[]): Promise<void> {
    await apiClient.post(API_ENDPOINTS.EMAIL.UNENROLL, { cadenceId, contactIds });
  },

  async listEnrollments(cadenceId?: string): Promise<EmailEnrollment[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.ENROLLMENTS, {
      params: cadenceId ? { cadenceId } : {},
    });
    return unwrap<any[]>(res) || [];
  },

  // Sends
  async listSends(filters?: { cadenceId?: string; contactId?: string; status?: string; limit?: number; offset?: number }): Promise<EmailSend[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.SENDS, { params: filters });
    return (unwrap<any[]>(res) || []).map(mapSend);
  },

  async getSendStats(): Promise<SendStats> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.SEND_STATS);
    return unwrap<SendStats>(res);
  },

  // AI
  async generateEmail(prompt: string, context?: { leadName?: string; leadEmail?: string; stageName?: string }): Promise<GeneratedEmail> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.AI_GENERATE, { prompt, context });
    return unwrap<GeneratedEmail>(res);
  },

  // Settings
  async getSettings(): Promise<{ hasOpenaiKey: boolean; hasSendgridKey: boolean; sendgridFromEmail: string; sendgridFromName: string }> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.SETTINGS);
    return unwrap(res);
  },

  async updateSettings(data: { openaiApiKey?: string; sendgridApiKey?: string; sendgridFromEmail?: string; sendgridFromName?: string }): Promise<void> {
    await apiClient.put(API_ENDPOINTS.EMAIL.SETTINGS, data);
  },

  // Process queue
  async processQueue(cadenceId?: string): Promise<{ success: boolean; processed: number }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.PROCESS_QUEUE, { cadenceId });
    return unwrap(res);
  },

  // Tests
  async testSendgrid(apiKey: string): Promise<{ success: boolean; message: string }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.TEST_SENDGRID, { apiKey });
    return unwrap(res);
  },

  async testSendEmail(apiKey: string, fromEmail: string, fromName: string, toEmail: string, options?: { subject?: string; html?: string; text?: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.TEST_SEND, { apiKey, fromEmail, fromName, toEmail, ...options });
    return unwrap(res);
  },

  async testOpenai(apiKey: string): Promise<{ success: boolean; message: string }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.TEST_OPENAI, { apiKey });
    return unwrap(res);
  },

  // Cadence Rules
  async listRules(cadenceId: string): Promise<EmailCadenceRule[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.CADENCE_RULES(cadenceId));
    return (unwrap<any[]>(res) || []).map(mapRule);
  },

  async createRule(cadenceId: string, data: { triggerEvent: string; targetCadenceId: string; delayHours?: number; timeoutHours?: number }): Promise<EmailCadenceRule> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.CADENCE_RULES(cadenceId), data);
    return mapRule(unwrap(res));
  },

  async updateRule(id: string, data: Partial<{ triggerEvent: string; targetCadenceId: string; delayHours: number; active: boolean }>): Promise<EmailCadenceRule> {
    const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.RULE(id), data);
    return mapRule(unwrap(res));
  },

  async deleteRule(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.RULE(id));
  },

  // Campaigns
  async listCampaigns(): Promise<EmailCampaign[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.CAMPAIGNS);
    return (unwrap<any[]>(res) || []).map(mapCampaign);
  },

  async createCampaign(data: { name: string; description?: string; audienceId?: string | null }): Promise<EmailCampaign> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.CAMPAIGNS, data);
    return mapCampaign(unwrap(res));
  },

  async updateCampaign(id: string, data: Partial<{ name: string; description: string; active: boolean; audienceId: string | null }>): Promise<EmailCampaign> {
    const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.CAMPAIGN(id), data);
    return mapCampaign(unwrap(res));
  },

  async deleteCampaign(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.CAMPAIGN(id));
  },

  async addCadenceToCampaign(campaignId: string, cadenceId: string): Promise<void> {
    await apiClient.post(API_ENDPOINTS.EMAIL.CAMPAIGN_CADENCES(campaignId), { cadenceId });
  },

  async removeCadenceFromCampaign(campaignId: string, cadenceId: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.EMAIL.CAMPAIGN_CADENCES(campaignId) + `?cadenceId=${cadenceId}`);
  },

  async getCampaignStats(campaignId: string): Promise<SendStats & { enrollments: number }> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.CAMPAIGN_STATS(campaignId));
    return unwrap(res);
  },

  async dispatchCampaignNow(campaignId: string, cadenceId?: string): Promise<{ enrolled: number; skipped: number; processed: number; cadenceId: string; cadenceName: string }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.CAMPAIGN_DISPATCH_NOW(campaignId), cadenceId ? { cadenceId } : {});
    return unwrap(res);
  },

  // Inbox
  async listInboxMessages(filters?: { read?: boolean; limit?: number }): Promise<EmailInboxMessage[]> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.INBOX, { params: filters });
    return unwrap<any[]>(res) || [];
  },

  async getInboxMessage(id: string): Promise<EmailInboxMessage> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.INBOX_MESSAGE(id));
    return unwrap(res);
  },

  async markInboxRead(id: string): Promise<void> {
    await apiClient.put(API_ENDPOINTS.EMAIL.INBOX_MARK_READ(id));
  },

  async getUnreadCount(): Promise<number> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.INBOX_UNREAD);
    return unwrap<any>(res)?.count || 0;
  },

  async replyToMessage(messageId: string, data: { subject: string; bodyHtml: string; bodyText?: string }): Promise<{ success: boolean }> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.INBOX_REPLY, { messageId, ...data });
    return unwrap(res);
  },

  async suggestReply(messageId: string, instructions?: string): Promise<GeneratedEmail> {
    const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.INBOX_SUGGEST_REPLY, { messageId, instructions });
    return unwrap(res);
  },

  async getInboxDiagnostics(): Promise<InboxDiagnostics> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.INBOX_DIAGNOSTICS);
    return unwrap(res);
  },

  async markInboxRepliedManually(id: string): Promise<void> {
    await apiClient.put(API_ENDPOINTS.EMAIL.INBOX_MARK_REPLIED(id));
  },

  async pauseEnrollmentFromInbox(id: string): Promise<void> {
    await apiClient.post(API_ENDPOINTS.EMAIL.INBOX_PAUSE_ENROLLMENT(id), {});
  },

  async resumeEnrollmentFromInbox(id: string): Promise<void> {
    await apiClient.post(API_ENDPOINTS.EMAIL.INBOX_RESUME_ENROLLMENT(id), {});
  },

  async unenrollFromInbox(id: string): Promise<void> {
    await apiClient.post(API_ENDPOINTS.EMAIL.INBOX_UNENROLL(id), {});
  },

  // Search
  async searchByEmail(email: string): Promise<EmailSearchResult> {
    const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.SEARCH, { params: { email } });
    return unwrap(res);
  },
};

// ==================== DYNAMIC SERVICE SELECTOR ====================
import { emailCloudService } from './email.cloud.service';

/**
 * Automatically selects the correct service based on VITE_USE_BACKEND.
 * Cloud mode → Supabase direct queries
 * Backend mode → Express API calls
 */
export const emailService = useBackend ? emailApiService : emailCloudService;
