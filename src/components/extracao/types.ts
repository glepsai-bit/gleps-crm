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

export interface ChatwootInbox {
  id: number;
  name: string;
  channel_type?: string;
  phone_number?: string;
}

export interface DispatchConfig {
  inbox_id: number;
  delay_seconds: number;
  messages: string[]; // up to 10 variants
}

export interface ApiUsage {
  used: number;
  limit: number;
}
