// Backend-mode stub for the Supabase client.
// When VITE_USE_BACKEND=true, vite.config.ts aliases
// '@/integrations/supabase/client' to this file so that the bundle does NOT
// pull in the real Supabase SDK in production. Re-exports the safe proxy
// stub already defined in client.ts.
export { supabase } from './client';