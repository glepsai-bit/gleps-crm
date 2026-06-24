export interface ExtractedLead {
  id: string;
  nome: string;
  cidade: string;
  endereco: string;
  telefone: string;
  site?: string;
  avaliacao?: number | null;
  total_avaliacoes?: number | null;
  foto?: string;
  status_negocio?: string;
  place_id?: string;
  google_maps_url?: string;
}

/**
 * Shape unificado de inbox usado pelo DispatchDialog.
 *
 * Originalmente refletia o payload da API legacy /api/prospecting/inboxes
 * (Chatwoot REST, `id: number`). T-022 migrou os canais para a tabela Prisma
 * `Inbox` (UUID string) e o dispatcher passou a consumir /api/inboxes
 * (envelope `{data: Inbox[]}`). Aceitamos `id: string | number` para manter
 * compat com possíveis consumidores legados, mas o caminho atual sempre
 * produz UUIDs.
 */
export interface ChatwootInbox {
  id: string;
  name: string;
  channel_type?: string;
  phone_number?: string;
  /**
   * DISP-07: estado da conexão Evolution para canais whatsapp.
   * - `'open'` → pareado, pode disparar
   * - `'connecting'` / `'close'` / `'unknown'` → não conectado; UI deve
   *   bloquear seleção
   * - `null` / `undefined` → não aplicável (não-whatsapp) ou backend não
   *   reportou estado (legacy/edge)
   */
  connection_state?: 'open' | 'connecting' | 'close' | 'unknown' | null;
}

export interface DispatchConfig {
  inbox_id: string;
  delay_seconds: number;
  messages: string[]; // up to 10 variants
}

export interface ApiUsage {
  used: number;
  limit: number;
}
