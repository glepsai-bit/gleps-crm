import { prisma } from '../config/database';
import { env } from '../config/env';

const RAPIDAPI_HOST = 'maps-data.p.rapidapi.com';

// Fallback hardcoded para produção (VPS/EasyPanel pode injetar env vazias).
// Mantido alinhado ao padrão de "production-config-hardening".
const RAPIDAPI_KEY_FALLBACK = '135d71789fmsh285761fddf395b1p1eb3e3jsn35a4433e1377';

function getRapidApiKey(): string {
  return (env.RAPIDAPI_KEY || process.env.RAPIDAPI_KEY || RAPIDAPI_KEY_FALLBACK || '').trim();
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

interface Contact {
  nome: string;
  telefone: string;
}

interface InboxAssignment {
  inbox_id: number;
  inbox_name: string;
  contacts: Contact[];
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
    const rapidApiKey = getRapidApiKey();
    if (!rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');

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
   * List Chatwoot inboxes for an account
   */
  async listInboxes(accountId: string) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { chatwootBaseUrl: true, chatwootAccountId: true, chatwootApiKey: true },
    });
    if (!account?.chatwootBaseUrl || !account?.chatwootAccountId || !account?.chatwootApiKey) {
      throw new Error('Chatwoot not configured');
    }

    const baseUrl = account.chatwootBaseUrl.replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/v1/accounts/${account.chatwootAccountId}/inboxes`, {
      headers: { 'api_access_token': account.chatwootApiKey },
    });
    if (!res.ok) throw new Error('Failed to fetch inboxes');
    const data = (await res.json()) as any;
    return (data.payload || []).map((i: any) => ({
      id: i.id,
      name: i.name,
      channel_type: i.channel_type,
      phone_number: i.phone_number || null,
    }));
  }

  /**
   * Dispatch messages via Chatwoot
   */
  async dispatch(
    accountId: string,
    inboxAssignments: InboxAssignment[],
    messages: string[],
    delaySeconds: number,
    keyword?: string,
    location?: string
  ) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { chatwootBaseUrl: true, chatwootAccountId: true, chatwootApiKey: true },
    });
    if (!account?.chatwootBaseUrl || !account?.chatwootAccountId || !account?.chatwootApiKey) {
      throw new Error('Chatwoot not configured');
    }

    const config = {
      baseUrl: account.chatwootBaseUrl.replace(/\/$/, ''),
      accountId: account.chatwootAccountId,
      apiKey: account.chatwootApiKey,
    };

    const totalContacts = inboxAssignments.reduce((sum, a) => sum + a.contacts.length, 0);
    const delayMs = Math.max((delaySeconds || 30) * 1000, 5000);

    // Create batch
    const batch = await prisma.dispatchBatch.create({
      data: {
        accountId,
        keyword: keyword || null,
        location: location || null,
        totalContacts: totalContacts,
        status: 'running',
        delaySeconds: delaySeconds || 30,
      },
    });

    // Create log entries
    const logEntries = inboxAssignments.flatMap(assignment =>
      assignment.contacts.map(c => ({
        batchId: batch.id,
        contactName: c.nome,
        phone: c.telefone,
        inboxId: assignment.inbox_id,
        inboxName: assignment.inbox_name,
        status: 'pending',
      }))
    );
    await prisma.dispatchLog.createMany({ data: logEntries });

    // Process in background (non-blocking)
    this.processDispatch(batch.id, config, inboxAssignments, messages, delayMs).catch(err => {
      console.error('[dispatch] Background error:', err);
      prisma.dispatchBatch.update({
        where: { id: batch.id },
        data: { status: 'failed', completedAt: new Date() },
      }).catch(() => {});
    });

    return { batch_id: batch.id, total: totalContacts };
  }

  private async processDispatch(
    batchId: string,
    config: { baseUrl: string; accountId: string; apiKey: string },
    inboxAssignments: InboxAssignment[],
    messages: string[],
    delayMs: number
  ) {
    // Build round-robin task list
    const allTasks: Array<{ contact: Contact; inboxId: number; inboxName: string }> = [];
    const maxLen = Math.max(...inboxAssignments.map(a => a.contacts.length));
    for (let i = 0; i < maxLen; i++) {
      for (const assignment of inboxAssignments) {
        if (i < assignment.contacts.length) {
          allTasks.push({ contact: assignment.contacts[i], inboxId: assignment.inbox_id, inboxName: assignment.inbox_name });
        }
      }
    }

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < allTasks.length; i++) {
      // Check cancellation
      const batchCheck = await prisma.dispatchBatch.findUnique({ where: { id: batchId }, select: { status: true } });
      if (batchCheck?.status === 'cancelled') return;

      const task = allTasks[i];
      try {
        const msgTemplate = messages[Math.floor(Math.random() * messages.length)];
        const message = msgTemplate.replace(/\{nome\}/gi, task.contact.nome);
        const { conversationId } = await this.createContactAndConversation(config, task.contact, task.inboxId);
        await this.sendMessage(config, conversationId, message);

        sentCount++;
        await prisma.dispatchLog.updateMany({
          where: { batchId, phone: task.contact.telefone, inboxId: task.inboxId },
          data: { status: 'sent', sentAt: new Date() },
        });
      } catch (err: any) {
        failedCount++;
        await prisma.dispatchLog.updateMany({
          where: { batchId, phone: task.contact.telefone, inboxId: task.inboxId },
          data: { status: 'failed', errorMessage: err.message, sentAt: new Date() },
        });
      }

      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { sentCount, failedCount },
      });

      if (i < allTasks.length - 1) await this.sleep(delayMs);
    }

    const finalCheck = await prisma.dispatchBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (finalCheck?.status !== 'cancelled') {
      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: {
          status: failedCount === allTasks.length ? 'failed' : 'completed',
          sentCount,
          failedCount,
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Cancel a running batch
   */
  async cancelBatch(accountId: string, batchId: string) {
    await prisma.dispatchBatch.updateMany({
      where: { id: batchId, accountId, status: 'running' },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    await prisma.dispatchLog.updateMany({
      where: { batchId, status: 'pending' },
      data: { status: 'cancelled', errorMessage: 'Cancelado pelo usuário' },
    });
  }

  /**
   * Resume a cancelled batch
   */
  async resumeBatch(accountId: string, batchId: string, messages: string[], delaySeconds?: number) {
    const batch = await prisma.dispatchBatch.findFirst({
      where: { id: batchId, accountId, status: 'cancelled' },
    });
    if (!batch) throw Object.assign(new Error('Batch not found or not cancelled'), { statusCode: 400 });

    const pendingLogs = await prisma.dispatchLog.findMany({
      where: { batchId, status: 'cancelled' },
      orderBy: { createdAt: 'asc' },
    });
    if (!pendingLogs.length) throw Object.assign(new Error('No cancelled contacts to resume'), { statusCode: 400 });

    await prisma.dispatchBatch.update({
      where: { id: batchId },
      data: { status: 'running', completedAt: null },
    });
    await prisma.dispatchLog.updateMany({
      where: { batchId, status: 'cancelled' },
      data: { status: 'pending', errorMessage: null },
    });

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { chatwootBaseUrl: true, chatwootAccountId: true, chatwootApiKey: true },
    });
    if (!account?.chatwootBaseUrl || !account?.chatwootAccountId || !account?.chatwootApiKey) {
      throw new Error('Chatwoot not configured');
    }

    const config = {
      baseUrl: account.chatwootBaseUrl.replace(/\/$/, ''),
      accountId: account.chatwootAccountId,
      apiKey: account.chatwootApiKey,
    };

    const delayMs = Math.max((delaySeconds || batch.delaySeconds || 30) * 1000, 5000);

    // Process in background
    this.processResume(batchId, config, pendingLogs, messages, delayMs, batch.sentCount, batch.failedCount, batch.totalContacts).catch(err => {
      console.error('[dispatch-resume] Error:', err);
      prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { status: 'failed', completedAt: new Date() },
      }).catch(() => {});
    });

    return { remaining: pendingLogs.length };
  }

  private async processResume(
    batchId: string,
    config: { baseUrl: string; accountId: string; apiKey: string },
    pendingLogs: any[],
    messages: string[],
    delayMs: number,
    initialSent: number,
    initialFailed: number,
    totalContacts: number
  ) {
    let sentCount = initialSent;
    let failedCount = initialFailed;

    for (let i = 0; i < pendingLogs.length; i++) {
      const batchCheck = await prisma.dispatchBatch.findUnique({ where: { id: batchId }, select: { status: true } });
      if (batchCheck?.status === 'cancelled') return;

      const log = pendingLogs[i];
      try {
        const msgTemplate = messages[Math.floor(Math.random() * messages.length)];
        const message = msgTemplate.replace(/\{nome\}/gi, log.contactName);
        const contact: Contact = { nome: log.contactName, telefone: log.phone };
        const { conversationId } = await this.createContactAndConversation(config, contact, log.inboxId);
        await this.sendMessage(config, conversationId, message);

        sentCount++;
        await prisma.dispatchLog.update({
          where: { id: log.id },
          data: { status: 'sent', sentAt: new Date(), errorMessage: null },
        });
      } catch (err: any) {
        failedCount++;
        await prisma.dispatchLog.update({
          where: { id: log.id },
          data: { status: 'failed', errorMessage: err.message, sentAt: new Date() },
        });
      }

      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { sentCount, failedCount },
      });

      if (i < pendingLogs.length - 1) await this.sleep(delayMs);
    }

    const finalCheck = await prisma.dispatchBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (finalCheck?.status !== 'cancelled') {
      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: {
          status: failedCount === totalContacts ? 'failed' : 'completed',
          sentCount,
          failedCount,
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Get batches for an account
   */
  async getBatches(accountId: string) {
    return prisma.dispatchBatch.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /**
   * Get logs for a batch
   */
  async getBatchLogs(batchId: string) {
    return prisma.dispatchLog.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
    });
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

  // --- Chatwoot helpers ---

  private async createContactAndConversation(
    config: { baseUrl: string; accountId: string; apiKey: string },
    contact: Contact,
    inboxId: number
  ) {
    const base = `${config.baseUrl}/api/v1/accounts/${config.accountId}`;
    const headers = { 'Content-Type': 'application/json', 'api_access_token': config.apiKey };

    let phone = contact.telefone.replace(/[\s\-\(\)]/g, '');
    if (!phone.startsWith('+')) phone = '+' + phone;

    const contactRes = await fetch(`${base}/contacts`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: contact.nome, phone_number: phone }),
    });

    let contactId: number;
    if (contactRes.ok) {
      const cData = (await contactRes.json()) as any;
      contactId = cData.payload?.contact?.id || cData.payload?.id || cData.id;
    } else {
      const searchRes = await fetch(
        `${base}/contacts/search?q=${encodeURIComponent(phone)}&include_contacts=true`,
        { headers: { 'api_access_token': config.apiKey } }
      );
      if (!searchRes.ok) throw new Error(`Cannot create or find contact: ${contact.nome}`);
      const searchData = (await searchRes.json()) as any;
      const found = (searchData.payload || []).find((c: any) =>
        c.phone_number?.replace(/\D/g, '') === phone.replace(/\D/g, '')
      );
      if (!found) throw new Error(`Contact creation failed and not found: ${contact.nome}`);
      contactId = found.id;
    }

    const convRes = await fetch(`${base}/conversations`, {
      method: 'POST', headers,
      body: JSON.stringify({ contact_id: contactId, inbox_id: inboxId, status: 'open' }),
    });

    let conversationId: number;
    if (convRes.ok) {
      const convData = (await convRes.json()) as any;
      conversationId = convData.id;
    } else {
      const convSearchRes = await fetch(`${base}/contacts/${contactId}/conversations`, {
        headers: { 'api_access_token': config.apiKey },
      });
      if (!convSearchRes.ok) throw new Error('Cannot create or find conversation');
      const convSearchData = (await convSearchRes.json()) as any;
      const existing = (convSearchData.payload || []).find((c: any) => c.inbox_id === inboxId);
      if (!existing) throw new Error('Conversation creation failed');
      conversationId = existing.id;
    }

    return { contactId, conversationId };
  }

  private async sendMessage(
    config: { baseUrl: string; accountId: string; apiKey: string },
    conversationId: number,
    message: string
  ) {
    const res = await fetch(
      `${config.baseUrl}/api/v1/accounts/${config.accountId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api_access_token': config.apiKey },
        body: JSON.stringify({ content: message, message_type: 'outgoing', private: false }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to send message: ${err}`);
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const prospectingService = new ProspectingService();
