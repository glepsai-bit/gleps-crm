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
  campaignName: string;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
}

export interface TrackingFunnel {
  period: { from: string; to: string };
  connected: boolean;
  spendAvailable: boolean;
  totals: {
    spend: number;
    ctwaConversations: number;
    organicConversations: number;
    meetings: number;
    purchases: number;
    revenue: number;
    costPerConversation: number | null;
    costPerMeeting: number | null;
    costPerPurchase: number | null;
  };
  byAd: TrackingFunnelAdRow[];
}

export interface TrackingEventRow {
  id: string;
  eventName: string;
  status: string;
  error: string | null;
  value: string | number | null;
  sentAt: string | null;
  createdAt: string;
}

interface DataEnvelope<T> {
  data: T;
}

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
};
