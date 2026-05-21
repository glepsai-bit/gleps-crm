/**
 * Tags Cloud Service
 * 
 * Handles all tag/stage operations using Supabase Cloud.
 * Includes sync with Chatwoot labels.
 */

import { supabase } from '@/integrations/supabase/client';

export interface Tag {
  id: string;
  account_id: string;
  funnel_id: string;
  name: string;
  slug: string;
  type: 'stage' | 'operational';
  color: string;
  ordem: number;
  ativo: boolean;
  chatwoot_label_id: number | null;
  created_at: string;
}

export interface LeadTag {
  id: string;
  contact_id: string;
  tag_id: string;
  applied_by_id: string | null;
  source: string;
  created_at: string;
}

export interface ChatwootLabel {
  id: number;
  title: string;
  color: string;
  description: string | null;
}

export interface ImportLabelsResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  labels: Array<{
    name: string;
    action: 'imported' | 'updated' | 'skipped';
    reason?: string;
  }>;
  error?: string;
}

export interface SyncContactsResult {
  success: boolean;
  contacts_created: number;
  contacts_updated: number;
  contacts_deleted: number;
  lead_tags_applied: number;
  lead_tags_removed: number;
  errors: string[];
}

export const tagsCloudService = {
  /**
   * List all stage tags for an account (Kanban columns)
   */
  async listStageTags(accountId: string): Promise<Tag[]> {
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .eq('type', 'stage')
      .eq('ativo', true)
      .order('ordem', { ascending: true });

    if (error) {
      console.error('Error fetching stage tags:', error);
      throw new Error(error.message);
    }

    return (data || []) as Tag[];
  },

  /**
   * List all tags for an account
   */
  async listAllTags(accountId: string): Promise<Tag[]> {
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .eq('ativo', true)
      .order('ordem', { ascending: true });

    if (error) {
      console.error('Error fetching tags:', error);
      throw new Error(error.message);
    }

    return (data || []) as Tag[];
  },

  /**
   * Create a new stage tag (Kanban column) and sync to Chatwoot
   */
  async createStageTag(input: {
    accountId: string;
    funnelId: string;
    name: string;
    color: string;
    ordem?: number;
  }): Promise<Tag> {
    const slug = input.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

    // Get max ordem if not provided
    let ordem = input.ordem;
    if (ordem === undefined) {
      const { data: existing } = await supabase
        .from('tags')
        .select('ordem')
        .eq('account_id', input.accountId)
        .eq('type', 'stage')
        .order('ordem', { ascending: false })
        .limit(1);
      
      ordem = (existing?.[0]?.ordem ?? -1) + 1;
    }

    const { data, error } = await supabase
      .from('tags')
      .insert({
        account_id: input.accountId,
        funnel_id: input.funnelId,
        name: input.name,
        slug,
        type: 'stage',
        color: input.color,
        ordem,
        ativo: true,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating stage tag:', error);
      throw new Error(error.message);
    }

    const tag = data as Tag;

    // Push to Chatwoot (non-blocking)
    this.pushLabelToChatwoot(input.accountId, 'create', {
      title: input.name,
      color: input.color,
    }, tag.id).catch(err => {
      console.error('Failed to push label to Chatwoot:', err);
    });

    return tag;
  },

  /**
   * Push label changes to Chatwoot
   */
  async pushLabelToChatwoot(
    accountId: string, 
    action: 'create' | 'update' | 'delete',
    label: { title: string; color: string; description?: string },
    tagId?: string,
    chatwootLabelId?: number
  ): Promise<{ success: boolean; chatwoot_label_id?: number }> {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) {
      console.warn('Not authenticated, skipping Chatwoot sync');
      return { success: false };
    }

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/push-chatwoot-label`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session.access_token}`,
          },
          body: JSON.stringify({
            account_id: accountId,
            action,
            label,
            tag_id: tagId,
            chatwoot_label_id: chatwootLabelId,
          }),
        }
      );

      const result = await response.json();
      return result;
    } catch (err) {
      console.error('Error pushing label to Chatwoot:', err);
      return { success: false };
    }
  },

  /**
   * Update a tag and sync to Chatwoot
   */
  async updateTag(tagId: string, input: Partial<Pick<Tag, 'name' | 'color' | 'ordem' | 'ativo'>>): Promise<Tag> {
    // Get current tag first to get chatwoot_label_id
    const { data: currentTag } = await supabase
      .from('tags')
      .select('*')
      .eq('id', tagId)
      .single();

    const updateData: Record<string, any> = {};
    
    if (input.name !== undefined) {
      updateData.name = input.name;
      updateData.slug = input.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    }
    if (input.color !== undefined) updateData.color = input.color;
    if (input.ordem !== undefined) updateData.ordem = input.ordem;
    if (input.ativo !== undefined) updateData.ativo = input.ativo;

    const { data, error } = await supabase
      .from('tags')
      .update(updateData)
      .eq('id', tagId)
      .select()
      .single();

    if (error) {
      console.error('Error updating tag:', error);
      throw new Error(error.message);
    }

    const tag = data as Tag;

    // If name or color changed and has chatwoot_label_id, sync to Chatwoot
    if (currentTag && (input.name !== undefined || input.color !== undefined)) {
      const accountId = currentTag.account_id;
      const chatwootLabelId = currentTag.chatwoot_label_id;
      
      if (chatwootLabelId) {
        // Update existing label in Chatwoot
        this.pushLabelToChatwoot(accountId, 'update', {
          title: tag.name,
          color: tag.color,
        }, tagId, chatwootLabelId).catch(err => {
          console.error('Failed to update label in Chatwoot:', err);
        });
      } else {
        // Create label in Chatwoot if it doesn't exist yet
        this.pushLabelToChatwoot(accountId, 'create', {
          title: tag.name,
          color: tag.color,
        }, tagId).catch(err => {
          console.error('Failed to create label in Chatwoot:', err);
        });
      }
    }

    return tag;
  },

  /**
   * Delete a tag (soft delete by setting ativo=false) and remove from Chatwoot
   */
  async deleteTag(tagId: string, options?: { force?: boolean; migrateToId?: string }): Promise<void> {
    // Get current tag first to get chatwoot_label_id and account_id
    const { data: currentTag } = await supabase
      .from('tags')
      .select('*')
      .eq('id', tagId)
      .single();

    // Check if there are leads with this tag
    const { data: existingLeadTags, error: checkError } = await supabase
      .from('lead_tags')
      .select('id')
      .eq('tag_id', tagId);

    if (checkError) {
      throw new Error(checkError.message);
    }

    const hasLeads = existingLeadTags && existingLeadTags.length > 0;

    if (hasLeads && !options?.force) {
      throw new Error('Não é possível excluir: existem leads nesta etapa');
    }

    // Handle leads before deletion
    if (hasLeads && options?.force) {
      if (options.migrateToId) {
        // Move leads to another stage
        const { error: migrateError } = await supabase
          .from('lead_tags')
          .update({ tag_id: options.migrateToId })
          .eq('tag_id', tagId);
        if (migrateError) throw new Error(migrateError.message);
      } else {
        // Remove all lead_tags
        const { error: removeError } = await supabase
          .from('lead_tags')
          .delete()
          .eq('tag_id', tagId);
        if (removeError) throw new Error(removeError.message);
      }
    }

    const { error } = await supabase
      .from('tags')
      .update({ ativo: false })
      .eq('id', tagId);

    if (error) {
      console.error('Error deleting tag:', error);
      throw new Error(error.message);
    }

    // Delete from Chatwoot if it has a chatwoot_label_id
    if (currentTag?.chatwoot_label_id) {
      this.pushLabelToChatwoot(currentTag.account_id, 'delete', {
        title: currentTag.name,
        color: currentTag.color,
      }, tagId, currentTag.chatwoot_label_id).catch(err => {
        console.error('Failed to delete label from Chatwoot:', err);
      });
    }
  },

  /**
   * Reorder tags (swap ordem values)
   */
  async swapTagOrder(tagId1: string, tagId2: string): Promise<void> {
    // Get both tags
    const { data: tags, error: fetchError } = await supabase
      .from('tags')
      .select('id, ordem')
      .in('id', [tagId1, tagId2]);

    if (fetchError || !tags || tags.length !== 2) {
      throw new Error('Failed to fetch tags for reorder');
    }

    const tag1 = tags.find(t => t.id === tagId1)!;
    const tag2 = tags.find(t => t.id === tagId2)!;

    // Swap ordem values with two updates
    await supabase.from('tags').update({ ordem: tag2.ordem }).eq('id', tagId1);
    await supabase.from('tags').update({ ordem: tag1.ordem }).eq('id', tagId2);
  },

  /**
   * Get lead tags for a contact
   */
  async getLeadTags(contactId: string): Promise<LeadTag[]> {
    const { data, error } = await supabase
      .from('lead_tags')
      .select('*')
      .eq('contact_id', contactId);

    if (error) {
      console.error('Error fetching lead tags:', error);
      return [];
    }

    return (data || []) as LeadTag[];
  },

  /**
   * Apply a stage tag to a contact (removes other stage tags) and sync to Chatwoot
   */
  async applyStageTag(contactId: string, tagId: string, source: string = 'kanban'): Promise<void> {
    // Get the tag to verify it's a stage tag
    const { data: tag, error: tagError } = await supabase
      .from('tags')
      .select('id, type, account_id')
      .eq('id', tagId)
      .single();

    if (tagError || !tag || tag.type !== 'stage') {
      throw new Error('Tag de etapa não encontrada');
    }

    // Get all stage tags for this account
    const { data: stageTags } = await supabase
      .from('tags')
      .select('id')
      .eq('account_id', tag.account_id)
      .eq('type', 'stage');

    const stageTagIds = (stageTags || []).map(t => t.id);

    // Get old stage tag id before removal
    const { data: existingLeadTags } = await supabase
      .from('lead_tags')
      .select('tag_id')
      .eq('contact_id', contactId)
      .in('tag_id', stageTagIds);
    
    const oldStageTagId = existingLeadTags?.[0]?.tag_id;

    // Remove existing stage tags from contact
    if (stageTagIds.length > 0) {
      await supabase
        .from('lead_tags')
        .delete()
        .eq('contact_id', contactId)
        .in('tag_id', stageTagIds);
    }

    // Add the new stage tag
    const { error: insertError } = await supabase
      .from('lead_tags')
      .insert({
        contact_id: contactId,
        tag_id: tagId,
        source,
      });

    if (insertError) {
      console.error('Error applying stage tag:', insertError);
      throw new Error(insertError.message);
    }

    // Sync to Chatwoot (non-blocking but with full error visibility)
    console.log('[applyStageTag] Syncing to Chatwoot:', { accountId: tag.account_id, contactId, tagId, oldStageTagId });
    this.updateContactLabelsInChatwoot(tag.account_id, contactId, tagId, oldStageTagId)
      .then(result => {
        if (!result.success) {
          console.error('[applyStageTag] Chatwoot sync returned failure:', result);
        } else {
          console.log('[applyStageTag] Chatwoot sync succeeded:', result);
        }
      })
      .catch(err => {
        console.error('[applyStageTag] Chatwoot sync threw error:', err?.message || err, err);
      });
  },

  /**
   * Update contact labels in Chatwoot when lead changes stage
   */
  async updateContactLabelsInChatwoot(
    accountId: string, 
    contactId: string, 
    newStageTagId: string,
    oldStageTagId?: string
  ): Promise<{ success: boolean }> {
    try {
      console.log('[Tags Service] Calling update-chatwoot-contact-labels edge function:', {
        accountId, contactId, newStageTagId, oldStageTagId
      });

      const { data, error } = await supabase.functions.invoke(
        'update-chatwoot-contact-labels',
        {
          body: {
            account_id: accountId,
            contact_id: contactId,
            new_stage_tag_id: newStageTagId,
            old_stage_tag_id: oldStageTagId,
          },
        }
      );

      if (error) {
        console.error('[Tags Service] Edge function error:', error);
        return { success: false };
      }

      console.log('[Tags Service] Chatwoot contact labels sync result:', data);
      return data || { success: false };
    } catch (err) {
      console.error('[Tags Service] Error updating contact labels in Chatwoot:', err);
      return { success: false };
    }
  },

  /**
   * Push all CRM stage tags to Chatwoot as labels
   */
  async pushAllLabelsToChatwoot(accountId: string, resetIds = false): Promise<{
    success: boolean;
    pushed: number;
    linked: number;
    errors: string[];
    details: Array<{ name: string; action: string; reason?: string }>;
  }> {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) {
      throw new Error('Não autenticado');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/push-all-labels-to-chatwoot`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session.access_token}`,
          },
          body: JSON.stringify({
            account_id: accountId,
            reset_ids: resetIds,
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);
      const result = await response.json();

      if (!response.ok) {
        return {
          success: false,
          pushed: 0,
          linked: 0,
          errors: [result.error || `Erro HTTP ${response.status}`],
          details: [],
        };
      }

      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      return {
        success: false,
        pushed: 0,
        linked: 0,
        errors: [err.name === 'AbortError' ? 'Timeout ao enviar etapas' : (err.message || 'Erro desconhecido')],
        details: [],
      };
    }
  },


  /**
   * Create 6 default stage tags for an account (template)
   */
  async createDefaultStages(accountId: string): Promise<Tag[]> {
    let funnel = await this.getDefaultFunnel(accountId);
    if (!funnel) funnel = await this.createDefaultFunnel(accountId);
    if (!funnel) throw new Error('Não foi possível criar o funil padrão');

    const stages = [
      { name: 'Novo Lead', color: '#0EA5E9', ordem: 0 },
      { name: 'Em Atendimento', color: '#8B5CF6', ordem: 1 },
      { name: 'Aguardando Resposta', color: '#F59E0B', ordem: 2 },
      { name: 'Agendado', color: '#22C55E', ordem: 3 },
      { name: 'Convertido', color: '#10B981', ordem: 4 },
      { name: 'Perdido', color: '#EF4444', ordem: 5 },
    ];

    const created: Tag[] = [];
    for (const stage of stages) {
      const tag = await this.createStageTag({
        accountId,
        funnelId: funnel.id,
        ...stage,
      });
      created.push(tag);
    }
    return created;
  },

  /**
   * Get the default funnel for an account
   */
  async getDefaultFunnel(accountId: string): Promise<{ id: string; name: string } | null> {
    const { data, error } = await supabase
      .from('funnels')
      .select('id, name')
      .eq('account_id', accountId)
      .eq('is_default', true)
      .single();

    if (error) {
      // Try to get any funnel for this account
      const { data: anyFunnel } = await supabase
        .from('funnels')
        .select('id, name')
        .eq('account_id', accountId)
        .limit(1)
        .single();
      
      return anyFunnel || null;
    }

    return data;
  },

  /**
   * Create a default funnel for an account
   */
  async createDefaultFunnel(accountId: string): Promise<{ id: string; name: string } | null> {
    const slug = 'atendimento';
    
    const { data, error } = await supabase
      .from('funnels')
      .insert({
        account_id: accountId,
        name: 'Atendimento',
        slug,
        is_default: true,
      })
      .select('id, name')
      .single();

    if (error) {
      console.error('Error creating default funnel:', error);
      return null;
    }

    return data;
  },

  /**
   * Sync contacts and their labels from Chatwoot
   */
  async syncChatwootContacts(accountId: string): Promise<SyncContactsResult> {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) {
      throw new Error('Não autenticado');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for contacts

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-chatwoot-contacts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session.access_token}`,
          },
          body: JSON.stringify({ account_id: accountId }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      const result = await response.json();

      if (!response.ok) {
        return {
          success: false,
          contacts_created: 0,
          contacts_updated: 0,
          contacts_deleted: 0,
          lead_tags_applied: 0,
          lead_tags_removed: 0,
          errors: [result.error || `Erro HTTP ${response.status}`],
        };
      }

      return result as SyncContactsResult;
    } catch (err: any) {
      clearTimeout(timeoutId);
      return {
        success: false,
        contacts_created: 0,
        contacts_updated: 0,
        contacts_deleted: 0,
        lead_tags_applied: 0,
        lead_tags_removed: 0,
        errors: [err.name === 'AbortError' ? 'Timeout ao sincronizar contatos' : (err.message || 'Erro desconhecido')],
      };
    }
  },
};

export default tagsCloudService;
