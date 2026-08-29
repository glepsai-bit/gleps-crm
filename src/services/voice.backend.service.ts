/**
 * T-029 — Discador. Mesmo padrão dos demais: apiClient direto, envelope { data }.
 */
import { apiClient } from '@/api/client';

interface DataEnvelope<T> {
  data: T;
}

export const SENTINEL = '***SET***';

export interface VoiceConfig {
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioApiKeySid: string | null;
  twilioApiKeySecret: string | null;
  twilioTwimlAppSid: string | null;
  twilioCallerId: string | null;
  voiceRecording: boolean;
  /** O que ainda falta preencher pra conseguir discar. Vazio = pronto. */
  pendencias: string[];
  /** URL que o admin cola no TwiML App da Twilio. */
  twimlVoiceUrl: string;
}

export interface VoiceConfigInput {
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  twilioApiKeySid?: string | null;
  twilioApiKeySecret?: string | null;
  twilioTwimlAppSid?: string | null;
  twilioCallerId?: string | null;
  voiceRecording?: boolean;
}

export type CallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled';

export interface CallRecord {
  id: string;
  direction: string;
  toNumber: string;
  fromNumber: string | null;
  status: CallStatus;
  durationSec: number | null;
  priceUsd: string | number | null;
  recordingUrl: string | null;
  disposition: string | null;
  notes: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  contact: { id: string; nome: string; telefone: string | null } | null;
  user: { id: string; nome: string } | null;
}

export const voiceService = {
  async getConfig(): Promise<VoiceConfig> {
    const r = await apiClient.get<DataEnvelope<VoiceConfig>>('/api/voice/config');
    return r.data;
  },

  async updateConfig(input: VoiceConfigInput): Promise<VoiceConfig> {
    const r = await apiClient.patch<DataEnvelope<VoiceConfig>>('/api/voice/config', input);
    return r.data;
  },

  /** Credencial curta que o SDK do navegador usa. Renovar ao abrir o discador. */
  async getToken(): Promise<{ token: string; expiresIn: number }> {
    const r = await apiClient.get<DataEnvelope<{ token: string; expiresIn: number }>>(
      '/api/voice/token'
    );
    return r.data;
  },

  /** Registra a ligação ANTES de conectar; o callId vai junto pro SDK. */
  async startCall(to: string, contactId?: string | null): Promise<{ callId: string; to: string }> {
    const r = await apiClient.post<DataEnvelope<{ callId: string; to: string }>>(
      '/api/voice/calls',
      { to, ...(contactId ? { contactId } : {}) }
    );
    return r.data;
  },

  async listCalls(params: { contactId?: string; limit?: number } = {}): Promise<CallRecord[]> {
    const qs = new URLSearchParams();
    if (params.contactId) qs.set('contactId', params.contactId);
    if (params.limit) qs.set('limit', String(params.limit));
    const sufixo = qs.toString() ? `?${qs.toString()}` : '';
    const r = await apiClient.get<DataEnvelope<CallRecord[]>>(`/api/voice/calls${sufixo}`);
    return r.data;
  },

  async setOutcome(
    callId: string,
    input: { disposition?: string; notes?: string }
  ): Promise<CallRecord> {
    const r = await apiClient.post<DataEnvelope<CallRecord>>(
      `/api/voice/calls/${callId}/outcome`,
      input
    );
    return r.data;
  },
};
