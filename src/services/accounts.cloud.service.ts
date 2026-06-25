import { supabase } from '@/integrations/supabase/client';

export interface Account {
  id: string;
  nome: string;
  status: 'active' | 'paused' | 'cancelled';
  timezone: string;
  plano: string | null;
  limite_usuarios: number;
  google_client_id?: string | null;
  google_client_secret?: string | null;
   google_redirect_uri?: string | null;
   monthly_extraction_limit?: number;
   monthly_email_limit?: number;
   daily_email_limit?: number;
   openai_api_key?: string | null;
   sendgrid_api_key?: string | null;
   sendgrid_from_email?: string | null;
   sendgrid_from_name?: string | null;
   evolution_base_url?: string | null;
   evolution_api_key?: string | null;
   evolution_instance?: string | null;
  created_at: string;
  updated_at: string;
  users_count?: number;
}

export interface CreateAccountInput {
  nome: string;
  plano?: string;
   monthly_extraction_limit?: number;
   monthly_email_limit?: number;
   daily_email_limit?: number;
   openai_api_key?: string;
   sendgrid_api_key?: string;
   sendgrid_from_email?: string;
   sendgrid_from_name?: string;
   evolution_base_url?: string;
   evolution_api_key?: string;
   evolution_instance?: string;
}

export interface UpdateAccountInput {
  nome?: string;
  status?: 'active' | 'paused' | 'cancelled';
  plano?: string;
   monthly_extraction_limit?: number;
   monthly_email_limit?: number;
   daily_email_limit?: number;
   google_client_id?: string;
   google_client_secret?: string;
   google_redirect_uri?: string;
   openai_api_key?: string;
   sendgrid_api_key?: string;
   sendgrid_from_email?: string;
   sendgrid_from_name?: string;
   evolution_base_url?: string;
   evolution_api_key?: string;
   evolution_instance?: string;
}

export const accountsCloudService = {
  /**
   * List all accounts (Super Admin only)
   */
  async list(): Promise<Account[]> {
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching accounts:', error);
      throw new Error(error.message);
    }

    // Get user count for each account
    const accountsWithCount = await Promise.all(
      (accounts || []).map(async (account) => {
        const { count } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('account_id', account.id);

        return {
          ...account,
          status: account.status as 'active' | 'paused' | 'cancelled',
          users_count: count || 0,
        };
      })
    );

    return accountsWithCount;
  },

  /**
   * Get account by ID
   */
  async getById(id: string): Promise<Account | null> {
    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('Error fetching account:', error);
      throw new Error(error.message);
    }

    if (!account) return null;

    const { count } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', account.id);

    return {
      ...account,
      status: account.status as 'active' | 'paused' | 'cancelled',
      users_count: count || 0,
    };
  },

  /**
   * Create a new account
   */
  async create(input: CreateAccountInput): Promise<Account> {
    const { data, error } = await supabase
      .from('accounts')
      .insert({
        nome: input.nome,
        plano: input.plano,
        openai_api_key: input.openai_api_key,
        sendgrid_api_key: input.sendgrid_api_key,
        sendgrid_from_email: input.sendgrid_from_email,
        sendgrid_from_name: input.sendgrid_from_name,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating account:', error);
      throw new Error(error.message);
    }

    return {
      ...data,
      status: data.status as 'active' | 'paused' | 'cancelled',
      users_count: 0,
    };
  },

  /**
   * Update an account
   */
  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const { data, error } = await supabase
      .from('accounts')
      .update(input)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating account:', error);
      throw new Error(error.message);
    }

    return {
      ...data,
      status: data.status as 'active' | 'paused' | 'cancelled',
    };
  },

  /**
   * Delete an account
   */
  async delete(id: string, _password?: string): Promise<void> {
    const { error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting account:', error);
      throw new Error(error.message);
    }
  },

  /**
   * Get account users
   */
  async getUsers(accountId: string) {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching account users:', error);
      throw new Error(error.message);
    }

    // Get roles for each user
    const usersWithRoles = await Promise.all(
      (profiles || []).map(async (profile) => {
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', profile.user_id)
          .maybeSingle();

        return {
          ...profile,
          role: (roleData?.role as 'super_admin' | 'admin' | 'agent') || 'agent',
        };
      })
    );

    return usersWithRoles;
  },
};
