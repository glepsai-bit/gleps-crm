import { supabase } from '@/integrations/supabase/client';

export interface Profile {
  id: string;
  user_id: string;
  account_id: string | null;
  nome: string;
  email: string;
  status: 'active' | 'inactive' | 'suspended';
  permissions: string[];
  chatwoot_agent_id: number | null;
  created_at: string;
  updated_at: string;
  role?: 'super_admin' | 'admin' | 'agent';
}

export interface CreateUserInput {
  email: string;
  password: string;
  nome: string;
  role: 'super_admin' | 'admin' | 'agent';
  account_id?: string;
  permissions?: string[];
  chatwoot_agent_id?: number;
}

export const usersCloudService = {
  /**
   * List all users (Super Admin) or account users (Admin)
   */
  async list(accountId?: string): Promise<Profile[]> {
    let query = supabase.from('profiles').select('*');

    if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const { data: profiles, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching users:', error);
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
          status: profile.status as 'active' | 'inactive' | 'suspended',
          role: (roleData?.role as 'super_admin' | 'admin' | 'agent') || 'agent',
        };
      })
    );

    return usersWithRoles;
  },

  /**
   * Get user by ID
   */
  async getById(userId: string): Promise<Profile | null> {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching user:', error);
      throw new Error(error.message);
    }

    if (!profile) return null;

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();

    return {
      ...profile,
      status: profile.status as 'active' | 'inactive' | 'suspended',
      role: (roleData?.role as 'super_admin' | 'admin' | 'agent') || 'agent',
    };
  },

  /**
   * Create a new user with role via Edge Function
   */
  async create(input: CreateUserInput): Promise<Profile> {
    const { data: sessionData } = await supabase.auth.getSession();
    
    if (!sessionData.session) {
      throw new Error('Não autenticado');
    }

    // Call the Edge Function to create user
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          nome: input.nome,
          role: input.role,
          account_id: input.account_id || null,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok || result.error) {
      console.error('Error creating user:', result.error);
      throw new Error(result.error || 'Erro ao criar usuário');
    }

    const userId = result.user.id;

    // Fallback: Explicitly set password via set-user-password to ensure it's correctly applied
    try {
      const setPasswordResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/set-user-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionData.session.access_token}`,
          },
          body: JSON.stringify({
            userId: userId,
            password: input.password,
          }),
        }
      );

      if (!setPasswordResponse.ok) {
        console.warn('Failed to explicitly set password via fallback, user may need password reset');
      } else {
        console.log('Password explicitly set via fallback for user:', userId);
      }
    } catch (err) {
      console.warn('Error in password fallback:', err);
    }

    // Update profile with permissions if agent
    if (input.role === 'agent' && input.permissions?.length) {
      const { error: permError } = await supabase
        .from('profiles')
        .update({
          permissions: input.permissions,
          chatwoot_agent_id: input.chatwoot_agent_id,
        })
        .eq('user_id', userId);

      if (permError) {
        console.error('Error updating permissions:', permError);
      }
    }

    // Fetch the created profile
    const profile = await this.getById(userId);
    if (!profile) {
      throw new Error('Erro ao obter perfil do usuário criado');
    }

    return profile;
  },

  /**
   * Update user profile and role
   */
  async update(userId: string, input: Partial<Profile> & { role?: 'admin' | 'agent' }): Promise<Profile> {
    const updateData: Record<string, any> = {};
    
    if (input.nome) updateData.nome = input.nome;
    if (input.status) updateData.status = input.status;
    if (input.permissions) updateData.permissions = input.permissions;
    if (input.chatwoot_agent_id !== undefined) updateData.chatwoot_agent_id = input.chatwoot_agent_id;

    if (Object.keys(updateData).length > 0) {
      const { error } = await supabase
        .from('profiles')
        .update(updateData)
        .eq('user_id', userId);

      if (error) {
        console.error('Error updating profile:', error);
        throw new Error(error.message);
      }
    }

    // Update role if provided
    if (input.role) {
      const { error: roleError } = await supabase
        .from('user_roles')
        .upsert({
          user_id: userId,
          role: input.role,
        }, {
          onConflict: 'user_id,role',
        });

      if (roleError) {
        console.error('Error updating role:', roleError);
      }
    }

    const profile = await this.getById(userId);
    if (!profile) {
      throw new Error('Usuário não encontrado');
    }

    return profile;
  },

  /**
   * Delete user completely via Edge Function
   * This removes the user from auth.users (which cascades to profiles and user_roles)
   */
  async delete(userId: string, adminPassword: string): Promise<void> {
    const { data: sessionData } = await supabase.auth.getSession();
    
    if (!sessionData.session) {
      throw new Error('Não autenticado');
    }

    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-user`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({
          user_id: userId,
          password: adminPassword,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok || result.error) {
      console.error('Error deleting user:', result.error);
      throw new Error(result.error || 'Erro ao excluir usuário');
    }
  },
};
