import { supabase } from '@/integrations/supabase/client';
import type { ContactOrigin } from '@/types/crm';

export interface CreateContactInput {
  account_id: string;
  nome: string;
  telefone: string;
  email?: string;
  origem?: ContactOrigin;
}

export interface CreateContactWithChatwootInput extends CreateContactInput {
  create_conversation?: boolean;
  initial_stage_tag_id?: string; // Tag ID to get the label name from
}

export interface CreateContactResult {
  success: boolean;
  contact_id?: string;
  chatwoot_contact_id?: number | null;
  chatwoot_conversation_id?: number | null;
  error?: string;
}

export interface DeleteLeadResult {
  success: boolean;
  chatwoot_attempted?: boolean;
  chatwoot_deleted?: boolean;
  chatwoot_error?: string | null;
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
    chatwoot_contact_id: null,
    chatwoot_conversation_id: null,
  };
}

/**
 * Create a contact in Supabase and optionally in Chatwoot
 */
export async function createContactWithChatwoot(
  input: CreateContactWithChatwootInput
): Promise<CreateContactResult> {
  const { account_id, nome, telefone, email, origem, create_conversation = true, initial_stage_tag_id } = input;

  // First, create contact in Supabase
  const { data: contactData, error: contactError } = await supabase
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

  if (contactError) {
    console.error('[contacts.cloud.service] Error creating contact in Supabase:', contactError);
    return { success: false, error: contactError.message };
  }

  const contact_id = contactData.id;

  // Get the label name if initial_stage_tag_id is provided
  let initial_label_name: string | undefined;
  if (initial_stage_tag_id) {
    const { data: tagData } = await supabase
      .from('tags')
      .select('slug')
      .eq('id', initial_stage_tag_id)
      .single();

    if (tagData?.slug) {
      initial_label_name = tagData.slug;
      console.log('[contacts.cloud.service] Initial label name:', initial_label_name);
    }
  }

  // Call edge function to create contact in Chatwoot
  try {
    const { data: chatwootResult, error: chatwootError } = await supabase.functions.invoke(
      'create-chatwoot-contact',
      {
        body: {
          account_id,
          name: nome,
          phone: telefone,
          email,
          create_conversation,
          initial_label_name,
        },
      }
    );

    if (chatwootError) {
      console.warn('[contacts.cloud.service] Chatwoot creation failed:', chatwootError);
      // Return success but without Chatwoot IDs
      return {
        success: true,
        contact_id,
        chatwoot_contact_id: null,
        chatwoot_conversation_id: null,
        error: 'Contato criado localmente, mas falhou no Chatwoot',
      };
    }

    if (!chatwootResult?.success) {
      console.warn('[contacts.cloud.service] Chatwoot creation failed:', chatwootResult?.error);
      return {
        success: true,
        contact_id,
        chatwoot_contact_id: null,
        chatwoot_conversation_id: null,
        error: chatwootResult?.error || 'Falha ao criar no Chatwoot',
      };
    }

    // Update contact with Chatwoot IDs
    const chatwoot_contact_id = chatwootResult.chatwoot_contact_id;
    const chatwoot_conversation_id = chatwootResult.chatwoot_conversation_id;

    if (chatwoot_contact_id) {
      await supabase
        .from('contacts')
        .update({
          chatwoot_contact_id,
          chatwoot_conversation_id,
        })
        .eq('id', contact_id);
    }

    return {
      success: true,
      contact_id,
      chatwoot_contact_id,
      chatwoot_conversation_id,
    };
  } catch (error: any) {
    console.warn('[contacts.cloud.service] Error calling Chatwoot edge function:', error);
    return {
      success: true,
      contact_id,
      chatwoot_contact_id: null,
      chatwoot_conversation_id: null,
      error: error.message || 'Erro ao conectar com Chatwoot',
    };
  }
}

/**
 * Apply a stage tag to a contact
 */
export async function applyStageTagToContact(
  contact_id: string,
  tag_id: string,
  source: 'kanban' | 'chatwoot' | 'system' = 'kanban'
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
 * Delete lead from database and (best-effort) delete corresponding Chatwoot contact.
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
      chatwoot_attempted: data.chatwoot_attempted,
      chatwoot_deleted: data.chatwoot_deleted,
      chatwoot_error: data.chatwoot_error,
    };
  } catch (err: any) {
    console.error('[contacts.cloud.service] Unexpected error deleting lead:', err);
    return { success: false, error: err?.message || 'Erro ao remover lead' };
  }
}

export const contactsCloudService = {
  createContact,
  createContactWithChatwoot,
  applyStageTagToContact,
  deleteLead,
};
