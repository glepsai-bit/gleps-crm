/**
 * Backend Auth Provider
 * 
 * JWT-based authentication using Express backend.
 * Used when VITE_USE_BACKEND=true (VPS deployment).
 * 
 * IMPORTANT: This exports BackendAuthProvider only.
 * useAuth and useRoleAccess are imported from AuthContext.tsx
 * since both providers share the same React context.
 */

import React, { useState, useCallback, useEffect, ReactNode, useRef } from 'react';
import { apiClient, tokenManager } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { toast } from 'sonner';

// Import the shared context from the main AuthContext file
// This is a module-level import for the React context object only
import { AuthContext } from '@/contexts/AuthContext';

// --- Normalize helpers for snake_case / camelCase backend responses ---
function normalizeUser(raw: any): User {
  return {
    id: raw.id,
    email: raw.email,
    nome: raw.nome,
    role: raw.role,
    account_id: raw.account_id ?? raw.accountId,
    permissions: raw.permissions || ['dashboard'],
    status: raw.status || 'active',
  };
}

function normalizeAccount(raw: any): Account | null {
  if (!raw) return null;
  return {
    id: raw.id,
    nome: raw.nome,
    status: raw.status,
  };
}

// Types (same as AuthContext.tsx)
interface User {
  id: string;
  email: string;
  nome: string;
  role: 'super_admin' | 'admin' | 'agent';
  account_id?: string;
  permissions: string[];
  status: 'active' | 'inactive' | 'suspended';
}

interface Account {
  id: string;
  nome: string;
  status: 'active' | 'paused' | 'cancelled';
}

interface AuthState {
  user: User | null;
  account: Account | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
}

const AUTH_CACHE_KEY = 'backend_auth_cache';

// H-CROSS-1a: padronizacao das chaves de token no localStorage.
// Estas constantes precisam bater EXATAMENTE com as usadas em
// src/api/client.ts (tokenManager). Qualquer leitura/escrita feita
// fora do tokenManager DEVE referenciar estas constantes — nunca
// strings cruas como 'accessToken' / 'refreshToken'.
const ACCESS_TOKEN_KEY = 'auth_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const LEGACY_ACCESS_TOKEN_KEY = 'accessToken';
const LEGACY_REFRESH_TOKEN_KEY = 'refreshToken';

/**
 * H-CROSS-1a: Migracao one-shot de chaves de token legadas para as
 * canonicas. Antes coexistiam duas grafias com valores diferentes
 * (`accessToken` + `auth_token`, `refreshToken` + `refresh_token`),
 * o que deixava a UI em estado inconsistente (chamadas usando token
 * antigo nunca refreshado). Esta funcao roda no boot do provider e
 * eh idempotente — se nao houver chave legada, nao faz nada.
 */
function migrateLegacyTokenKeys(): void {
  try {
    const legacyAccess = localStorage.getItem(LEGACY_ACCESS_TOKEN_KEY);
    if (legacyAccess) {
      // So sobrescreve o novo se ele estiver vazio — evita pisar
      // um token mais recente com um legado obsoleto.
      if (!localStorage.getItem(ACCESS_TOKEN_KEY)) {
        localStorage.setItem(ACCESS_TOKEN_KEY, legacyAccess);
      }
      localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
    }
    const legacyRefresh = localStorage.getItem(LEGACY_REFRESH_TOKEN_KEY);
    if (legacyRefresh) {
      if (!localStorage.getItem(REFRESH_TOKEN_KEY)) {
        localStorage.setItem(REFRESH_TOKEN_KEY, legacyRefresh);
      }
      localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
    }
  } catch {
    // localStorage pode estar bloqueado (Safari private mode etc.) — silencioso.
  }
}

function readAuthCache(): { user: User; account: Account | null } | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.user) return null;
    return {
      user: parsed.user as User,
      account: (parsed.account ?? null) as Account | null,
    };
  } catch {
    return null;
  }
}

function writeAuthCache(user: User, account: Account | null): void {
  localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ user, account, cachedAt: new Date().toISOString() }));
}

function clearAuthCache(): void {
  localStorage.removeItem(AUTH_CACHE_KEY);
}

