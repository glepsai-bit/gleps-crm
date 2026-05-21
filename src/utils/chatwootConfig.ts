/**
 * Shared Chatwoot configuration check utility.
 * 
 * In backend mode, the API key is stored server-side only,
 * so we only require base_url + account_id on the client.
 * In cloud mode, the API key must also be present on the client.
 */
import { useBackend } from '@/config/backend.config';

interface AccountLike {
  chatwoot_base_url?: string | null;
  chatwoot_account_id?: string | null;
  chatwoot_api_key?: string | null;
}

export function hasChatwootConfig(account: AccountLike | null | undefined): boolean {
  if (!account) return false;

  const hasBase = Boolean(account.chatwoot_base_url && account.chatwoot_account_id);

  if (useBackend) {
    // Backend mode: API key is server-side, not required on client
    return hasBase;
  }

  // Cloud mode: all three fields required on client
  return hasBase && Boolean(account.chatwoot_api_key);
}
