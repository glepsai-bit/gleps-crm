/**
 * META CAPI — Conversions API for Business Messaging + Marketing API (spend).
 *
 * Duas portas da Graph API, mesma chave (token da BM do tenant):
 *  1. POST /{pixelId}/events — envia eventos de conversão (Lead/Schedule/
 *     Purchase) com action_source='business_messaging' + ctwa_clid. É o que
 *     devolve dado real pra Meta otimizar campanhas CTWA e baixar custo.
 *  2. GET /act_{adAccountId}/insights — lê gasto por anúncio para o funil.
 *
 * Host fixo (graph.facebook.com) — sem SSRF surface. Nunca logamos o token.
 */
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const REQUEST_TIMEOUT_MS = 15_000;

export interface CapiCredentials {
  accessToken: string;
  pixelId: string;
}

export interface CapiEventInput {
  /** Evento padrão Meta: 'Lead' | 'Schedule' | 'Purchase' */
  eventName: string;
  /** Click ID do anúncio CTWA (obrigatório para atribuição) */
  ctwaClid: string;
  /** Unix seconds do momento do evento */
  eventTime: number;
  value?: number;
  currency?: string;
  /** ID único do evento p/ deduplicação no Meta (evita contar em dobro). */
  eventId?: string;
  /** Telefone do lead — enviado HASHEADO em user_data.ph (2º sinal de match). */
  phone?: string | null;
}

export interface AdSpendRow {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
}

/**
 * Normaliza + SHA-256 do telefone pro campo user_data.ph do CAPI (padrão Meta:
 * só dígitos com código do país, sem símbolos; hash hex minúsculo). Dá ao Meta
 * um 2º sinal de match além do ctwa_clid — recupera leads que o clid sozinho
 * não casa. Retorna null quando não há telefone utilizável.
 */
export function hashPhone(phone: string | null | undefined): string | null {
  const digits = (phone || '').replace(/\D+/g, '');
  if (!digits) return null;
  return createHash('sha256').update(digits).digest('hex');
}

class MetaCapiService {
  /**
   * Envia UM evento de conversão. Lança em falha (o caller decide se é
   * best-effort) — a mensagem de erro nunca inclui o token.
   */
  async sendEvent(creds: CapiCredentials, input: CapiEventInput): Promise<unknown> {
    const userData: Record<string, unknown> = { ctwa_clid: input.ctwaClid };
    // Telefone hasheado: 2º sinal de match além do clid (padrão CAPI, array).
    const ph = hashPhone(input.phone);
    if (ph) userData.ph = [ph];

    const event: Record<string, unknown> = {
      event_name: input.eventName,
      event_time: input.eventTime,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
    };
    // event_id: deduplicação — se o mesmo evento reenviar (retry/reconnect), o
    // Meta conta uma vez só.
    if (input.eventId) event.event_id = input.eventId;

    if (input.eventName === 'Purchase' || input.value != null) {
      event.custom_data = {
        value: input.value ?? 0,
        currency: input.currency ?? 'BRL',
      };
    }

    const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(creds.pixelId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [event],
        access_token: creds.accessToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = (await res.json().catch(() => null)) as
      | { events_received?: number; error?: { message?: string; code?: number } }
      | null;

    if (!res.ok || body?.error) {
      throw new Error(
        `Meta CAPI ${res.status}: ${body?.error?.message ?? 'resposta inválida'}`
      );
    }

    logger.info('[meta-capi] evento enviado', {
      pixelId: creds.pixelId,
      eventName: input.eventName,
      eventsReceived: body?.events_received ?? null,
    });
    return body;
  }

  /**
   * Gasto por anúncio no período (level=ad, com campanha junto).
   * Retorna [] em erro — o funil interno não pode quebrar por causa da
   * Marketing API fora do ar.
   */
  async getAdSpend(
    accessToken: string,
    adAccountId: string,
    since: string, // YYYY-MM-DD
    until: string
  ): Promise<AdSpendRow[]> {
    try {
      const actId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
      const params = new URLSearchParams({
        level: 'ad',
        fields: 'ad_id,ad_name,campaign_id,campaign_name,spend',
        time_range: JSON.stringify({ since, until }),
        limit: '200',
        access_token: accessToken,
      });
      const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(actId)}/insights?${params}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            data?: Array<{
              ad_id?: string;
              ad_name?: string;
              campaign_id?: string;
              campaign_name?: string;
              spend?: string;
            }>;
            error?: { message?: string };
          }
        | null;
      if (!res.ok || body?.error || !Array.isArray(body?.data)) {
        logger.warn('[meta-capi] insights falhou', {
          adAccountId,
          status: res.status,
          error: body?.error?.message ?? null,
        });
        return [];
      }
      return body.data.map((row) => ({
        adId: row.ad_id ?? '',
        adName: row.ad_name ?? '',
        campaignId: row.campaign_id ?? '',
        campaignName: row.campaign_name ?? '',
        spend: Number(row.spend ?? 0),
      }));
    } catch (err) {
      logger.warn('[meta-capi] insights erro de rede', {
        adAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

export const metaCapiService = new MetaCapiService();
