/**
 * Email Cloud Service
 * Uses Supabase directly for email module when VITE_USE_BACKEND=false.
 */

import { supabase } from '@/integrations/supabase/client';
import type {
  EmailCadence, EmailCadenceStep, EmailCadenceRule,
  EmailTemplate, EmailEnrollment, EmailSend, SendStats, GeneratedEmail,
} from './email.service';

function mapRow(row: any): any {
  return row; // Supabase already returns snake_case matching our types
}

export const emailCloudService = {
  // ==================== CADENCES ====================
  async listCadences(): Promise<EmailCadence[]> {
    const { data, error } = await supabase
      .from('email_cadences')
      .select('*, steps:email_cadence_steps(*), rules:email_cadence_rules!email_cadence_rules_cadence_id_fkey(*)')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(c => ({
      ...c,
      steps: (c.steps || []).sort((a: any, b: any) => a.day_number - b.day_number),
      rules: (c.rules || []).map((r: any) => ({ ...r, trigger_event: r.trigger_event as EmailCadenceRule['trigger_event'] })),
    })) as EmailCadence[];
  },

  async getCadence(id: string): Promise<EmailCadence> {
    const { data, error } = await supabase
      .from('email_cadences')
      .select('*, steps:email_cadence_steps(*), rules:email_cadence_rules!email_cadence_rules_cadence_id_fkey(*)')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return {
      ...data,
      steps: (data.steps || []).sort((a: any, b: any) => a.day_number - b.day_number),
      rules: (data.rules || []).map((r: any) => ({ ...r, trigger_event: r.trigger_event as EmailCadenceRule['trigger_event'] })),
    } as EmailCadence;
  },

  async createCadence(input: { name: string; description?: string; targetStageIds?: string[]; sendAtTime?: string; startDate?: string }): Promise<EmailCadence> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Não autenticado');
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');

    const { data, error } = await supabase
      .from('email_cadences')
      .insert({
        account_id: profile.account_id,
        name: input.name,
        description: input.description || null,
        target_stage_ids: input.targetStageIds || [],
        send_at_time: input.sendAtTime || '09:00',
        start_date: input.startDate || new Date().toISOString().split('T')[0],
        created_by: user.id,
      })
      .select('*, steps:email_cadence_steps(*), rules:email_cadence_rules!email_cadence_rules_cadence_id_fkey(*)')
      .single();
    if (error) throw new Error(error.message);
    return { ...data, steps: [], rules: [] };
  },

  async updateCadence(id: string, input: Partial<{ name: string; description: string; targetStageIds: string[]; active: boolean; sendAtTime: string; startDate: string }>): Promise<EmailCadence> {
    const updateData: any = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.targetStageIds !== undefined) updateData.target_stage_ids = input.targetStageIds;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.sendAtTime !== undefined) updateData.send_at_time = input.sendAtTime;
    if (input.startDate !== undefined) updateData.start_date = input.startDate;

    const { data, error } = await supabase
      .from('email_cadences')
      .update(updateData)
      .eq('id', id)
      .select('*, steps:email_cadence_steps(*), rules:email_cadence_rules!email_cadence_rules_cadence_id_fkey(*)')
      .single();
    if (error) throw new Error(error.message);
    return {
      ...data,
      steps: (data.steps || []).sort((a: any, b: any) => a.day_number - b.day_number),
      rules: (data.rules || []).map((r: any) => ({ ...r, trigger_event: r.trigger_event as EmailCadenceRule['trigger_event'] })),
    } as EmailCadence;
  },

  async deleteCadence(id: string): Promise<void> {
    const { error } = await supabase.from('email_cadences').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  // ==================== STEPS ====================
  async createStep(cadenceId: string, input: { dayNumber: number; subject: string; bodyHtml: string; bodyText?: string; ordem?: number; templateId?: string | null }): Promise<EmailCadenceStep> {
    const { data, error } = await supabase
      .from('email_cadence_steps')
      .insert({
        cadence_id: cadenceId,
        day_number: input.dayNumber,
        subject: input.subject,
        body_html: input.bodyHtml,
        body_text: input.bodyText || null,
        ordem: input.ordem || 0,
        template_id: input.templateId || null,
      } as any)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailCadenceStep;
  },

  async updateStep(id: string, input: Partial<{ dayNumber: number; subject: string; bodyHtml: string; bodyText: string; active: boolean; ordem: number; templateId: string | null }>): Promise<EmailCadenceStep> {
    const updateData: any = {};
    if (input.dayNumber !== undefined) updateData.day_number = input.dayNumber;
    if (input.subject !== undefined) updateData.subject = input.subject;
    if (input.bodyHtml !== undefined) updateData.body_html = input.bodyHtml;
    if (input.bodyText !== undefined) updateData.body_text = input.bodyText;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.ordem !== undefined) updateData.ordem = input.ordem;
    if (input.templateId !== undefined) updateData.template_id = input.templateId;

    const { data, error } = await supabase
      .from('email_cadence_steps')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailCadenceStep;
  },

  async deleteStep(id: string): Promise<void> {
    const { error } = await supabase.from('email_cadence_steps').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  // ==================== TEMPLATES ====================
  async listTemplates(): Promise<EmailTemplate[]> {
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as EmailTemplate[];
  },

  async createTemplate(input: { name: string; subject: string; bodyHtml: string; bodyText?: string; category?: string }): Promise<EmailTemplate> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Não autenticado');
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');

    const { data, error } = await supabase
      .from('email_templates')
      .insert({
        account_id: profile.account_id,
        name: input.name,
        subject: input.subject,
        body_html: input.bodyHtml,
        body_text: input.bodyText || null,
        category: input.category || null,
        created_by: user.id,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailTemplate;
  },

  async updateTemplate(id: string, input: Partial<{ name: string; subject: string; bodyHtml: string; bodyText: string; category: string }>): Promise<EmailTemplate> {
    const updateData: any = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.subject !== undefined) updateData.subject = input.subject;
    if (input.bodyHtml !== undefined) updateData.body_html = input.bodyHtml;
    if (input.bodyText !== undefined) updateData.body_text = input.bodyText;
    if (input.category !== undefined) updateData.category = input.category;

    const { data, error } = await supabase
      .from('email_templates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailTemplate;
  },

  async deleteTemplate(id: string): Promise<void> {
    const { error } = await supabase.from('email_templates').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  // ==================== ENROLLMENTS ====================
  async enroll(cadenceId: string, contactIds: string[]): Promise<EmailEnrollment[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Não autenticado');
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');

    const inserts = contactIds.map(contactId => ({
      account_id: profile.account_id!,
      cadence_id: cadenceId,
      contact_id: contactId,
      status: 'active' as const,
      current_step: 0,
    }));

    const { data, error } = await supabase
      .from('email_enrollments')
      .insert(inserts)
      .select();
    if (error) throw new Error(error.message);
    return (data || []) as EmailEnrollment[];
  },

  async unenroll(cadenceId: string, contactIds: string[]): Promise<void> {
    const { error } = await supabase
      .from('email_enrollments')
      .update({ status: 'unsubscribed' as any })
      .eq('cadence_id', cadenceId)
      .in('contact_id', contactIds);
    if (error) throw new Error(error.message);
  },

  async listEnrollments(cadenceId?: string): Promise<EmailEnrollment[]> {
    let query = supabase.from('email_enrollments').select('*, contact:contacts(id, nome, email)');
    if (cadenceId) query = query.eq('cadence_id', cadenceId);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as EmailEnrollment[];
  },

  // ==================== SENDS ====================
  async listSends(filters?: { cadenceId?: string; contactId?: string; status?: string; limit?: number; offset?: number }): Promise<EmailSend[]> {
    let query = supabase.from('email_sends').select('*, contact:contacts(id, nome, email)');
    if (filters?.cadenceId) {
      // filter via enrollment
    }
    if (filters?.contactId) query = query.eq('contact_id', filters.contactId);
    if (filters?.status) query = query.eq('status', filters.status as any);
    query = query.order('created_at', { ascending: false }).limit(filters?.limit || 50);
    if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);
    
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data || []) as EmailSend[];
  },

  async getSendStats(): Promise<SendStats> {
    const { data, error } = await supabase.from('email_sends').select('status, sent_at, opened_at, clicked_at, bounced_at');
    if (error) throw new Error(error.message);
    const rows = data || [];
    
    return {
      total: rows.length,
      // Sent: Anything that was sent (not just currently in 'sent' status)
      sent: rows.filter(r => r.sent_at || ['sent', 'delivered', 'opened', 'clicked', 'bounced'].includes(r.status)).length,
      // Delivered: Reached destination
      delivered: rows.filter(r => ['delivered', 'opened', 'clicked'].includes(r.status)).length,
      // Opened: Actually opened
      opened: rows.filter(r => r.opened_at || ['opened', 'clicked'].includes(r.status)).length,
      // Clicked: Actually clicked
      clicked: rows.filter(r => r.clicked_at || r.status === 'clicked').length,
      // Bounced: Refused by recipient server
      bounced: rows.filter(r => r.bounced_at || r.status === 'bounced').length,
      // Failed: Technical failure before sending
      failed: rows.filter(r => r.status === 'failed').length,
    };
  },

  // ==================== AI (placeholder - needs backend) ====================
  async generateEmail(prompt: string, context?: { leadName?: string; leadEmail?: string; stageName?: string }): Promise<GeneratedEmail> {
    throw new Error('Geração de IA requer configuração do backend. Configure a chave OpenAI nas configurações da conta.');
  },

  // ==================== SETTINGS ====================
  async getSettings(): Promise<{ hasOpenaiKey: boolean; hasSendgridKey: boolean; sendgridFromEmail: string; sendgridFromName: string }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Não autenticado');
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');

    const { data: acc, error } = await supabase
      .from('accounts')
      .select('openai_api_key, sendgrid_api_key, sendgrid_from_email, sendgrid_from_name')
      .eq('id', profile.account_id)
      .single();
    if (error) throw new Error(error.message);
    return {
      hasOpenaiKey: !!acc?.openai_api_key,
      hasSendgridKey: !!acc?.sendgrid_api_key,
      sendgridFromEmail: acc?.sendgrid_from_email || '',
      sendgridFromName: acc?.sendgrid_from_name || '',
    };
  },

  async updateSettings(data: { openaiApiKey?: string; sendgridApiKey?: string; sendgridFromEmail?: string; sendgridFromName?: string }): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Não autenticado');
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');

    const updateData: any = {};
    if (data.openaiApiKey !== undefined) updateData.openai_api_key = data.openaiApiKey || null;
    if (data.sendgridApiKey !== undefined) updateData.sendgrid_api_key = data.sendgridApiKey || null;
    if (data.sendgridFromEmail !== undefined) updateData.sendgrid_from_email = data.sendgridFromEmail || null;
    if (data.sendgridFromName !== undefined) updateData.sendgrid_from_name = data.sendgridFromName || null;

    const { error } = await supabase.from('accounts').update(updateData).eq('id', profile.account_id);
    if (error) throw new Error(error.message);
  },

  // ==================== PROCESS QUEUE (calls edge function) ====================
  async processQueue(): Promise<{ success: boolean; processed: number }> {
    const { data, error } = await supabase.functions.invoke('email-integration', {
      body: { action: 'process-queue' },
    });
    if (error) throw new Error(error.message);
    return data;
  },

  // ==================== TESTS (calls edge function) ====================
  async testSendgrid(apiKey: string): Promise<{ success: boolean; message: string }> {
    const { data, error } = await supabase.functions.invoke('email-integration', {
      body: { action: 'test-connection', apiKey },
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async testSendEmail(apiKey: string, fromEmail: string, fromName: string, toEmail: string, options?: { subject?: string; html?: string; text?: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { data, error } = await supabase.functions.invoke('email-integration', {
      body: { 
        action: 'test-send', 
        apiKey, 
        fromEmail, 
        fromName, 
        toEmail,
        subject: options?.subject,
        html: options?.html,
        text: options?.text,
      },
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async testOpenai(apiKey: string): Promise<{ success: boolean; message: string }> {
    // This might still need backend or another edge function, but let's at least try to route it if needed.
    // For now, let's keep it as is or route to email-integration if I add OpenAI there.
    return { success: false, message: 'Teste de OpenAI requer implementação de Edge Function.' };
  },

  // ==================== RULES ====================
  async listRules(cadenceId: string): Promise<EmailCadenceRule[]> {
    const { data, error } = await supabase
      .from('email_cadence_rules')
      .select('*')
      .eq('cadence_id', cadenceId);
    if (error) throw new Error(error.message);
    return (data || []) as EmailCadenceRule[];
  },

  async createRule(cadenceId: string, input: { triggerEvent: string; targetCadenceId: string; delayHours?: number }): Promise<EmailCadenceRule> {
    const { data, error } = await supabase
      .from('email_cadence_rules')
      .insert({
        cadence_id: cadenceId,
        trigger_event: input.triggerEvent,
        target_cadence_id: input.targetCadenceId,
        delay_hours: input.delayHours || 0,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailCadenceRule;
  },

  async updateRule(id: string, input: Partial<{ triggerEvent: string; targetCadenceId: string; delayHours: number; active: boolean }>): Promise<EmailCadenceRule> {
    const updateData: any = {};
    if (input.triggerEvent !== undefined) updateData.trigger_event = input.triggerEvent;
    if (input.targetCadenceId !== undefined) updateData.target_cadence_id = input.targetCadenceId;
    if (input.delayHours !== undefined) updateData.delay_hours = input.delayHours;
    if (input.active !== undefined) updateData.active = input.active;

    const { data, error } = await supabase
      .from('email_cadence_rules')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as EmailCadenceRule;
  },

  async deleteRule(id: string): Promise<void> {
    const { error } = await supabase.from('email_cadence_rules').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  // ==================== CAMPAIGNS ====================
  async listCampaigns(): Promise<any[]> {
    const { data, error } = await supabase
      .from('email_campaigns' as any)
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  },

  async createCampaign(input: { name: string; description?: string; audienceId?: string | null }): Promise<any> {
    const { data: profile } = await supabase.from('profiles').select('account_id').single();
    if (!profile?.account_id) throw new Error('Conta não encontrada');
    const { data, error } = await supabase
      .from('email_campaigns' as any)
      .insert({ account_id: profile.account_id, name: input.name, description: input.description, audience_id: input.audienceId ?? null })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  },

  async updateCampaign(id: string, input: Partial<{ name: string; description: string; active: boolean; audienceId: string | null }>): Promise<any> {
    const updateData: any = { ...input };
    if ('audienceId' in updateData) {
      updateData.audience_id = updateData.audienceId;
      delete updateData.audienceId;
    }

    const { data, error } = await supabase
      .from('email_campaigns' as any)
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteCampaign(id: string): Promise<void> {
    const { error } = await supabase.from('email_campaigns' as any).delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async addCadenceToCampaign(campaignId: string, cadenceId: string): Promise<void> {
    const { error } = await supabase
      .from('email_cadences')
      .update({ campaign_id: campaignId } as any)
      .eq('id', cadenceId);
    if (error) throw new Error(error.message);
  },

  async removeCadenceFromCampaign(_campaignId: string, cadenceId: string): Promise<void> {
    const { error } = await supabase
      .from('email_cadences')
      .update({ campaign_id: null } as any)
      .eq('id', cadenceId);
    if (error) throw new Error(error.message);
  },

  async getCampaignStats(campaignId: string): Promise<any> {
    // Get cadences linked to this campaign using raw filter to avoid type depth issues
    const { data: cadences } = await (supabase
      .from('email_cadences')
      .select('id') as any)
      .eq('campaign_id', campaignId);
    const cadenceIds: string[] = (cadences || []).map((c: any) => c.id);
    if (cadenceIds.length === 0) {
      return { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: 0 };
    }
    // Get enrollments for these cadences
    const { data: enrollmentRows } = await supabase
      .from('email_enrollments')
      .select('id')
      .in('cadence_id', cadenceIds);
    const enrollmentIds: string[] = (enrollmentRows || []).map((e: any) => e.id);
    if (enrollmentIds.length === 0) {
      return { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: enrollmentRows?.length || 0 };
    }
    // Aggregate sends
    const { data: sends } = await supabase
      .from('email_sends')
      .select('status, sent_at, opened_at, clicked_at, bounced_at')
      .in('enrollment_id', enrollmentIds);
    const s = sends || [];
    
    return {
      total: s.length,
      sent: s.filter((x: any) => x.sent_at || ['sent', 'delivered', 'opened', 'clicked', 'bounced'].includes(x.status)).length,
      delivered: s.filter((x: any) => ['delivered', 'opened', 'clicked'].includes(x.status)).length,
      opened: s.filter((x: any) => x.opened_at || ['opened', 'clicked'].includes(x.status)).length,
      clicked: s.filter((x: any) => x.clicked_at || x.status === 'clicked').length,
      bounced: s.filter((x: any) => x.bounced_at || x.status === 'bounced').length,
      failed: s.filter((x: any) => x.status === 'failed').length,
      enrollments: enrollmentRows?.length || 0,
    };
  },

  // ==================== INBOX ====================
  async listInboxMessages(filters?: { read?: boolean; limit?: number }): Promise<any[]> {
    let query = supabase
      .from('email_inbox_messages' as any)
      .select('*, contact:contacts(id, nome, email)')
      .order('received_at', { ascending: false })
      .limit(filters?.limit || 50);
    if (filters?.read !== undefined) query = query.eq('read', filters.read);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  },

  async getInboxMessage(id: string): Promise<any> {
    const { data, error } = await supabase
      .from('email_inbox_messages' as any)
      .select('*, contact:contacts(id, nome, email)')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data;
  },

  async markInboxRead(id: string): Promise<void> {
    const { error } = await supabase
      .from('email_inbox_messages' as any)
      .update({ read: true })
      .eq('id', id);
    if (error) throw new Error(error.message);
  },

  async getUnreadCount(): Promise<number> {
    const { count, error } = await supabase
      .from('email_inbox_messages' as any)
      .select('*', { count: 'exact', head: true })
      .eq('read', false);
    if (error) throw new Error(error.message);
    return count || 0;
  },

  async replyToMessage(_messageId: string, _data: { subject: string; bodyHtml: string; bodyText?: string }): Promise<{ success: boolean }> {
    return { success: false };
  },

  async suggestReply(_messageId: string, _instructions?: string): Promise<any> {
    return { subject: '', bodyHtml: '', bodyText: '' };
  },

  async getInboxDiagnostics(): Promise<any> {
    return {
      webhookUrl: 'N/A no modo Cloud',
      totalMessages: 0,
      unreadMessages: 0,
      latestReceivedAt: null,
      latestFromEmail: null,
      sendgridConfigured: false,
      sendgridFromEmail: null,
    };
  },

  async markInboxRepliedManually(id: string): Promise<void> {
    const { error } = await supabase
      .from('email_inbox_messages' as any)
      .update({ replied: true, replied_at: new Date().toISOString(), read: true })
      .eq('id', id);
    if (error) throw new Error(error.message);
  },

  async pauseEnrollmentFromInbox(_id: string): Promise<void> { /* no-op cloud */ },
  async resumeEnrollmentFromInbox(_id: string): Promise<void> { /* no-op cloud */ },
  async unenrollFromInbox(_id: string): Promise<void> { /* no-op cloud */ },

  // ==================== SEARCH ====================
  async searchByEmail(email: string): Promise<any> {
    const { data: contact } = await supabase
      .from('contacts')
      .select('*')
      .ilike('email', `%${email}%`)
      .maybeSingle();

    if (!contact) return { contact: null, enrollments: [], sends: [] };

    const [enrollRes, sendsRes] = await Promise.all([
      supabase.from('email_enrollments').select('*, cadence:email_cadences(id, name)').eq('contact_id', contact.id),
      supabase.from('email_sends').select('*').eq('contact_id', contact.id).order('created_at', { ascending: false }).limit(50),
    ]);

    return {
      contact,
      enrollments: enrollRes.data || [],
      sends: sendsRes.data || [],
    };
  },
};
