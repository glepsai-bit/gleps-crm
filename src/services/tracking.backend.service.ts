/**
 * TRACKING (Meta Ads / CTWA) — client do módulo de rastreamento.
 * Padrão: apiClient direto, envelope { data }.
 */
import { apiClient } from '@/api/client';

export interface TrackingConfigView {
  id: string;
  accountId: string;
  pixelId: string | null;
  adAccountId: string | null;
  active: boolean;
  sendLead: boolean;
  sendSchedule: boolean;
  sendPurchase: boolean;
  hasToken: boolean;
  tokenLast4: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingConfigInput {
  accessToken?: string;
  pixelId?: string;
  adAccountId?: string;
  active?: boolean;
  sendLead?: boolean;
  sendSchedule?: boolean;
  sendPurchase?: boolean;
}

export interface TrackingFunnelAdRow {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
  costPerConversation: number | null;
  roas: number | null;
}

export interface TrackingFunnelCampaignRow {
  campaignId: string;
  campaignName: string;
  ads: number;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
  costPerConversation: number | null;
  roas: number | null;
}

export interface TrackingDailyPoint {
  date: string;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
}

/** O que a Meta efetivamente recebeu, por evento. */
export interface TrackingDeliveryStat {
  eventName: 'Lead' | 'Schedule' | 'Purchase';
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
}

export interface TrackingFunnel {
  period: { from: string; to: string };
  connected: boolean;
  spendAvailable: boolean;
  /** Motivo real quando o investimento não pôde ser lido da Meta. */
  spendError: string | null;
  hasAdAccount: boolean;
  totals: {
    spend: number;
    impressions: number;
    linkClicks: number;
    ctwaConversations: number;
    organicConversations: number;
    meetings: number;
    purchases: number;
    revenue: number;
    costPerConversation: number | null;
    costPerMeeting: number | null;
    costPerPurchase: number | null;
    roas: number | null;
    convRate: number | null;
    closeRate: number | null;
  };
  delivery: TrackingDeliveryStat[];
  daily: TrackingDailyPoint[];
  byCampaign: TrackingFunnelCampaignRow[];
  byAd: TrackingFunnelAdRow[];
}

export interface TrackingEventRow {
  id: string;
  eventName: string;
  status: string;
  error: string | null;
  value: string | number | null;
  sourceType: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface TrackingConnectionCheck {
  key: 'pixel' | 'adAccount' | 'insights';
  label: string;
  ok: boolean;
  detail: string;
  hint: string | null;
}

export interface TrackingReconcileReport {
  dryRun: boolean;
  window: { from: string; to: string };
  gaps: { Lead: number; Schedule: number; Purchase: number; total: number };
  recoverable: number;
  outOfWindow: number;
  sent: number;
  failed: number;
  skipped: number;
  retriedFailed: number;
  retriedOk: number;
  capped: boolean;
  samples: Array<{
    eventName: string;
    label: string;
    occurredAt: string;
    recoverable: boolean;
  }>;
}

export interface TrackingVerifyResult {
  checks: TrackingConnectionCheck[];
  /** null quando a conexão não está ativa — só os checks são possíveis. */
  report: TrackingReconcileReport | null;
}

interface DataEnvelope<T> {
  data: T;
}

/**
 * verify/reconcile falam com a Graph API dentro do request, então os 30s
 * padrão do client cortam no meio. 115s fica abaixo do teto do nginx (120s):
 * o erro que aparece é o do servidor, não um timeout do browser sem relatório.
 */
const TRACKING_OP_TIMEOUT_MS = 115_000;

export const trackingBackendService = {
  async getConfig(): Promise<TrackingConfigView | null> {
    const res = await apiClient.get<DataEnvelope<TrackingConfigView | null>>('/api/tracking/config');
    return res.data;
  },

  async saveConfig(input: TrackingConfigInput): Promise<TrackingConfigView> {
    const res = await apiClient.put<DataEnvelope<TrackingConfigView>>('/api/tracking/config', input);
    return res.data;
  },

  async getFunnel(days: number): Promise<TrackingFunnel> {
    const res = await apiClient.get<DataEnvelope<TrackingFunnel>>(`/api/tracking/funnel?days=${days}`);
    return res.data;
  },

  async listEvents(limit = 50): Promise<TrackingEventRow[]> {
    const res = await apiClient.get<DataEnvelope<TrackingEventRow[]>>(`/api/tracking/events?limit=${limit}`);
    return res.data;
  },

  /** Diagnóstico read-only: testa os ativos e mede a diferença CRM × Meta. */
  async verify(days: number): Promise<TrackingVerifyResult> {
    const res = await apiClient.post<DataEnvelope<TrackingVerifyResult>>(
      '/api/tracking/verify',
      { days },
      { timeout: TRACKING_OP_TIMEOUT_MS }
    );
    return res.data;
  },

  /** ENVIA à Meta o que ficou pra trás. Sem confirm=true não sai nada. */
  async reconcile(days: number, confirm: boolean): Promise<TrackingReconcileReport> {
    const res = await apiClient.post<DataEnvelope<TrackingReconcileReport>>(
      '/api/tracking/reconcile',
      { days, confirm },
      { timeout: TRACKING_OP_TIMEOUT_MS }
    );
    return res.data;
  },
};
