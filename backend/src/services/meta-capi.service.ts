/**
 * META CAPI — Conversions API for Business Messaging + Marketing API (spend).
 *
 * Três portas da Graph API, mesma chave (token da BM do tenant):
 *  1. POST /{pixelId}/events — envia eventos de conversão (Lead/Schedule/
 *     Purchase) com action_source='business_messaging' + ctwa_clid. É o que
 *     devolve dado real pra Meta otimizar campanhas CTWA e baixar custo.
 *  2. GET /act_{adAccountId}/insights — lê gasto/impressões/cliques por
 *     anúncio (opcionalmente quebrado por dia) para o funil.
 *  3. GET /?ids=... — resolve nome do anúncio e da campanha por ID, sem
 *     depender de haver gasto no período.
 *
 * Host fixo (graph.facebook.com) — sem SSRF surface. Nunca logamos o token.
 */
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const REQUEST_TIMEOUT_MS = 15_000;
/** Teto de páginas do insights — 500 linhas/página. */
const MAX_PAGES = 5;
/**
 * Com time_increment=1 a resposta é uma linha por (anúncio × dia), então o
 * mesmo teto estouraria muito antes. 40 páginas cobrem ~20 mil linhas.
 */
const MAX_PAGES_DAILY = 40;

/**
 * A CAPI rejeita event_time com mais de 7 dias. Reconciliação retroativa só
 * consegue recuperar dentro dessa janela — o resto fica registrado como
 * "fora da janela" em vez de virar erro silencioso.
 */
export const CAPI_MAX_EVENT_AGE_DAYS = 7;

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

export interface AdInsightRow {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  /** YYYY-MM-DD quando pedido com daily; null no agregado do período. */
  date: string | null;
}

/**
 * Resultado do insights com o erro EXPOSTO. A versão antiga engolia a falha e
 * devolvia [], o que fazia a tela dizer "conecte a conta de anúncios" mesmo
 * com a conta conectada — o usuário não tinha como saber que era permissão.
 */
export interface AdInsightsResult {
  rows: AdInsightRow[];
  error: string | null;
}

export interface AdMetaRow {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
}

export interface ConnectionCheck {
  key: 'pixel' | 'adAccount' | 'insights';
  label: string;
  ok: boolean;
  detail: string;
  /** O que fazer quando ok=false. */
  hint: string | null;
}

