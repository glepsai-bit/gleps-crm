import { prisma } from '../config/database';
import { env } from '../config/env';

// Extração de leads no Google Maps (RapidAPI) + uso mensal. O disparo que
// morava aqui (dispatch/processDispatch/batches/resume/cancel) saiu na etapa C1:
// quem dispara é o motor único em disparo.service.ts.

const RAPIDAPI_HOST = 'maps-data.p.rapidapi.com';

/**
 * Resolve a RAPIDAPI_KEY exclusivamente do ambiente (sem fallback hardcoded).
 * O fallback histórico foi removido em T-026 — repositório público e a chave
 * embutida em código é vetor de leak permanente. Se ausente, callers devem
 * abortar com 503 (`ensureRapidApiKey`).
 */
function getRapidApiKey(): string {
  return (env.RAPIDAPI_KEY || process.env.RAPIDAPI_KEY || '').trim();
}

/**
 * Fail-loud: lança erro 503 se a key não estiver configurada.
 * Usar antes de qualquer chamada outbound à RapidAPI.
 */
function ensureRapidApiKey(): string {
  const key = getRapidApiKey();
  if (!key) {
    throw Object.assign(
      new Error('Prospecting indisponível: RAPIDAPI_KEY não configurada no ambiente.'),
      { statusCode: 503, code: 'PROSPECTING_NOT_CONFIGURED' }
    );
  }
  return key;
}

interface GeocodingResponse {
  status: string;
  data?: { lat: number; lng: number };
}

interface NearbyPlace {
  name?: string;
  full_address?: string;
  city?: string;
  phone_number?: string;
  website?: string;
  rating?: number;
  reviews?: number;
  review_count?: number;
  photo?: string;
  business_status?: string;
  place_id?: string;
  google_maps_url?: string;
  place_link?: string;
  latitude?: number;
  longitude?: number;
  types?: string[];
}

interface NearbyResponse {
  status: string;
  data?: NearbyPlace[];
}


class ProspectingService {
  /**
   * Get current month extraction usage for the account.
   * Returns "completed extractions" units, where each extraction = 2 raw API requests
   * (1 geocoding + 1 nearby search). Counter resets monthly (calendar month).
   */
  async getUsage(accountId: string): Promise<{ used: number; limit: number }> {
    const currentMonth = new Date().toISOString().slice(0, 7);

    const [usageLogs, account] = await Promise.all([
      prisma.apiUsageLog.findMany({
        where: { accountId, month: currentMonth },
        select: { requestsCount: true },
      }),
      prisma.account.findUnique({
        where: { id: accountId },
        select: { monthlyExtractionLimit: true },
      }),
    ]);

    const totalRequests = usageLogs.reduce((sum, r) => sum + r.requestsCount, 0);
    // Each extraction consumes 2 raw API requests; report in "extraction" units to the user
    const usedExtractions = Math.floor(totalRequests / 2);
    const limit = (account as any)?.monthlyExtractionLimit ?? 500;

    return { used: usedExtractions, limit };
  }

