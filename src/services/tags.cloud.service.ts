/**
 * Tags Cloud Service
 *
 * Handles all tag/stage operations using Supabase Cloud.
 *
 * REMOVED (FitPark T-022): toda a camada de sincronizacao com sistema externo
 * de labels (legado) foi removida — push/sync/edge functions de label/contato.
 * Tags agora vivem so no proprio CRM.
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
   * Create a new stage tag (Kanban column)
   */
  async createStageTag(input: {
    accountId: string;
    funnelId: string;
    name: string;
    color: string;
    ordem?: number;
  }): Promise<Tag> {
    const slug = input.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

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

    return data as Tag;
  },

  /**
   * Update a tag
   */
  async updateTag(tagId: string, input: Partial<Pick<Tag, 'name' | 'color' | 'ordem' | 'ativo'>>): Promise<Tag> {
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

    return data as Tag;
  },

  /**
   * Delete a tag (soft delete by setting ativo=false)
   */
  async deleteTag(tagId: string, options?: { force?: boolean; migrateToId?: string }): Promise<void> {
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

    if (hasLeads && options?.force) {
      if (options.migrateToId) {
        const { error: migrateError } = await supabase
          .from('lead_tags')
          .update({ tag_id: options.migrateToId })
          .eq('tag_id', tagId);
        if (migrateError) throw new Error(migrateError.message);
      } else {
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
  },

  /**
   * Reorder tags (swap ordem values)
   */
  async swapTagOrder(tagId1: string, tagId2: string): Promise<void> {
    const { data: tags, error: fetchError } = await supabase
      .from('tags')
      .select('id, ordem')
      .in('id', [tagId1, tagId2]);

    if (fetchError || !tags || tags.length !== 2) {
      throw new Error('Failed to fetch tags for reorder');
    }

    const tag1 = tags.find(t => t.id === tagId1)!;
    const tag2 = tags.find(t => t.id === tagId2)!;

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
   * Apply a stage tag to a contact (removes other stage tags)
   */
  async applyStageTag(contactId: string, tagId: string, source: string = 'kanban'): Promise<void> {
    const { data: tag, error: tagError } = await supabase
      .from('tags')
      .select('id, type, account_id')
      .eq('id', tagId)
      .single();

    if (tagError || !tag || tag.type !== 'stage') {
      throw new Error('Tag de etapa não encontrada');
    }

    const { data: stageTags } = await supabase
      .from('tags')
      .select('id')
      .eq('account_id', tag.account_id)
      .eq('type', 'stage');

    const stageTagIds = (stageTags || []).map(t => t.id);

    if (stageTagIds.length > 0) {
      await supabase
        .from('lead_tags')
        .delete()
        .eq('contact_id', contactId)
        .in('tag_id', stageTagIds);
    }

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
};

export default tagsCloudService;
