/**
 * HTTP Client Configuration
 * 
 * Centralized API client with:
 * - JWT token injection via interceptors
 * - Automatic error handling (401 → redirect to login)
 * - Retry logic for network errors
 * - Environment-based URL configuration
 */

import { apiConfig } from '@/config/api.config';

// Types for API responses
export interface ApiResponse<T> {
  data: T;
  message?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export interface ApiError {
  message: string;
  code?: string;
  status: number;
  details?: Record<string, unknown>;
}

// Token storage keys
const TOKEN_KEY = 'auth_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

// Refresh token mutex
let refreshPromise: Promise<boolean> | null = null;

// Token management
export const tokenManager = {
  getToken: (): string | null => {
    return localStorage.getItem(TOKEN_KEY);
  },
  
  setToken: (token: string): void => {
    localStorage.setItem(TOKEN_KEY, token);
  },
  
  getRefreshToken: (): string | null => {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  
  setRefreshToken: (token: string): void => {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  },
  
  clearTokens: (): void => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

// Request options type
interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined | null> | object;
  skipAuth?: boolean;
  timeout?: number;
}

// Build URL with query params
function buildUrl(endpoint: string, params?: object): string {
  const baseUrl = apiConfig.baseUrl;
  
  let fullPath: string;
  
  if (endpoint.startsWith('http')) {
    // Absolute URL — use as-is
    fullPath = endpoint;
  } else {
    // Normalize: avoid /api/api duplication
    // baseUrl is typically "/api" and endpoints already start with "/api/..."
    let normalizedEndpoint = endpoint;
    if (baseUrl && !baseUrl.startsWith('http')) {
      // Relative base (e.g. "/api") — strip duplicate prefix from endpoint
      const prefix = baseUrl.replace(/\/+$/, ''); // "/api"
      if (normalizedEndpoint.startsWith(prefix + '/')) {
        normalizedEndpoint = normalizedEndpoint.slice(prefix.length);
      }
      fullPath = `${window.location.origin}${prefix}${normalizedEndpoint}`;
    } else if (baseUrl && baseUrl.startsWith('http')) {
      // Absolute base URL
      const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
      if (prefix && normalizedEndpoint.startsWith(prefix + '/')) {
        normalizedEndpoint = normalizedEndpoint.slice(prefix.length);
      }
      fullPath = `${baseUrl.replace(/\/+$/, '')}${normalizedEndpoint}`;
    } else {
      fullPath = `${window.location.origin}${normalizedEndpoint}`;
    }
  }
  
  const url = new URL(fullPath);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }
  
  return url.toString();
}

// Create timeout promise
function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timeout')), ms);
  });
}

// Deduplicated token refresh
async function tryRefreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = tokenManager.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const response = await fetch(buildUrl('/api/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;
      const result = await response.json();
      const data = result?.data ?? result;
      if (data?.token) {
        tokenManager.setToken(data.token);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Handle response errors — throws ApiError, does NOT handle refresh/logout
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorData: ApiError;
    try {
      const body = await response.json();
      errorData = {
        message: body?.error?.message || body?.message || body?.error || response.statusText || 'Erro desconhecido',
        code: body?.error?.code || body?.code,
        status: response.status,
        details: body?.details,
      };
    } catch {
      errorData = { message: response.statusText || 'Erro desconhecido', status: response.status };
    }
    throw errorData;
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

// Core request function with automatic token refresh
async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { params, skipAuth = false, timeout = apiConfig.timeout, ...fetchOptions } = options;

  const url = buildUrl(endpoint, params);

  const buildHeaders = (): HeadersInit => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers as Record<string, string>),
    };
    if (!skipAuth) {
      const token = tokenManager.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  };

  const doFetch = (): Promise<T> => {
    const config: RequestInit = { ...fetchOptions, headers: buildHeaders() };
    return fetch(url, config).then(res => handleResponse<T>(res));
  };

  const applyTimeout = (p: Promise<T>): Promise<T> =>
    timeout > 0 ? Promise.race([p, createTimeoutPromise(timeout)]) : p;

  try {
    return await applyTimeout(doFetch());
  } catch (err: any) {
    // On any 401 for authenticated requests, try refresh once then retry
    if (!skipAuth && err?.status === 401) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        return applyTimeout(doFetch());
      }
      // Refresh failed or no refresh token — force global logout
      tokenManager.clearTokens();
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }

    throw err;
  }
}

// API client methods
export const apiClient = {
  get: <T>(endpoint: string, options?: RequestOptions): Promise<T> =>
    request<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, data?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>(endpoint, { ...options, method: 'POST', body: data ? JSON.stringify(data) : undefined }),

  put: <T>(endpoint: string, data?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>(endpoint, { ...options, method: 'PUT', body: data ? JSON.stringify(data) : undefined }),

  patch: <T>(endpoint: string, data?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>(endpoint, { ...options, method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),

  delete: <T>(endpoint: string, options?: RequestOptions): Promise<T> =>
    request<T>(endpoint, { ...options, method: 'DELETE' }),
};

export default apiClient;
