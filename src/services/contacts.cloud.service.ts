import { supabase } from '@/integrations/supabase/client';
import type { ContactOrigin } from '@/types/crm';

export interface CreateContactInput {
  account_id: string;
  nome: string;
  telefone: string;
  email?: string;
  origem?: ContactOrigin;
}

// REMOVED: input estendido p/ integracao externa de atendimento

export interface CreateContactResult {
  success: boolean;
  contact_id?: string;
  error?: string;
}

export interface DeleteLeadResult {
  success: boolean;
  error?: string;
}

/**
 * Create a contact in Supabase only
 */
export async function createContact(input: CreateContactInput): Promise<CreateContactResult> {
  const { account_id, nome, telefone, email, origem } = input;

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      account_id,
      nome,
      telefone,
      email: email || null,
      origem: origem || 'outro',
    })
    .select('id')
    .single();

  if (error) {
    console.error('[contacts.cloud.service] Error creating contact:', error);
    return { success: false, error: error.message };
  }

  return {
    success: true,
    contact_id: data.id,
  };
}

// REMOVED: funcao de criacao integrada com plataforma externa de atendimento

/**
 * Apply a stage tag to a contact
 */
export async function applyStageTagToContact(
  contact_id: string,
  tag_id: string,
  source: 'kanban' | 'system' = 'kanban'
): Promise<{ success: boolean; error?: string }> {
  // Check if lead already has a stage tag
  const { data: existingTags, error: fetchError } = await supabase
    .from('lead_tags')
    .select('id, tag_id')
    .eq('contact_id', contact_id);

  if (fetchError) {
    return { success: false, error: fetchError.message };
  }

  // If exists, update; otherwise insert
  if (existingTags && existingTags.length > 0) {
    const { error } = await supabase
      .from('lead_tags')
      .update({ tag_id, source })
      .eq('id', existingTags[0].id);

    if (error) {
      return { success: false, error: error.message };
    }
  } else {
    const { error } = await supabase.from('lead_tags').insert({
      contact_id,
      tag_id,
      source,
    });

    if (error) {
      return { success: false, error: error.message };
    }
  }

  return { success: true };
}

/**
 * Delete lead from database.
 */
export async function deleteLead(contact_id: string): Promise<DeleteLeadResult> {
  try {
    const { data, error } = await supabase.functions.invoke('delete-lead', {
      body: { contact_id },
    });

    if (error) {
      console.error('[contacts.cloud.service] Error deleting lead:', error);
      return { success: false, error: error.message };
    }

    if (!data?.success) {
      return { success: false, error: data?.error || 'Erro ao remover lead' };
    }

    return {
      success: true,
    };
  } catch (err: any) {
    console.error('[contacts.cloud.service] Unexpected error deleting lead:', err);
    return { success: false, error: err?.message || 'Erro ao remover lead' };
  }
}

export const contactsCloudService = {
  createContact,
  applyStageTagToContact,
  deleteLead,
};
