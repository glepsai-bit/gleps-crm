import { prisma } from '../config/database';
import { env } from '../config/env';
import { evolutionService } from './evolution.service';
import { whatsappConsentService } from './whatsapp-consent.service';
import { whatsappRateLimitService } from './whatsapp-rate-limit.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

interface EvolutionDispatchConfig {
  transport: 'evolution';
  accountId: string;
}

type DispatchConfig = EvolutionDispatchConfig;

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
  // T-022 — Inboxes do CRM (`prisma.inbox`) usam UUID string.
  // DispatchLog.inboxId continua Int? por compatibilidade do schema legado:
  // UUIDs são gravados como null (Evolution não consome inboxId no envio).
  inbox_id: string | number;
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
   * List inboxes para o account.
   * FitPark — REMOVED legacy external provider. Inboxes vêm do CRM (prisma.inbox).
   */
  async listInboxes(accountId: string) {
    const inboxes = await prisma.inbox.findMany({
      where: { accountId, active: true },
      select: { id: true, name: true, channelType: true },
      orderBy: { createdAt: 'asc' },
    });
    return inboxes.map((i) => ({
      id: i.id,
      name: i.name,
      channel_type: i.channelType,
      phone_number: null,
    }));
  }

  /**
   * Resolve dispatch transport para o account.
   * FitPark — somente Evolution. Se não configurada, exige setup global.
   */
  private async resolveDispatchConfig(accountId: string): Promise<DispatchConfig> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        evolutionBaseUrl: true,
        evolutionApiKey: true,
        evolutionInstance: true,
      },
    });

    if (account?.evolutionBaseUrl && account?.evolutionApiKey && account?.evolutionInstance) {
      return { transport: 'evolution', accountId };
    }

    throw new Error('Configure Evolution global em /super-admin/system-settings');
  }

  /**
   * Dispatch messages via Evolution (FitPark — REMOVED legacy external provider).
   */
  async dispatch(
    accountId: string,
    inboxAssignments: InboxAssignment[],
    messages: string[],
    delaySeconds: number,
    keyword?: string,
    location?: string
  ) {
    if (!messages || messages.length === 0) {
      throw new ValidationError('Pelo menos 1 mensagem é obrigatória');
    }

    const config = await this.resolveDispatchConfig(accountId);

    const totalContacts = inboxAssignments.reduce((sum, a) => sum + a.contacts.length, 0);
    const delayMs = Math.max((delaySeconds || 30) * 1000, 5000);

    // DISP-04 — Persistir metadata.recipients/content/source igual ao path
    // canonical (whatsappCampaignController.sendBatch). Permite reprocessamento
    // e facilita auditoria/debug de batches criados pelo legacy
    // /api/prospecting/dispatch.
    const recipientsMeta = inboxAssignments.flatMap(assignment =>
      assignment.contacts.map(c => ({
        contactId: null,
        phone: c.telefone,
        name: c.nome ?? null,
        variables: {},
        inboxId: assignment.inbox_id,
        inboxName: assignment.inbox_name,
      }))
    );

    const metadata = {
      recipients: recipientsMeta,
      content: messages.length === 1 ? messages[0] : null,
      messages,
      source: 'prospecting_legacy',
    };

    // Create batch
    const batch = await prisma.dispatchBatch.create({
      data: {
        accountId,
        keyword: keyword || null,
        location: location || null,
        totalContacts: totalContacts,
        status: 'running',
        delaySeconds: delaySeconds || 30,
        source: 'prospecting_legacy',
        metadata: metadata as any,
      },
    });

    // Create log entries — usar createManyAndReturn para obter IDs (necessário
    // para evitar updateMany por (batchId, phone, inboxId) que afeta múltiplas
    // linhas quando o mesmo telefone aparece duplicado no mesmo inbox).
    const logEntries = inboxAssignments.flatMap(assignment =>
      assignment.contacts.map(c => ({
        accountId,
        batchId: batch.id,
        contactName: c.nome,
        phone: c.telefone,
        // DispatchLog.inboxId é Int? (schema legado). Para UUIDs do CRM
        // (T-022), persistimos null — a identificação do canal fica no
        // inboxName e o envio Evolution não consome inboxId.
        inboxId: typeof assignment.inbox_id === 'number' ? assignment.inbox_id : null,
        inboxName: assignment.inbox_name,
        status: 'pending',
      }))
    );
    const createdLogs = await prisma.dispatchLog.createManyAndReturn({ data: logEntries });

    // Mapeia logId por (assignmentIdx, contactIdx) preservando a ordem do flatMap.
    const logIdsByAssignment: string[][] = [];
    let cursor = 0;
    for (const assignment of inboxAssignments) {
      const ids: string[] = [];
      for (let c = 0; c < assignment.contacts.length; c++) {
        ids.push(createdLogs[cursor++].id);
      }
      logIdsByAssignment.push(ids);
    }

    // Process in background (non-blocking)
    this.processDispatch(batch.id, config, inboxAssignments, logIdsByAssignment, messages, delayMs).catch(err => {
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
    config: DispatchConfig,
    inboxAssignments: InboxAssignment[],
    logIdsByAssignment: string[][],
    messages: string[],
    delayMs: number
  ) {
    // Build round-robin task list — cada task carrega o logId específico
    // para que os updates usem where:{id} (evita updateMany afetar duplicatas).
    const allTasks: Array<{ contact: Contact; inboxId: string | number; inboxName: string; logId: string }> = [];
    const maxLen = Math.max(...inboxAssignments.map(a => a.contacts.length));
    for (let i = 0; i < maxLen; i++) {
      for (let a = 0; a < inboxAssignments.length; a++) {
        const assignment = inboxAssignments[a];
        if (i < assignment.contacts.length) {
          allTasks.push({
            contact: assignment.contacts[i],
            inboxId: assignment.inbox_id,
            inboxName: assignment.inbox_name,
            logId: logIdsByAssignment[a][i],
          });
        }
      }
    }

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < allTasks.length; i++) {
      // Check cancellation / pause (T-022: aba Agendadas)
      const batchCheck = await prisma.dispatchBatch.findUnique({ where: { id: batchId }, select: { status: true } });
      if (batchCheck?.status === 'cancelled' || batchCheck?.status === 'paused') {
        // Persiste o sentCount/failedCount mais recente sem mexer em completedAt
        // quando 'paused' — assim o resume pode continuar de onde parou.
        await prisma.dispatchBatch.update({
          where: { id: batchId },
          data: { sentCount, failedCount },
        });
        return;
      }

      const task = allTasks[i];
      try {
        const msgTemplate = messages[Math.floor(Math.random() * messages.length)];
        const message = msgTemplate.replace(/\{nome\}/gi, task.contact.nome);

        // T-022 Compliance — opt-out + rate limit Evolution.
        const normalized = whatsappConsentService.normalizePhone(task.contact.telefone);

        const hasConsent = await whatsappConsentService.hasConsent(config.accountId, normalized);
        if (!hasConsent) {
          failedCount++;
          await prisma.dispatchLog.update({
            where: { id: task.logId },
            data: {
              status: 'blocked_optout',
              errorMessage: 'Contato com opt-out',
              sentAt: new Date(),
            },
          });
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { sentCount, failedCount },
          });
          if (i < allTasks.length - 1) await this.sleep(delayMs);
          continue;
        }

        const rl = await whatsappRateLimitService.check(config.accountId, normalized);
        if (!rl.allowed) {
          failedCount++;
          await prisma.dispatchLog.update({
            where: { id: task.logId },
            data: {
              status: 'rate_limited',
              errorMessage: rl.reason ?? 'rate_limited',
              sentAt: new Date(),
            },
          });
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { sentCount, failedCount },
          });
          if (i < allTasks.length - 1) await this.sleep(delayMs);
          continue;
        }

        await this.sendViaTransport(config, task.contact, task.inboxId, message);
        whatsappRateLimitService.record(config.accountId, normalized);

        sentCount++;
        await prisma.dispatchLog.update({
          where: { id: task.logId },
          data: { status: 'sent', sentAt: new Date() },
        });
      } catch (err: any) {
        failedCount++;
        await prisma.dispatchLog.update({
          where: { id: task.logId },
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
    if (finalCheck?.status !== 'cancelled' && finalCheck?.status !== 'paused') {
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
    const result = await prisma.dispatchBatch.updateMany({
      where: { id: batchId, accountId, status: 'running' },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    if (result.count === 0) {
      // Pode ser que já está cancelled/completed/failed, ou não existe
      const batch = await prisma.dispatchBatch.findFirst({
        where: { id: batchId, accountId },
        select: { status: true },
      });
      if (!batch) throw new NotFoundError('Disparo');
      throw new ValidationError(
        `Disparo não pode ser cancelado (status atual: ${batch.status})`
      );
    }

    await prisma.dispatchLog.updateMany({
      where: { batchId, status: 'pending' },
      data: { status: 'cancelled', errorMessage: 'Cancelado pelo usuário' },
    });

    return { cancelled: true };
  }

  /**
   * Resume a cancelled batch
   */
  async resumeBatch(accountId: string, batchId: string, messages: string[], delaySeconds?: number) {
    if (!messages || messages.length === 0) {
      throw new ValidationError('Pelo menos 1 mensagem é obrigatória');
    }

    const batch = await prisma.dispatchBatch.findFirst({
      where: { id: batchId, accountId },
    });
    if (!batch) throw new NotFoundError('Disparo');
    if (batch.status !== 'cancelled') {
      throw new ValidationError(
        `Disparo não pode ser retomado (status atual: ${batch.status})`
      );
    }

    const pendingLogs = await prisma.dispatchLog.findMany({
      where: { batchId, status: 'cancelled' },
      orderBy: { createdAt: 'asc' },
    });
    if (!pendingLogs.length) {
      throw new ValidationError('Nenhum contato cancelado para retomar');
    }

    await prisma.dispatchBatch.update({
      where: { id: batchId },
      data: { status: 'running', completedAt: null },
    });
    await prisma.dispatchLog.updateMany({
      where: { batchId, status: 'cancelled' },
      data: { status: 'pending', errorMessage: null },
    });

    const config = await this.resolveDispatchConfig(accountId);

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
    config: DispatchConfig,
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
      if (batchCheck?.status === 'cancelled' || batchCheck?.status === 'paused') {
        await prisma.dispatchBatch.update({
          where: { id: batchId },
          data: { sentCount, failedCount },
        });
        return;
      }

      const log = pendingLogs[i];
      try {
        const msgTemplate = messages[Math.floor(Math.random() * messages.length)];
        const message = msgTemplate.replace(/\{nome\}/gi, log.contactName);
        const contact: Contact = { nome: log.contactName, telefone: log.phone };

        // T-022 Compliance — opt-out + rate limit Evolution.
        const normalized = whatsappConsentService.normalizePhone(contact.telefone);

        const hasConsent = await whatsappConsentService.hasConsent(config.accountId, normalized);
        if (!hasConsent) {
          failedCount++;
          await prisma.dispatchLog.update({
            where: { id: log.id },
            data: {
              status: 'blocked_optout',
              errorMessage: 'Contato com opt-out',
              sentAt: new Date(),
            },
          });
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { sentCount, failedCount },
          });
          if (i < pendingLogs.length - 1) await this.sleep(delayMs);
          continue;
        }

        const rl = await whatsappRateLimitService.check(config.accountId, normalized);
        if (!rl.allowed) {
          failedCount++;
          await prisma.dispatchLog.update({
            where: { id: log.id },
            data: {
              status: 'rate_limited',
              errorMessage: rl.reason ?? 'rate_limited',
              sentAt: new Date(),
            },
          });
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { sentCount, failedCount },
          });
          if (i < pendingLogs.length - 1) await this.sleep(delayMs);
          continue;
        }

        await this.sendViaTransport(config, contact, log.inboxId ?? '', message);
        whatsappRateLimitService.record(config.accountId, normalized);

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
    if (finalCheck?.status !== 'cancelled' && finalCheck?.status !== 'paused') {
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
   * T-022 — Aba "Agendadas": lista batches que ainda nao terminaram.
   * Status nao-finais ativos (scheduled|paused|running). Excluimos cancelled/
   * completed/failed explicitamente pra evitar mostrar batch cancelado com
   * scheduledAt futuro (UX: row some assim que cancela).
   */
  async getScheduledBatches(accountId: string) {
    return prisma.dispatchBatch.findMany({
      where: {
        accountId,
        status: { in: ['scheduled', 'paused', 'running'] },
        OR: [
          { scheduledAt: { not: null } },
          { source: { in: ['manual_scheduled', 'n8n', 'api'] } },
        ],
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  /**
   * T-022 — Pausa um batch agendado/em execução.
   * - 'scheduled' -> 'paused' (cron de scheduling pula 'paused')
   * - 'running'   -> 'paused' (loop processBatch detecta e aborta sem completar)
   */
  async pauseBatch(accountId: string, batchId: string) {
    // BUG-QA1-002 — TOCTOU fix: update atomico com WHERE status esperado.
    // Evita race entre findFirst + update quando dois requests concorrentes
    // (ou cron + usuario) tentam mudar o status simultaneamente.
    const result = await prisma.dispatchBatch.updateMany({
      where: { id: batchId, accountId, status: { in: ['scheduled', 'running'] } },
      data: { status: 'paused' },
    });

    if (result.count === 0) {
      const batch = await prisma.dispatchBatch.findFirst({
        where: { id: batchId, accountId },
        select: { status: true },
      });
      if (!batch) throw new NotFoundError('Disparo');
      throw new ValidationError(
        `Apenas disparos agendados ou em execução podem ser pausados (status atual: ${batch.status})`
      );
    }

    return { id: batchId, status: 'paused' };
  }

  /**
   * T-022 — Retoma um batch pausado.
   * - Volta para 'scheduled' (se ainda tem scheduledAt no futuro → cron pega na próxima tick).
   * - Se scheduledAt já passou (ou é null) → volta direto para 'scheduled' com scheduledAt=now()
   *   para o cron processar imediatamente no próximo tick.
   */
  async resumeBatchFromPause(accountId: string, batchId: string) {
    // BUG-QA1-002 — TOCTOU fix: precisa ler scheduledAt p/ decidir se ajusta
    // para now(), mas o update final usa updateMany com WHERE status='paused'
    // pra evitar race entre check e write.
    const batch = await prisma.dispatchBatch.findFirst({
      where: { id: batchId, accountId },
      select: { id: true, status: true, scheduledAt: true },
    });
    if (!batch) throw new NotFoundError('Disparo');

    const now = new Date();
    const data: { status: string; scheduledAt?: Date } = { status: 'scheduled' };
    if (!batch.scheduledAt || batch.scheduledAt <= now) {
      data.scheduledAt = now;
    }

    const result = await prisma.dispatchBatch.updateMany({
      where: { id: batchId, accountId, status: 'paused' },
      data,
    });

    if (result.count === 0) {
      // Re-le pra dar erro com status atual (pode ter mudado entre o findFirst e o updateMany).
      const current = await prisma.dispatchBatch.findFirst({
        where: { id: batchId, accountId },
        select: { status: true },
      });
      if (!current) throw new NotFoundError('Disparo');
      throw new ValidationError(
        `Apenas disparos pausados podem ser retomados (status atual: ${current.status})`
      );
    }

    // BUG-QA1-005 — re-enfileira imediatamente sem esperar o cron de 5min.
    // Fire-and-forget; dynamic import evita risco de circular dep com
    // whatsapp-campaign.service (que historicamente importa varios services).
    void import('./whatsapp-campaign.service')
      .then(({ whatsappCampaignService }) =>
        whatsappCampaignService.processBatchInBackground(batchId)
      )
      .catch((err: any) =>
        logger.error('Erro retomando batch', err, { batchId })
      );

    return { id: batchId, status: 'scheduled' };
  }

  /**
   * T-022 — Cancela definitivamente (REST DELETE).
   * Aceita qualquer batch em estado não-final: 'scheduled' | 'paused' | 'running'.
   * Marca logs 'pending' como 'cancelled'.
   */
  async cancelScheduledBatch(accountId: string, batchId: string) {
    // BUG-QA1-002 — TOCTOU fix: update atomico com WHERE status nao-final.
    const result = await prisma.dispatchBatch.updateMany({
      where: {
        id: batchId,
        accountId,
        status: { in: ['scheduled', 'paused', 'running'] },
      },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    if (result.count === 0) {
      const batch = await prisma.dispatchBatch.findFirst({
        where: { id: batchId, accountId },
        select: { status: true },
      });
      if (!batch) throw new NotFoundError('Disparo');
      throw new ValidationError(
        `Não é possível cancelar um disparo já finalizado (status atual: ${batch.status})`
      );
    }

    await prisma.dispatchLog.updateMany({
      where: { batchId, status: 'pending' },
      data: { status: 'cancelled', errorMessage: 'Cancelado pelo usuário' },
    });

    return { id: batchId, status: 'cancelled' };
  }

  /**
   * Get logs for a batch (scoped por accountId para evitar cross-tenant leak)
   */
  async getBatchLogs(batchId: string, accountId: string) {
    const batch = await prisma.dispatchBatch.findUnique({
      where: { id: batchId },
      select: { accountId: true },
    });
    if (!batch || batch.accountId !== accountId) {
      throw Object.assign(new Error('Batch not found'), { statusCode: 404 });
    }
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

  // --- Unified transport dispatch ---

  /**
   * Envia uma mensagem para um contato via Evolution.
   * FitPark — REMOVED legacy external provider; inboxId é ignorado pelo Evolution.
   */
  private async sendViaTransport(
    config: DispatchConfig,
    contact: Contact,
    _inboxId: string | number,
    message: string
  ) {
    await evolutionService.sendText(config.accountId, {
      number: contact.telefone,
      text: message,
    });
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const prospectingService = new ProspectingService();
