import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Minimal type to avoid depending on @supabase/supabase-js at build time
// (the package may be aliased out in backend-only production builds)
type SupabaseUser = { id: string; email?: string; [key: string]: any };

// Types
interface User {
  id: string;
  email: string;
  nome: string;
  role: 'super_admin' | 'admin' | 'agent';
  account_id?: string;
  permissions: string[];
  status: 'active' | 'inactive' | 'suspended';
  chatwoot_agent_id?: number;
}

interface Account {
  id: string;
  nome: string;
  status: 'active' | 'paused' | 'cancelled';
  chatwoot_base_url?: string;
  chatwoot_account_id?: string;
  chatwoot_api_key?: string;
}

interface AuthState {
  user: User | null;
  account: Account | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
}

interface AuthContextType extends AuthState {
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  impersonate: (userId: string) => void;
  exitImpersonation: () => void;
  isImpersonating: boolean;
  originalUser: User | null;
  signUp: (email: string, password: string, nome: string) => Promise<{ success: boolean; error?: string }>;
  clearAuthError: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    account: null,
    isAuthenticated: false,
    isLoading: true,
    authError: null,
  });
  const [originalUser, setOriginalUser] = useState<User | null>(null);
  const [isImpersonating, setIsImpersonating] = useState(false);

  // Refs to prevent stale closures and duplicate hydrations
  const currentUserRef = useRef<string | null>(null);
  const isHydratingRef = useRef(false);
  const mountedRef = useRef(true);

  const clearAuthError = useCallback(() => {
    setAuthState(prev => ({ ...prev, authError: null }));
  }, []);

  // Helper to create a timeout promise
  const withTimeout = <T,>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(errorMsg)), ms)
      )
    ]);
  };

  // Hydrate user data - stable function via useCallback with no dependencies
  const hydrateUser = useCallback(async (supabaseUser: SupabaseUser): Promise<boolean> => {
    console.log('[Auth] Hydrating user:', supabaseUser.id);

    if (!mountedRef.current) {
      console.log('[Auth] Component unmounted, aborting hydration');
      return false;
    }

    try {
      // Fetch profile and role in parallel with timeout
      console.log('[Auth] Fetching profile and role...');
      
      const profilePromise = supabase
        .from('profiles')
        .select('user_id, email, nome, status, permissions, account_id, chatwoot_agent_id')
        .eq('user_id', supabaseUser.id)
        .maybeSingle();
        
      const rolePromise = supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', supabaseUser.id)
        .maybeSingle();
      
      const [profileResult, roleResult] = await withTimeout(
        Promise.all([Promise.resolve(profilePromise), Promise.resolve(rolePromise)]),
        10000, // 10 second timeout
        'Timeout ao carregar perfil'
      );

      console.log('[Auth] Profile result:', profileResult.data ? 'found' : 'not found', profileResult.error?.message);
      console.log('[Auth] Role result:', roleResult.data?.role || 'none', roleResult.error?.message);

      const { data: profile, error: profileError } = profileResult;
      const { data: userRole, error: roleError } = roleResult;

      if (profileError) {
        console.error('[Auth] Profile error:', profileError);
        throw new Error('Erro ao carregar perfil');
      }

      if (!profile) {
        throw new Error('Perfil não encontrado');
      }

      if (roleError) {
        console.warn('[Auth] Role fetch warning:', roleError);
      }

      const role = (userRole?.role as 'super_admin' | 'admin' | 'agent') || 'agent';

      if (profile.status !== 'active') {
        throw new Error('Usuário inativo');
      }

      // Fetch account only for non-super_admin users
      let account: Account | null = null;
      if (role !== 'super_admin' && profile.account_id) {
        console.log('[Auth] Fetching account...');
        const accountPromise = supabase
          .from('accounts')
          .select('id, nome, status, chatwoot_base_url, chatwoot_account_id, chatwoot_api_key')
          .eq('id', profile.account_id)
          .maybeSingle();
          
        const accountResult = await withTimeout(
          Promise.resolve(accountPromise),
          5000,
          'Timeout ao carregar conta'
        );
        
        const { data: accountData, error: accountError } = accountResult;

        if (!accountError && accountData) {
          account = {
            id: accountData.id,
            nome: accountData.nome,
            status: accountData.status as 'active' | 'paused' | 'cancelled',
            chatwoot_base_url: accountData.chatwoot_base_url || undefined,
            chatwoot_account_id: accountData.chatwoot_account_id || undefined,
            chatwoot_api_key: accountData.chatwoot_api_key || undefined,
          };

          if (accountData.status === 'paused') {
            throw new Error('Conta pausada');
          }
        }
      }

      const user: User = {
        id: supabaseUser.id,
        email: profile.email,
        nome: profile.nome,
        role,
        account_id: profile.account_id || undefined,
        permissions: profile.permissions || ['dashboard'],
        status: profile.status as 'active' | 'inactive' | 'suspended',
        chatwoot_agent_id: profile.chatwoot_agent_id || undefined,
      };

      console.log('[Auth] Hydration complete:', user.email, user.role);

      if (!mountedRef.current) {
        console.log('[Auth] Component unmounted after fetch, aborting state update');
        return false;
      }

      setAuthState({
        user,
        account,
        isAuthenticated: true,
        isLoading: false,
        authError: null,
      });

      return true;
    } catch (error: any) {
      console.error('[Auth] Hydration failed:', error.message);
      
      // Sign out to prevent half-logged state
      await supabase.auth.signOut();
      
      setAuthState({
        user: null,
        account: null,
        isAuthenticated: false,
        isLoading: false,
        authError: error.message || 'Erro ao carregar dados',
      });
      
      return false;
    }
  }, []);

  // Initialize auth state - listener created ONCE on mount
  useEffect(() => {
    mountedRef.current = true;
    console.log('[Auth] Initializing auth system...');

    const processSession = async (supabaseUser: SupabaseUser, source: string) => {
      if (!mountedRef.current) {
        console.log(`[Auth] (${source}) Component unmounted, skipping`);
        return;
      }

      // Skip if same user already hydrated
      if (currentUserRef.current === supabaseUser.id) {
        console.log(`[Auth] (${source}) User already hydrated, skipping`);
        // Make sure loading is false
        setAuthState(prev => prev.isLoading ? { ...prev, isLoading: false } : prev);
        return;
      }

      // Skip if already hydrating
      if (isHydratingRef.current) {
        console.log(`[Auth] (${source}) Already hydrating, skipping`);
        return;
      }

      console.log(`[Auth] (${source}) Starting hydration for:`, supabaseUser.id);
      isHydratingRef.current = true;

      try {
        const success = await hydrateUser(supabaseUser);
        if (success) {
          currentUserRef.current = supabaseUser.id;
        }
        console.log(`[Auth] (${source}) Hydration complete, success:`, success);
      } catch (error) {
        console.error(`[Auth] (${source}) Hydration error:`, error);
      } finally {
        isHydratingRef.current = false;
      }
    };

    // 1. Set up auth listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!mountedRef.current) return;
        
        console.log('[Auth] Event:', event, 'User:', session?.user?.id || 'none');

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            // CRITICAL: Use setTimeout to escape the auth callback context
            // This allows the Supabase client to properly update its auth state
            // before we make authenticated requests
            const userToHydrate = session.user;
            setTimeout(() => {
              if (!mountedRef.current) return;
              processSession(userToHydrate, `listener:${event}`);
            }, 0);
          }
        } else if (event === 'SIGNED_OUT') {
          console.log('[Auth] User signed out, clearing state');
          currentUserRef.current = null;
          isHydratingRef.current = false;
          setAuthState({
            user: null,
            account: null,
            isAuthenticated: false,
            isLoading: false,
            authError: null,
          });
          setOriginalUser(null);
          setIsImpersonating(false);
        }
        // Removing INITIAL_SESSION null check here as it can be premature
        // We let checkSession be the authority for the absence of a session
      }
    );

    // 2. Check for existing session AFTER listener is set up
    const checkSession = async () => {
      console.log('[Auth] Checking existing session...');
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error('[Auth] getSession error:', error);
          setAuthState(prev => ({ ...prev, isLoading: false }));
          return;
        }

        if (session?.user) {
          console.log('[Auth] Found existing session, starting hydration...');
          await processSession(session.user, 'getSession');
        } else {
          console.log('[Auth] No session in getSession, finalizing loading');
          setAuthState(prev => ({ ...prev, isLoading: false }));
        }
      } catch (err) {
        console.error('[Auth] Unexpected error during session check:', err);
        setAuthState(prev => ({ ...prev, isLoading: false }));
      }
    };

    checkSession();

    return () => {
      console.log('[Auth] Cleanup - unmounting');
      mountedRef.current = false;
      subscription.unsubscribe();
    };
  }, [hydrateUser]); // Only hydrateUser as dependency (stable via useCallback)

  // Login - just authenticates, hydration follows via listener
  const login = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    console.log('[Auth] Login attempt:', email);
    setAuthState(prev => ({ ...prev, authError: null, isLoading: true }));

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        console.error('[Auth] Login error:', error.message);
        setAuthState(prev => ({ ...prev, isLoading: false }));
        if (error.message.includes('Invalid login credentials')) {
          return { success: false, error: 'Credenciais inválidas' };
        }
        return { success: false, error: error.message };
      }

      if (!data.user) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return { success: false, error: 'Erro ao fazer login' };
      }

      console.log('[Auth] Login successful, waiting for listener to hydrate...');
      // Don't set isLoading to false here - let the listener handle it after hydration
      return { success: true };
    } catch (error: any) {
      console.error('[Auth] Unexpected login error:', error);
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return { success: false, error: 'Erro inesperado' };
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string, nome: string): Promise<{ success: boolean; error?: string }> => {
    setAuthState(prev => ({ ...prev, isLoading: true }));

    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { nome },
          emailRedirectTo: window.location.origin,
        },
      });

      if (error) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return { success: false, error: error.message };
      }

      setAuthState(prev => ({ ...prev, isLoading: false }));
      return { success: true };
    } catch (error: any) {
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return { success: false, error: 'Erro ao criar conta' };
    }
  }, []);

  const logout = useCallback(async () => {
    console.log('[Auth] Logout requested');
    setAuthState(prev => ({ ...prev, isLoading: true }));
    
    try {
      await supabase.auth.signOut();
      // State will be cleared by the listener
    } catch (error) {
      console.error('[Auth] Logout error:', error);
      // Force clear state even if signOut fails
      currentUserRef.current = null;
      setAuthState({
        user: null,
        account: null,
        isAuthenticated: false,
        isLoading: false,
        authError: null,
      });
      setOriginalUser(null);
      setIsImpersonating(false);
    }
  }, []);

  const impersonate = useCallback(async (userId: string) => {
    if (authState.user?.role !== 'super_admin') return;

    try {
      const [profileResult, roleResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('user_id, email, nome, status, permissions, account_id, chatwoot_agent_id')
          .eq('user_id', userId)
          .maybeSingle(),
        supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId)
          .maybeSingle(),
      ]);

      const { data: profile } = profileResult;
      const { data: userRole } = roleResult;

      if (!profile) {
        toast.error('Usuário não encontrado');
        return;
      }

      const role = (userRole?.role as 'super_admin' | 'admin' | 'agent') || 'agent';

      let account: Account | null = null;
      if (profile.account_id) {
        const { data: accountData } = await supabase
          .from('accounts')
          .select('id, nome, status, chatwoot_base_url, chatwoot_account_id')
          .eq('id', profile.account_id)
          .maybeSingle();

        if (accountData) {
          account = {
            id: accountData.id,
            nome: accountData.nome,
            status: accountData.status as 'active' | 'paused' | 'cancelled',
            chatwoot_base_url: accountData.chatwoot_base_url || undefined,
            chatwoot_account_id: accountData.chatwoot_account_id || undefined,
          };
        }
      }

      const targetUser: User = {
        id: userId,
        email: profile.email,
        nome: profile.nome,
        role,
        account_id: profile.account_id || undefined,
        permissions: profile.permissions || ['dashboard'],
        status: profile.status as 'active' | 'inactive' | 'suspended',
        chatwoot_agent_id: profile.chatwoot_agent_id || undefined,
      };

      setOriginalUser(authState.user);
      setIsImpersonating(true);
      setAuthState(prev => ({ ...prev, user: targetUser, account }));

      toast.success(`Assumindo identidade de ${targetUser.nome}`);
    } catch {
      toast.error('Erro ao assumir identidade');
    }
  }, [authState.user]);

  const exitImpersonation = useCallback(() => {
    if (!originalUser) return;

    setAuthState(prev => ({ ...prev, user: originalUser, account: null }));
    setOriginalUser(null);
    setIsImpersonating(false);
    toast.success('Voltou para sua conta original');
  }, [originalUser]);

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        login,
        logout,
        signUp,
        impersonate,
        exitImpersonation,
        isImpersonating,
        originalUser,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Role-based access helpers
export function useRoleAccess() {
  const { user } = useAuth();

  const isSuperAdmin = user?.role === 'super_admin';
  const isAdmin = user?.role === 'admin';
  const isAgent = user?.role === 'agent';

  return {
    isSuperAdmin,
    isAdmin,
    isAgent,
    canAccessSuperAdminPanel: isSuperAdmin,
    canManageUsers: isSuperAdmin || isAdmin,
    canManageFunnel: isSuperAdmin || isAdmin,
    canMoveLeads: isSuperAdmin || isAdmin || isAgent,
    canExecuteRefunds: isSuperAdmin || isAdmin,
    canViewDashboards: isSuperAdmin || isAdmin,
    canAccessSettings: isSuperAdmin || isAdmin,
  };
}