export function BackendAuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    account: null,
    isAuthenticated: false,
    isLoading: true,
    authError: null,
  });
  const [originalUser, setOriginalUser] = useState<User | null>(null);
  const [isImpersonating, setIsImpersonating] = useState(false);
  const mountedRef = useRef(true);
  // L-CHAT-2: flag pra impedir multiplas chamadas concorrentes de hydrate.
  // Sem isso, mounts/re-mounts rapidos (StrictMode dev, troca de route,
  // refetch trigado por outro provider) disparavam varias /api/auth/me
  // simultaneas — e em token expirado isso virava 8+ requests 401/s antes
  // do clearTokens propagar.
  const isHydratingRef = useRef(false);

  const clearAuthError = useCallback(() => {
    setAuthState(prev => ({ ...prev, authError: null }));
  }, []);

  // Hydrate user from /api/auth/me
  const hydrateFromToken = useCallback(async () => {
    // L-CHAT-2: guard concorrencia — se ja tem hydrate em voo, ignora a nova
    // chamada. Antes, um token expirado podia disparar 8+ /api/auth/me em
    // 30s (cada um voltando 401 e atualizando state, que disparava re-render
    // que disparava novo hydrate). Agora so 1 hydrate por vez.
    if (isHydratingRef.current) {
      console.log('[BackendAuth] Hydrate ja em andamento — ignorando chamada concorrente');
      return;
    }
    isHydratingRef.current = true;

    try {
      const token = tokenManager.getToken();
      console.log('[BackendAuth] Hydrating from token:', token ? 'Found' : 'None');

      if (!token) {
        console.log('[BackendAuth] No token found, finalizing loading');
        clearAuthCache();
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return;
      }

      try {
        console.log('[BackendAuth] Fetching user info from backend...');
        const raw = await apiClient.get<any>(API_ENDPOINTS.AUTH.ME);
        // Support both { data: { user, account } } and { user, account }
        const response = raw?.data ?? raw;

        if (!mountedRef.current) return;

        const normalizedUser = normalizeUser(response.user);
        const normalizedAccount = normalizeAccount(response.account);

        console.log('[BackendAuth] Hydration successful for:', response.user?.email);
        writeAuthCache(normalizedUser, normalizedAccount);
        setAuthState({
          user: normalizedUser,
          account: normalizedAccount,
          isAuthenticated: true,
          isLoading: false,
          authError: null,
        });
      } catch (error: any) {
        console.error('[BackendAuth] Failed to hydrate:', error);

        // L-CHAT-2: 401 = token invalido/expirado. Limpa tokens IMEDIATAMENTE
        // e redireciona pra /login. NAO retry — antes o estado ficava
        // suspenso e qualquer re-render disparava novo hydrate, gerando
        // tempestade de 401 (8+ tentativas em 30s observado em prod).
        // Network errors (sem status) seguem com fallback cache.
        if (error?.status === 401) {
          console.log('[BackendAuth] Token invalid/expired, clearing tokens + redirect /login');
          tokenManager.clearTokens();
          clearAuthCache();
          if (mountedRef.current) {
            setAuthState({
              user: null,
              account: null,
              isAuthenticated: false,
              isLoading: false,
              authError: null,
            });
          }
          // Redirect imediato — evita ficar em rota protegida atualizando
          // em loop. Window.location preserva o behavior do interceptor
          // 'auth:unauthorized' (que tambem manda pra /login).
          try {
            if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
              window.location.href = '/login';
            }
          } catch {
            // SSR/teste — silencioso
          }
          return;
        }

        const cached = readAuthCache();

        if (mountedRef.current) {
          if (cached) {
            console.warn('[BackendAuth] Falling back to cached auth session after transient failure');
            setAuthState({
              user: cached.user,
              account: cached.account,
              isAuthenticated: true,
              isLoading: false,
              authError: null,
            });
          } else {
            setAuthState(prev => ({
              ...prev,
              isLoading: false,
              isAuthenticated: false,
            }));
          }
        }
      }
    } finally {
      isHydratingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // H-CROSS-1a: migra chaves legadas ANTES de qualquer leitura de token.
    migrateLegacyTokenKeys();

    const token = tokenManager.getToken();
    const cached = token ? readAuthCache() : null;
    if (cached) {
      setAuthState({
        user: cached.user,
        account: cached.account,
        isAuthenticated: true,
        isLoading: true,
        authError: null,
      });
    }

    hydrateFromToken();

    const handleUnauthorized = () => {
      if (!mountedRef.current) return;
      tokenManager.clearTokens();
      clearAuthCache();
      setAuthState({
        user: null, account: null, isAuthenticated: false, isLoading: false, authError: null,
      });
      setOriginalUser(null);
      setIsImpersonating(false);
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
    };
  }, [hydrateFromToken]);

  const login = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    setAuthState(prev => ({ ...prev, authError: null, isLoading: true }));

    try {
      const raw = await apiClient.post<any>(
        API_ENDPOINTS.AUTH.LOGIN, { email, password }, { skipAuth: true }
      );
      // Support both { data: { user, token, ... } } and flat response
      const response = raw?.data ?? raw;

      const normalizedUser = normalizeUser(response.user);
      const normalizedAccount = normalizeAccount(response.account);

      tokenManager.setToken(response.token);
      tokenManager.setRefreshToken(response.refreshToken);
      writeAuthCache(normalizedUser, normalizedAccount);

      setAuthState({
        user: normalizedUser,
        account: normalizedAccount,
        isAuthenticated: true,
        isLoading: false,
        authError: null,
      });

      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.message || error?.error?.message || 'Erro ao fazer login';
      setAuthState(prev => ({ ...prev, isLoading: false, authError: errorMessage }));
      return { success: false, error: errorMessage };
    }
  }, []);

  const signUp = useCallback(async (_email: string, _password: string, _nome: string): Promise<{ success: boolean; error?: string }> => {
    return { success: false, error: 'Cadastro disponível apenas via administrador' };
  }, []);

  const logout = useCallback(async () => {
    setAuthState(prev => ({ ...prev, isLoading: true }));
    try {
      await apiClient.post(API_ENDPOINTS.AUTH.LOGOUT);
    } catch (error) {
      console.error('[BackendAuth] Logout error:', error);
    } finally {
      tokenManager.clearTokens();
      clearAuthCache();
      setAuthState({
        user: null, account: null, isAuthenticated: false, isLoading: false, authError: null,
      });
      setOriginalUser(null);
      setIsImpersonating(false);
    }
  }, []);

  // T1-IMPERSONATION-LS (security fix):
  // O original_token de impersonation antes ficava em localStorage como texto
  // plano, vivendo entre abas/sessoes e ficando exposto a exfiltracao via XSS.
  // Solucao pragmatica de baixo impacto: trocar por sessionStorage — perde-se
  // ao fechar a aba, drasticamente reduzindo a janela de exposicao. O nome da
  // chave eh constante para evitar typos.
  const ORIGINAL_TOKEN_KEY = 'original_token';

  const readOriginalToken = (): string | null => {
    try {
      return sessionStorage.getItem(ORIGINAL_TOKEN_KEY);
    } catch {
      return null;
    }
  };
  const writeOriginalToken = (token: string): void => {
    try {
      sessionStorage.setItem(ORIGINAL_TOKEN_KEY, token);
    } catch {
      // sessionStorage pode estar bloqueado — silencioso.
    }
  };
  const clearOriginalToken = (): void => {
    try {
      sessionStorage.removeItem(ORIGINAL_TOKEN_KEY);
      // Cleanup defensivo: remove residuos de versoes anteriores que escreviam
      // a chave em localStorage. Idempotente.
      localStorage.removeItem(ORIGINAL_TOKEN_KEY);
    } catch {
      // silencioso
    }
  };

  const impersonate = useCallback(async (userId: string) => {
    if (authState.user?.role !== 'super_admin') return;

    try {
      // Save original token before swapping (sessionStorage — mais efemero)
      const originalToken = tokenManager.getToken();
      if (originalToken) {
        writeOriginalToken(originalToken);
      }

      const raw = await apiClient.post<any>(
        API_ENDPOINTS.AUTH.IMPERSONATE(userId)
      );
      // Support envelope { data: { user, account } }
      const response = raw?.data ?? raw;

      // Use the new JWT for the target user
      if (response.token) {
        tokenManager.setToken(response.token);
      }

      const targetUser = normalizeUser(response.user);
      const targetAccount = normalizeAccount(response.account);
      writeAuthCache(targetUser, targetAccount);

      setOriginalUser(authState.user);
      setIsImpersonating(true);
      setAuthState(prev => ({ ...prev, user: targetUser, account: targetAccount }));
      toast.success(`Assumindo identidade de ${targetUser.nome}`);
    } catch {
      // Restore original token on failure
      const originalToken = readOriginalToken();
      if (originalToken) {
        tokenManager.setToken(originalToken);
        clearOriginalToken();
      }
      toast.error('Erro ao assumir identidade');
    }
  }, [authState.user]);

  const exitImpersonation = useCallback(() => {
    if (!originalUser) return;
    // Restore original super admin token
    const originalToken = readOriginalToken();
    if (originalToken) {
      tokenManager.setToken(originalToken);
      clearOriginalToken();
    }
    writeAuthCache(originalUser, null);
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