/** `123` e `act_123` são o mesmo ativo — a Graph API só aceita com prefixo. */
function normalizeActId(adAccountId: string): string {
  const trimmed = adAccountId.trim();
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

function graphErrorMessage(
  body: { error?: { message?: string; code?: number } } | null,
  status: number
): string {
  return body?.error?.message ?? `HTTP ${status}`;
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
    // event_id: deduplicação — se o mesmo evento reenviar (retry/reconcile), o
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
      throw new Error(`Meta CAPI ${res.status}: ${graphErrorMessage(body, res.status)}`);
    }

    logger.info('[meta-capi] evento enviado', {
      pixelId: creds.pixelId,
      eventName: input.eventName,
      eventsReceived: body?.events_received ?? null,
    });
    return body;
  }

  /**
   * Gasto/impressões/cliques por anúncio no período (level=ad, com campanha
   * junto). `daily: true` quebra por dia (time_increment=1) — é o que alimenta
   * o gráfico de evolução.
   *
   * Nunca lança: devolve as linhas que conseguiu + o erro da Meta, pra tela
   * mostrar o motivo real em vez de um traço mudo.
   */
  async getAdInsights(
    accessToken: string,
    adAccountId: string,
    since: string, // YYYY-MM-DD
    until: string,
    opts: { daily?: boolean } = {}
  ): Promise<AdInsightsResult> {
    const actId = normalizeActId(adAccountId);
    const params = new URLSearchParams({
      level: 'ad',
      fields: 'ad_id,ad_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks',
      time_range: JSON.stringify({ since, until }),
      limit: '500',
      access_token: accessToken,
    });
    if (opts.daily) params.set('time_increment', '1');

    const rows: AdInsightRow[] = [];
    // paging.next já vem com o token embutido — nunca logar essa URL.
    let url: string = `${GRAPH_BASE}/${encodeURIComponent(actId)}/insights?${params}`;

    try {
      const maxPages = opts.daily ? MAX_PAGES_DAILY : MAX_PAGES;
      for (let page = 0; page < maxPages && url; page++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const body = (await res.json().catch(() => null)) as {
          data?: Array<Record<string, string | undefined>>;
          paging?: { next?: string };
          error?: { message?: string; code?: number };
        } | null;

        if (!res.ok || body?.error || !Array.isArray(body?.data)) {
          const error = graphErrorMessage(body, res.status);
          logger.warn('[meta-capi] insights falhou', { adAccountId: actId, status: res.status, error });
          return { rows, error };
        }

        for (const row of body.data) {
          rows.push({
            adId: row.ad_id ?? '',
            adName: row.ad_name ?? '',
            campaignId: row.campaign_id ?? '',
            campaignName: row.campaign_name ?? '',
            spend: Number(row.spend ?? 0),
            impressions: Number(row.impressions ?? 0),
            linkClicks: Number(row.inline_link_clicks ?? 0),
            date: row.date_start ?? null,
          });
        }

        url = typeof body.paging?.next === 'string' ? body.paging.next : '';
      }

      if (url) {
        // Saiu do laço com paginação pendente: o gasto lido é PARCIAL.
        // Reportar como completo infla o ROAS e subestima o custo por etapa,
        // e a tela não teria como saber que o número está pela metade.
        logger.warn('[meta-capi] insights truncado pelo teto de páginas', {
          adAccountId: actId,
          rows: rows.length,
        });
        return {
          rows,
          error:
            'Gasto parcial: o período tem anúncios/dias demais para uma leitura só. Reduza o intervalo para ver os números completos.',
        };
      }
      return { rows, error: null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('[meta-capi] insights erro de rede', { adAccountId: actId, error });
      return { rows, error };
    }
  }

  /**
   * Nome do anúncio + campanha por ID, direto do objeto (não do insights).
   * É o que permite mostrar "Campanha X" para anúncios que geraram conversa
   * mas não têm linha de gasto no período. Best-effort: o que não resolver
   * simplesmente fica de fora do mapa.
   */
  async getAdMeta(accessToken: string, adIds: string[]): Promise<Map<string, AdMetaRow>> {
    const out = new Map<string, AdMetaRow>();
    const ids = Array.from(new Set(adIds.filter((id) => id && id.trim())));
    if (ids.length === 0) return out;

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const params = new URLSearchParams({
        ids: batch.join(','),
        fields: 'id,name,campaign{id,name}',
        access_token: accessToken,
      });
      try {
        const res = await fetch(`${GRAPH_BASE}/?${params}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok || !body || body.error) {
          logger.warn('[meta-capi] getAdMeta falhou', {
            status: res.status,
            batch: batch.length,
          });
          continue;
        }
        for (const [id, raw] of Object.entries(body)) {
          const node = raw as { name?: string; campaign?: { id?: string; name?: string } } | null;
          if (!node || typeof node !== 'object') continue;
          out.set(id, {
            adId: id,
            adName: node.name ?? '',
            campaignId: node.campaign?.id ?? '',
            campaignName: node.campaign?.name ?? '',
          });
        }
      } catch (err) {
        logger.warn('[meta-capi] getAdMeta erro de rede', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /**
   * Testa cada ativo isoladamente e devolve o motivo real de cada falha.
   * Sem isto o usuário só vê "—" e não tem como saber se o problema é o
   * token, o dataset ou a atribuição de ativo na Business Manager.
   */
  async checkConnection(
    accessToken: string,
    pixelId: string | null,
    adAccountId: string | null,
    period?: { since: string; until: string }
  ): Promise<ConnectionCheck[]> {
    const checks: ConnectionCheck[] = [];

    // 1. Pixel / Dataset — o token consegue enxergar a fonte de dados?
    if (!pixelId) {
      checks.push({
        key: 'pixel',
        label: 'Pixel / Dataset',
        ok: false,
        detail: 'Não informado.',
        hint: 'Preencha o ID do pixel/dataset — sem ele nenhum evento é enviado.',
      });
    } else {
      const r = await this.graphGet(`/${encodeURIComponent(pixelId)}?fields=id,name`, accessToken);
      checks.push({
        key: 'pixel',
        label: 'Pixel / Dataset',
        ok: r.ok,
        detail: r.ok
          ? `Conectado: ${(r.body as { name?: string })?.name || pixelId}`
          : r.error,
        hint: r.ok
          ? null
          : 'Na Business Manager, atribua essa fonte de dados ao usuário do sistema com permissão de Gerenciar.',
      });
    }

    // 2. Conta de anúncios — o token tem o ativo atribuído?
    if (!adAccountId) {
      checks.push({
        key: 'adAccount',
        label: 'Conta de anúncios',
        ok: false,
        detail: 'Não informada.',
        hint: 'Sem ela o funil não mostra investimento nem nome de campanha.',
      });
    } else {
      const actId = normalizeActId(adAccountId);
      const r = await this.graphGet(
        `/${encodeURIComponent(actId)}?fields=id,name,account_status,currency`,
        accessToken
      );
      const info = r.body as { name?: string; currency?: string } | null;
      checks.push({
        key: 'adAccount',
        label: 'Conta de anúncios',
        ok: r.ok,
        detail: r.ok
          ? `${info?.name || actId} · moeda ${info?.currency || '—'}`
          : r.error,
        hint: r.ok
          ? null
          : 'Atribua a conta de anúncios ao usuário do sistema (permissão Gerenciar campanhas) e gere o token com ads_read.',
      });
    }

    // 3. Insights — a leitura de gasto realmente funciona no período?
    if (adAccountId && period) {
      const { rows, error } = await this.getAdInsights(
        accessToken,
        adAccountId,
        period.since,
        period.until
      );
      checks.push({
        key: 'insights',
        label: 'Leitura de investimento',
        ok: error === null,
        detail:
          error !== null
            ? error
            : rows.length > 0
              ? `${rows.length} anúncio(s) com dados no período.`
              : 'Acesso OK, mas nenhum anúncio teve veiculação no período.',
        hint: error === null ? null : 'Confira se o token tem a permissão ads_read.',
      });
    }

    return checks;
  }

  /** GET simples na Graph API com o erro já normalizado. */
  private async graphGet(
    path: string,
    accessToken: string
  ): Promise<{ ok: boolean; body: unknown; error: string }> {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(
        `${GRAPH_BASE}${path}${sep}access_token=${encodeURIComponent(accessToken)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      );
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string; code?: number };
      } | null;
      if (!res.ok || body?.error) {
        return { ok: false, body, error: graphErrorMessage(body, res.status) };
      }
      return { ok: true, body, error: '' };
    } catch (err) {
      return {
        ok: false,
        body: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const metaCapiService = new MetaCapiService();
