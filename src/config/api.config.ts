/**
 * API Configuration
 * 
 * Environment-specific settings for API communication.
 * Update these values when deploying to different environments.
 */

interface ApiConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}

// Environment detection
const isDevelopment = import.meta.env.DEV;
const isProduction = import.meta.env.PROD;

// Environment-specific base URLs
const API_BASE_URLS = {
  development: '/api', // Proxied to MSW in dev, or real API if running
  staging: import.meta.env.VITE_API_URL_STAGING || 'https://staging-api.example.com',
  production: import.meta.env.VITE_API_URL || 'https://api.example.com',
};

// Determine current environment
function getBaseUrl(): string {
  if (isDevelopment) {
    return API_BASE_URLS.development;
  }
  if (isProduction) {
    return import.meta.env.VITE_API_URL || API_BASE_URLS.production;
  }
  return API_BASE_URLS.development;
}

export const apiConfig: ApiConfig = {
  baseUrl: getBaseUrl(),
  timeout: 30000, // 30 seconds
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
};

// Feature flags for API behavior
export const apiFeatures = {
  // Enable MSW mocking in development (disabled when using backend)
  useMocks: isDevelopment && import.meta.env.VITE_USE_MOCKS !== 'false' && import.meta.env.VITE_USE_BACKEND !== 'true',
  
  // Enable request logging in development
  enableLogging: isDevelopment,
  
  // Enable retry logic
  enableRetry: true,
};

export default apiConfig;
