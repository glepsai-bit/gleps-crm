/**
 * Backend Configuration
 * 
 * Controls whether the frontend uses the Express backend API
 * or Supabase Cloud for data operations.
 * 
 * VITE_USE_BACKEND=true  → Uses Express/Prisma backend (VPS deployment)
 * VITE_USE_BACKEND=false → Uses Supabase Cloud (Lovable Cloud / development)
 */

// Primary flag: set via environment variable
export const useBackend = import.meta.env.VITE_USE_BACKEND === 'true';

// Derived flags
export const useSupabase = !useBackend;

// Log the current mode on startup
if (import.meta.env.DEV) {
  console.log(`[Config] Backend mode: ${useBackend ? 'Express API' : 'Supabase Cloud'}`);
}