  /**
   * Extract leads from Google Maps via RapidAPI
   *
   * Estratégia robusta:
   *  1) Geocoding da localização (para enriquecer a busca por proximidade).
   *  2) Disparo PARALELO de 2 endpoints:
   *     - searchmaps.php   → busca textual "{nicho} {localizacao}" (cobertura ampla)
   *     - nearby.php       → busca por coordenadas (cobertura local densa)
   *  3) Mescla + deduplicação por place_id / nome+telefone.
   *  4) Conta uso apenas se houver leads.
   */
  async extractLeads(accountId: string, nicho: string, localizacao: string) {
    const rapidApiKey = ensureRapidApiKey();

    // Check monthly quota
    const currentMonth = new Date().toISOString().slice(0, 7);
    const usageLogs = await prisma.apiUsageLog.findMany({
      where: { accountId, month: currentMonth },
      select: { requestsCount: true },
    });
    const totalUsed = usageLogs.reduce((sum, r) => sum + r.requestsCount, 0);

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { monthlyExtractionLimit: true },
    });

    // monthlyExtractionLimit may not exist on old Prisma schemas - default to 500
    const limit = (account as any)?.monthlyExtractionLimit ?? 500;

    // `limit` is expressed in "extractions" (1 extraction = 2 raw API requests).
    // Convert raw request counter to extractions before comparing with the limit.
    const usedExtractions = Math.floor(totalUsed / 2);
    if (usedExtractions >= limit) {
      throw Object.assign(
        new Error(`Limite mensal atingido (${usedExtractions}/${limit} extrações). Contate o administrador.`),
        { statusCode: 429 }
      );
    }

    const headers = { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': rapidApiKey };

    // ---------- Step 1: Geocoding (não-fatal) ----------
    let lat: number | null = null;
    let lng: number | null = null;
    try {
      const geocodeUrl = `https://${RAPIDAPI_HOST}/geocoding.php?query=${encodeURIComponent(localizacao)}&country=br&lang=pt`;
      const geocodeRes = await fetch(geocodeUrl, { headers });
      if (geocodeRes.ok) {
        const geocodeData = (await geocodeRes.json()) as GeocodingResponse;
        if (geocodeData.data?.lat && geocodeData.data?.lng) {
          lat = geocodeData.data.lat;
          lng = geocodeData.data.lng;
        }
      }
    } catch (e) {
      console.warn('[prospecting] geocoding failed (non-fatal):', (e as Error).message);
    }

    // ---------- Step 2: Buscas paralelas ----------
    const queries: Array<Promise<NearbyPlace[]>> = [];

    // Busca textual ampla (sempre executada)
    queries.push(
      this.fetchPlaces(
        `https://${RAPIDAPI_HOST}/searchmaps.php?query=${encodeURIComponent(`${nicho} ${localizacao}`)}&lang=pt&country=br`,
        headers
      )
    );

    // Busca por proximidade (apenas se temos coordenadas)
    if (lat !== null && lng !== null) {
      queries.push(
        this.fetchPlaces(
          `https://${RAPIDAPI_HOST}/nearby.php?query=${encodeURIComponent(nicho)}&lat=${lat}&lng=${lng}&lang=pt&country=br`,
          headers
        )
      );
    }

    const results = await Promise.all(queries);
    const allPlaces = results.flat();

    // ---------- Step 3: Deduplicação ----------
    const seen = new Set<string>();
    const places: NearbyPlace[] = [];
    for (const p of allPlaces) {
      const key = (p.place_id || `${(p.name || '').toLowerCase().trim()}|${p.phone_number || ''}`).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      places.push(p);
    }

    console.log(
      `[prospecting] nicho="${nicho}" loc="${localizacao}" ` +
      `geo=${lat !== null ? 'ok' : 'no'} raw=${allPlaces.length} dedup=${places.length}`
    );

    // Only count usage when leads are effectively returned to the user.
    // If no leads were returned, do NOT consume the user's monthly quota.
    const hasLeads = places.length > 0;
    if (hasLeads) {
      await prisma.apiUsageLog.create({
        data: { accountId, endpoint: 'maps-data', requestsCount: 2, month: currentMonth },
      });
    }

    const leads = places.map((p) => ({
      nome: p.name || '',
      cidade: p.city || '',
      endereco: p.full_address || '',
      telefone: p.phone_number || '',
      site: p.website || '',
      avaliacao: p.rating || null,
      total_avaliacoes: p.reviews ?? p.review_count ?? null,
      foto: p.photo || '',
      status_negocio: p.business_status || '',
      place_id: p.place_id || '',
      google_maps_url: p.google_maps_url || p.place_link || '',
    }));

    // Report usage in "extractions" (1 extraction = 2 raw requests)
    return {
      leads,
      usage: {
        used: Math.floor((totalUsed + (hasLeads ? 2 : 0)) / 2),
        limit,
      },
    };
  }

  /**
   * Helper: chama um endpoint da Maps Data e retorna o array `data` (ou []).
   * Erros são logados mas não propagam — assim uma fonte falhar não invalida a outra.
   */
  private async fetchPlaces(url: string, headers: Record<string, string>): Promise<NearbyPlace[]> {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`[prospecting] fetch ${res.status} from ${url.split('?')[0]}`);
        return [];
      }
      const json = (await res.json()) as NearbyResponse;
      return json.data || [];
    } catch (e) {
      console.warn('[prospecting] fetchPlaces error:', (e as Error).message);
      return [];
    }
  }

  /**
   * Get total API usage for the current month (all accounts)
   */
  async getTotalApiUsage() {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const logs = await prisma.apiUsageLog.findMany({
      where: { month: currentMonth },
      select: { requestsCount: true },
    });
    return {
      totalRequests: logs.reduce((sum, r) => sum + r.requestsCount, 0),
      month: currentMonth,
    };
  }
}

export const prospectingService = new ProspectingService();
