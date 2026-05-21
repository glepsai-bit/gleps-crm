import { supabase } from '@/integrations/supabase/client';

export interface Account {
  id: string;
  nome: string;
  status: 'active' | 'paused' | 'cancelled';
  timezone: string;
  plano: string | null;
  limite_usuarios: number;
  chatwoot_base_url: string | null;
  chatwoot_account_id: string | null;
  chatwoot_api_key: string | null;
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
  created_at: string;
  updated_at: string;
  users_count?: number;
}

export interface CreateAccountInput {
  nome: string;
  plano?: string;
  chatwoot_base_url?: string;
  chatwoot_account_id?: string;
   chatwoot_api_key?: string;
   monthly_extraction_limit?: number;
   monthly_email_limit?: number;
   daily_email_limit?: number;
   openai_api_key?: string;
   sendgrid_api_key?: string;
   sendgrid_from_email?: string;
   sendgrid_from_name?: string;
}

export interface UpdateAccountInput {
  nome?: string;
  status?: 'active' | 'paused' | 'cancelled';
  plano?: string;
  chatwoot_base_url?: string;
  chatwoot_account_id?: string;
   chatwoot_api_key?: string;
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
        chatwoot_base_url: input.chatwoot_base_url,
        chatwoot_account_id: input.chatwoot_account_id,
        chatwoot_api_key: input.chatwoot_api_key,
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

  /**
   * Test Chatwoot connection via Edge Function (avoids CORS issues)
   * Uses manual fetch with custom timeout to avoid SDK limitations
   */
  async testChatwootConnection(
    baseUrl: string, 
    accountId: string, 
    apiKey: string
  ): Promise<{ 
    success: boolean; 
    message: string;
    agents?: Array<{ id: number; name: string; email: string; role: string }>;
    inboxes?: Array<{ id: number; name: string; channel_type: string }>;
    labels?: Array<{ id: number; title: string; color: string }>;
  }> {
    const TIMEOUT_MS = 30000; // 30 seconds timeout
    const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    const normalizedAccountId = String(accountId || '').trim();
    const normalizedApiKey = String(apiKey || '').trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // Get current session for auth
      const { data: { session } } = await supabase.auth.getSession();
      
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      console.log('[Chatwoot] Testing connection via fetch...', { 
        url: `${supabaseUrl}/functions/v1/test-chatwoot-connection`,
        hasSession: !!session?.access_token 
      });

      const response = await fetch(
        `${supabaseUrl}/functions/v1/test-chatwoot-connection`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': session?.access_token 
              ? `Bearer ${session.access_token}` 
              : `Bearer ${supabaseKey}`,
            'apikey': supabaseKey,
          },
          body: JSON.stringify({
            baseUrl: normalizedBaseUrl,
            accountId: normalizedAccountId,
            apiKey: normalizedApiKey,
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Chatwoot] HTTP error:', response.status, errorText);
        return { 
          success: false, 
          message: `Erro HTTP ${response.status}: ${errorText}`
        };
      }

      const data = await response.json();
      console.log('[Chatwoot] Response:', data);
      
      if (data?.success) {
        return {
          success: true,
          message: `Conexão estabelecida! ${data.agents?.length || 0} agentes, ${data.inboxes?.length || 0} canais, ${data.labels?.length || 0} etiquetas encontradas.`,
          agents: data.agents,
          inboxes: data.inboxes,
          labels: data.labels,
        };
      } else {
        return {
          success: false,
          message: data?.error || 'Falha na conexão com Chatwoot',
        };
      }
    } catch (error: any) {
      console.error('[Chatwoot] Connection test failed:', error);
      
      if (error.name === 'AbortError') {
        return {
          success: false,
          message: `Timeout após ${TIMEOUT_MS / 1000}s. O servidor Chatwoot pode estar lento ou inacessível.`,
        };
      }
      
      return { 
        success: false, 
        message: error.message || 'Erro de conexão' 
      };
    } finally {
      clearTimeout(timeoutId);
    }
  },

  /**
   * Fetch Chatwoot agents via Edge Function
   */
  async fetchChatwootAgents(
    baseUrl: string,
    accountId: string,
    apiKey: string
  ): Promise<Array<{ id: number; name: string; email: string; role: string; availability_status?: string }>> {
    const result = await this.testChatwootConnection(baseUrl, accountId, apiKey);
    return result.agents || [];
  },
};
