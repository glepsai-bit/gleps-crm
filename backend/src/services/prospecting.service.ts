import { prisma } from '../config/database';
import { env } from '../config/env';
import { evolutionService } from './evolution.service';
import { systemSettingsService } from './system-settings.service';
import { whatsappConsentService } from './whatsapp-consent.service';
import { whatsappRateLimitService } from './whatsapp-rate-limit.service';
import { conversationService } from './conversation.service';
import { messageService } from './message.service';
import { AppError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

interface EvolutionDispatchConfig {
  transport: 'evolution';
  accountId: string;
  /**
   * T-022 — Mapa inbox_id (string|number) -> Inbox.evolutionInstance.
   * Preenchido em dispatch() carregando os Inboxes do DB. Permite que
   * sendViaTransport passe `instance` per-Inbox para evolutionService,
   * em vez de cair no fallback Account.evolutionInstance.
   */
  inboxInstanceMap: Map<string, string>;
}

type DispatchConfig = EvolutionDispatchConfig;

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
   *
   * FitPark — somente Evolution. Modelo atual:
   *  - Credenciais (baseUrl + apiKey): override per-account ACEITA STANDALONE,
   *    com fallback para singleton global em SystemSettings se ausente.
   *  - Instância: per-Inbox (passada via inboxInstanceMap em sendViaTransport).
   *
   * Bug fix 2026-06-30: anteriormente o erro era 503 e a mensagem só apontava
   * para a configuração global, mesmo com per-account override completo sendo
   * suficiente. Agora:
   *   1) per-account override (baseUrl + apiKey) é aceito standalone;
   *   2) só faz fallback para global se o override estiver ausente/incompleto;
   *   3) erro final passa a ser 422 (cliente precisa configurar) e a mensagem
   *      lista AMBOS os caminhos válidos (per-account OU global) + o que falta.
   *
   * @param inboxInstanceMap - map de inbox_id -> Inbox.evolutionInstance (validado
   *   em dispatch()). Não usado aqui, apenas anexado ao DispatchConfig.
   */
  /**
   * Best-effort persistence do dispatchLog. Quando o transporte real (Evolution)
   * já entregou a mensagem e persistOutboundConversation já criou a Conversation,
   * um erro transiente no update do log NAO deve regredir o contador do batch
   * — a mensagem foi entregue de verdade. Log fica em 'pending' e um alerta
   * é registrado para reconciliação posterior.
   */
  private async persistLogBestEffort(
    batchId: string,
    logId: string,
    data: {
      status: string;
      sentAt?: Date;
      errorMessage?: string | null;
    }
  ): Promise<void> {
    try {
      await prisma.dispatchLog.update({ where: { id: logId }, data });
    } catch (err: any) {
      logger.error('[dispatch] Falha ao persistir DispatchLog — batch contador correto, log fica pending pra reconciliacao', {
        batchId,
        logId,
        targetStatus: data.status,
        error: err?.message ?? String(err),
      });
    }
  }

  private async resolveDispatchConfig(
    accountId: string,
    inboxInstanceMap: Map<string, string>
  ): Promise<DispatchConfig> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        evolutionBaseUrl: true,
        evolutionApiKey: true,
      },
    });

    // 1) Override per-account (enterprise) — aceito standalone.
    const hasAccountOverride = Boolean(account?.evolutionBaseUrl && account?.evolutionApiKey);
    if (hasAccountOverride) {
      return { transport: 'evolution', accountId, inboxInstanceMap };
    }

    // 2) Fallback para singleton global de SystemSettings.
    const globalConfig = await systemSettingsService.getEvolutionConfig();
    if (globalConfig) {
      return { transport: 'evolution', accountId, inboxInstanceMap };
    }

    // 3) Nem per-account NEM global configurados — erro amigável 422 (não 500/503)
    //    listando o que falta + os dois caminhos válidos pra resolver.
    const missing: string[] = [];
    if (!account?.evolutionBaseUrl) missing.push('URL base do Evolution');
    if (!account?.evolutionApiKey) missing.push('API Key do Evolution');
    const missingLabel = missing.length > 0 ? ` (faltando: ${missing.join(', ')})` : '';

    throw new AppError(
      `Evolution não configurado${missingLabel}. ` +
        'Configure em Configurações da Conta (URL + API Key) para uso enterprise per-account, ' +
        'OU peça ao super-admin para configurar globalmente em /super-admin/system-settings. ' +
        'A Instância (evolutionInstance) é definida por Inbox, não aqui.',
      422,
      'EVOLUTION_NOT_CONFIGURED',
      { missing }
    );
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

    // T-022 — Carrega Inboxes do DB e valida que: existem, são da conta,
    // estão ativos, e têm evolutionInstance configurado. Anteriormente o
    // dispatch ignorava completamente os Inboxes do payload e caía em
    // Account.evolutionInstance (legacy), causando 500 em prod quando
    // a conta não tinha esse override mesmo com a Inbox conectada.
    const inboxIdStrings = Array.from(
      new Set(inboxAssignments.map(a => String(a.inbox_id)))
    );
    // Apenas IDs no formato UUID podem ser buscados em prisma.inbox (Inbox.id
    // é UUID). IDs numéricos (path legacy) ficam fora do lookup — esses
    // dispatches caem no fallback Account.evolutionInstance via evolutionService.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuidIds = inboxIdStrings.filter(id => uuidRegex.test(id));

    const inboxInstanceMap = new Map<string, string>();
    if (uuidIds.length > 0) {
      const dbInboxes = await prisma.inbox.findMany({
        where: { accountId, id: { in: uuidIds } },
        select: { id: true, name: true, evolutionInstance: true, active: true },
      });

      const foundIds = new Set(dbInboxes.map(i => i.id));
      const missing = uuidIds.filter(id => !foundIds.has(id));
      if (missing.length > 0) {
        const missingNames = inboxAssignments
          .filter(a => missing.includes(String(a.inbox_id)))
          .map(a => a.inbox_name);
        throw new AppError(
          `Inbox(es) não encontrada(s): ${missingNames.join(', ')}. Recarregue a página e tente novamente.`,
          404,
          'INBOX_NOT_FOUND'
        );
      }

      const inactive = dbInboxes.filter(i => !i.active);
      if (inactive.length > 0) {
        throw new AppError(
          `Inbox(es) inativa(s): ${inactive.map(i => i.name).join(', ')}. Reative em Configurações > Inboxes.`,
          422,
          'INBOX_INACTIVE'
        );
      }

      const noInstance = dbInboxes.filter(i => !i.evolutionInstance);
      if (noInstance.length > 0) {
        throw new AppError(
          `Inbox(es) sem WhatsApp conectado: ${noInstance.map(i => i.name).join(', ')}. Conecte primeiro em Configurações > Inboxes.`,
          422,
          'INBOX_NOT_CONNECTED'
        );
      }

      // Bug C — Guard de connection state ao vivo. O flag `active` do banco
      // não reflete se a sessão WhatsApp está pareada agora; um chip pode
      // estar `active=true` mas com `connectionState='close'` (aparelho
      // desligado, QR expirado). Sem essa checagem o loop de dispatch chama
      // evolutionService.sendText contra uma instância morta, gastando slot
      // de rate limit e retornando "sucesso" fake em algumas versões.
      //
      // Consulta o Evolution APENAS para os inboxes deste batch (paralelo),
      // com timeout embutido em evolutionService.getStatus. Falha individual
      // (Evolution offline / instância removida) vira 'unknown' e bloqueia.
      const healthChecks = await Promise.all(
        dbInboxes.map(async (inbox) => {
          try {
            const status = await evolutionService.getStatus(accountId, inbox.evolutionInstance!);
            return { inbox, state: status.state };
          } catch {
            return { inbox, state: 'unknown' as const };
          }
        })
      );
      const unhealthy = healthChecks.filter(x => x.state !== 'open');
      if (unhealthy.length > 0) {
        const detail = unhealthy.map(x => `${x.inbox.name} (${x.state})`).join(', ');
        throw new AppError(
          `Inbox(es) desconectada(s): ${detail}. Reconecte em Configurações > Inboxes antes de disparar.`,
          422,
          'INBOX_DISCONNECTED',
          { unhealthy: unhealthy.map(x => ({ id: x.inbox.id, name: x.inbox.name, state: x.state })) }
        );
      }

      for (const inbox of dbInboxes) {
        inboxInstanceMap.set(inbox.id, inbox.evolutionInstance!);
      }
    }

    const config = await this.resolveDispatchConfig(accountId, inboxInstanceMap);

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
          // Contador reflete decisão real (msg bloqueada). Log é best-effort:
          // se persist falhar, batch continua consistente com a ação tomada.
          failedCount++;
          await this.persistLogBestEffort(batchId, task.logId, {
            status: 'blocked_optout',
            errorMessage: 'Contato com opt-out',
            sentAt: new Date(),
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
          await this.persistLogBestEffort(batchId, task.logId, {
            status: 'rate_limited',
            errorMessage: rl.reason ?? 'rate_limited',
            sentAt: new Date(),
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

        // sendViaTransport ja persistiu Conversation+Message. Contador sobe
        // agora refletindo a mensagem REAL entregue. dispatchLog eh best-effort:
        // se persist falha, alerta em log mas nao regride envio ja realizado.
        sentCount++;
        await this.persistLogBestEffort(batchId, task.logId, {
          status: 'sent',
          sentAt: new Date(),
        });
      } catch (err: any) {
        failedCount++;
        await this.persistLogBestEffort(batchId, task.logId, {
          status: 'failed',
          errorMessage: err.message,
          sentAt: new Date(),
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

    // Reconstroi o inboxInstanceMap a partir dos inboxNames dos logs pendentes.
    // DispatchLog.inboxId é Int? — UUIDs do CRM gravam null, então o lookup
    // precisa ser feito por nome (único por conta em prisma.inbox).
    const pendingInboxNames = Array.from(
      new Set(pendingLogs.map((l: any) => l.inboxName).filter(Boolean) as string[])
    );
    const inboxInstanceMap = new Map<string, string>();
    if (pendingInboxNames.length > 0) {
      const dbInboxes = await prisma.inbox.findMany({
        where: { accountId, name: { in: pendingInboxNames } },
        select: { id: true, name: true, evolutionInstance: true },
      });
      for (const inbox of dbInboxes) {
        if (inbox.evolutionInstance) {
          // Indexa por id E por name — processResume identifica o canal pelo
          // inboxName (já que log.inboxId é null para UUIDs).
          inboxInstanceMap.set(inbox.id, inbox.evolutionInstance);
          inboxInstanceMap.set(inbox.name, inbox.evolutionInstance);
        }
      }
    }

    const config = await this.resolveDispatchConfig(accountId, inboxInstanceMap);

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
          await this.persistLogBestEffort(batchId, log.id, {
            status: 'blocked_optout',
            errorMessage: 'Contato com opt-out',
            sentAt: new Date(),
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
          await this.persistLogBestEffort(batchId, log.id, {
            status: 'rate_limited',
            errorMessage: rl.reason ?? 'rate_limited',
            sentAt: new Date(),
          });
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { sentCount, failedCount },
          });
          if (i < pendingLogs.length - 1) await this.sleep(delayMs);
          continue;
        }

        // log.inboxId é null para UUIDs (schema legado). O inboxInstanceMap é
        // indexado por inbox.name também (ver resumeBatch acima), então passar
        // log.inboxName resolve a instance per-Inbox no sendViaTransport.
        await this.sendViaTransport(config, contact, log.inboxName ?? log.inboxId ?? '', message);
        whatsappRateLimitService.record(config.accountId, normalized);

        sentCount++;
        await this.persistLogBestEffort(batchId, log.id, {
          status: 'sent',
          sentAt: new Date(),
          errorMessage: null,
        });
      } catch (err: any) {
        failedCount++;
        await this.persistLogBestEffort(batchId, log.id, {
          status: 'failed',
          errorMessage: err.message,
          sentAt: new Date(),
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
   * Get batches for an account com filtros opcionais.
   *
   * filters:
   *   - q: busca livre (ILIKE) em keyword, trigger_name, metadata->>campaign_type
   *   - source: string ou array (manual|manual_scheduled|n8n|api|integration)
   *   - status: string ou array (running|scheduled|paused|completed|failed|cancelled)
   *   - campaignType: string ou array — match exato em metadata->>'campaign_type'
   *   - fromDate / toDate: range em createdAt
   *   - limit / offset: paginação (limit default 20, max 200)
   */
  async getBatches(
    accountId: string,
    filters: {
      q?: string;
      source?: string | string[];
      status?: string | string[];
      campaignType?: string | string[];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    } = {}
  ) {
    const where: any = { accountId };

    if (filters.status !== undefined) {
      where.status = Array.isArray(filters.status)
        ? { in: filters.status }
        : filters.status;
    }
    if (filters.source !== undefined) {
      where.source = Array.isArray(filters.source)
        ? { in: filters.source }
        : filters.source;
    }
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = filters.fromDate;
      if (filters.toDate) where.createdAt.lte = filters.toDate;
    }

    // campaignType: filtra via metadata->>'campaign_type' usando JSON path Prisma.
    if (filters.campaignType !== undefined) {
      const values = Array.isArray(filters.campaignType)
        ? filters.campaignType
        : [filters.campaignType];
      // OR de path equals (Prisma JsonFilter aceita string_contains/equals).
      where.AND = where.AND ?? [];
      where.AND.push({
        OR: values.map(v => ({
          metadata: {
            path: ['campaign_type'],
            equals: v,
          },
        })),
      });
    }

    // q: busca livre em keyword OU triggerName OU metadata->>campaign_type.
    // Prisma ILIKE via mode:'insensitive'. ESCAPE de % e _ via replace.
    if (filters.q && filters.q.trim()) {
      const raw = filters.q.trim();
      // ESCAPE: no Prisma `contains` o backend é LIKE; escapar % e _ para
      // evitar wildcard injection no input do usuário.
      const escaped = raw.replace(/[\\%_]/g, ch => `\\${ch}`);
      where.AND = where.AND ?? [];
      where.AND.push({
        OR: [
          { keyword: { contains: escaped, mode: 'insensitive' } },
          { triggerName: { contains: escaped, mode: 'insensitive' } },
          {
            metadata: {
              path: ['campaign_type'],
              string_contains: escaped,
            },
          },
        ],
      });
    }

    const take = Math.min(Math.max(filters.limit ?? 20, 1), 200);
    const skip = Math.max(filters.offset ?? 0, 0);

    return prisma.dispatchBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }

  /**
   * T-022 — Aggregação de batches por chave (campaign_type | source | trigger_name).
   * Usa $queryRaw para extrair JSON path do metadata.
   *
   * Retorna por grupo:
   *   { key, batchesCount, totalSent, totalFailed, avgSentPerBatch }
   *
   * MVP sem index — em produção, considerar index parcial em
   * (account_id, (metadata->>'campaign_type')).
   */
  async aggregateBatches(
    accountId: string,
    options: {
      fromDate?: Date;
      toDate?: Date;
      groupBy?: 'campaign_type' | 'source' | 'trigger_name';
    } = {}
  ): Promise<
    Array<{
      key: string | null;
      campaignType?: string | null;
      source?: string | null;
      triggerName?: string | null;
      batchesCount: number;
      totalSent: number;
      totalFailed: number;
      avgSentPerBatch: number;
    }>
  > {
    const groupBy = options.groupBy ?? 'campaign_type';

    // Whitelist de groupBy (evita SQL injection — valor vai pro raw query).
    const groupSqlMap: Record<string, string> = {
      campaign_type: "metadata->>'campaign_type'",
      source: 'source',
      trigger_name: 'trigger_name',
    };
    const groupExpr = groupSqlMap[groupBy];
    if (!groupExpr) {
      throw new ValidationError(`groupBy inválido: ${groupBy}`);
    }

    const fromDate = options.fromDate ?? new Date('1970-01-01');
    const toDate = options.toDate ?? new Date('2999-12-31');

    // $queryRawUnsafe pra interpolar o groupExpr (whitelisted acima).
    // Bindings parametrizados pro accountId/datas.
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        k: string | null;
        batches_count: bigint;
        total_sent: bigint;
        total_failed: bigint;
      }>
    >(
      `
      SELECT
        ${groupExpr} AS k,
        COUNT(*)::bigint AS batches_count,
        COALESCE(SUM(sent_count), 0)::bigint AS total_sent,
        COALESCE(SUM(failed_count), 0)::bigint AS total_failed
      FROM dispatch_batches
      WHERE account_id = $1::uuid
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY 1
      ORDER BY batches_count DESC NULLS LAST
      `,
      accountId,
      fromDate,
      toDate
    );

    return rows.map(r => {
      const batchesCount = Number(r.batches_count);
      const totalSent = Number(r.total_sent);
      const totalFailed = Number(r.total_failed);
      const avg = batchesCount > 0 ? totalSent / batchesCount : 0;
      const base = {
        key: r.k,
        batchesCount,
        totalSent,
        totalFailed,
        avgSentPerBatch: Math.round(avg * 100) / 100,
      };
      if (groupBy === 'campaign_type') return { ...base, campaignType: r.k };
      if (groupBy === 'source') return { ...base, source: r.k };
      return { ...base, triggerName: r.k };
    });
  }

  /**
   * T-022 — Lista distinta de campaign_types vistos em batches da conta.
   * Usado pra popular dropdown de filtro no Historico de Disparos.
   */
  async getCampaignTypes(accountId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ k: string }>>`
      SELECT DISTINCT metadata->>'campaign_type' AS k
      FROM dispatch_batches
      WHERE account_id = ${accountId}::uuid
        AND metadata->>'campaign_type' IS NOT NULL
      ORDER BY k ASC
    `;
    return rows.map(r => r.k).filter(Boolean);
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
   *
   * T-022 — Quando inboxId mapeia para um Inbox.evolutionInstance no
   * `config.inboxInstanceMap`, passa esse instance per-Inbox para a
   * Evolution. Caso contrário (path legacy / inboxId numérico), cai no
   * fallback Account.evolutionInstance dentro do evolutionService.
   */
  private async sendViaTransport(
    config: DispatchConfig,
    contact: Contact,
    inboxId: string | number,
    message: string
  ) {
    const instance = config.inboxInstanceMap.get(String(inboxId)) ?? null;

    // BUG-CHAT-001 + BUG-DISPATCH-CHAT-002 — Persiste Conversation + Message
    // no CRM SEMPRE, INDEPENDENTE de sendText succeed/fail:
    //  - sendText OK => Message status='sent'
    //  - sendText FALHA (Evolution 400/timeout/desconectado) => Message
    //    status='failed', com metadata.error pra usuario ver e re-enfileirar
    //
    // Antes: sendText lancava -> try/catch NAO cobria porque estava so em
    // volta de persistOutboundConversation -> exception se propagava e
    // conversa NUNCA era criada. Bug reportado pelo user 2026-07-01:
    // "dispatch retorna 200 mas conversa nao aparece no chat quando
    // WhatsApp esta desconectado".
    let evolutionResult: Awaited<ReturnType<typeof evolutionService.sendText>> | null = null;
    let sendError: Error | null = null;
    try {
      evolutionResult = await evolutionService.sendText(config.accountId, {
        number: contact.telefone,
        text: message,
        instance,
      });
    } catch (err: any) {
      sendError = err instanceof Error ? err : new Error(String(err));
      logger.warn('[dispatch] evolutionService.sendText falhou — Message sera persistida como failed', {
        accountId: config.accountId,
        phone: contact.telefone,
        inboxKey: String(inboxId),
        error: sendError.message,
      });
    }

    // Persiste Conversation + Message SEMPRE. findOrCreateForCustomer eh
    // idempotente (accountId, inboxId, externalId) — dispatches subsequentes
    // reutilizam a mesma Conversation, e webhook inbound tambem casa.
    try {
      await this.persistOutboundConversation({
        accountId: config.accountId,
        contact,
        inboxKey: String(inboxId),
        content: message,
        evolutionMsgId: evolutionResult?.messageId,
        status: sendError ? 'failed' : 'sent',
        errorMessage: sendError?.message,
      });
    } catch (err: any) {
      logger.warn('[dispatch] persistOutboundConversation falhou (best-effort)', {
        accountId: config.accountId,
        phone: contact.telefone,
        inboxKey: String(inboxId),
        error: err?.message ?? String(err),
      });
    }

    // Re-lanca o erro do sendText pra processDispatch marcar o DispatchLog
    // como failed. A persistencia da Conversation ja foi feita acima.
    if (sendError) throw sendError;
  }

  /**
   * BUG-CHAT-001 — Persiste Conversation + Message no CRM para que dispatches
   * outbound-only apareçam no /admin/chat.
   *
   * Resolve inbox UUID a partir de: (a) inboxKey ja UUID; (b) inboxKey =
   * Inbox.name (path resume); (c) skip se nada bater.
   *
   * externalId eh construido no mesmo formato do webhook inbound
   * ('<phone>@s.whatsapp.net') para garantir que resposta do cliente reuse
   * a mesma Conversation via findOrCreateForCustomer.
   */
  private async persistOutboundConversation(args: {
    accountId: string;
    contact: Contact;
    inboxKey: string;
    content: string;
    evolutionMsgId?: string;
    /**
     * BUG-DISPATCH-CHAT-002: status da Message no CRM. 'sent' quando Evolution
     * aceitou; 'failed' quando Evolution retornou erro (400/timeout/etc).
     * Default 'sent' pra retrocompat.
     */
    status?: 'sent' | 'failed';
    errorMessage?: string;
  }): Promise<void> {
    const { accountId, contact, inboxKey, content, evolutionMsgId, status = 'sent', errorMessage } = args;

    if (!contact?.telefone) return;

    // Resolve o UUID do Inbox no CRM. inboxKey pode ser UUID direto ou nome.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let inbox: { id: string } | null = null;
    if (uuidRegex.test(inboxKey)) {
      inbox = await prisma.inbox.findFirst({
        where: { id: inboxKey, accountId },
        select: { id: true },
      });
    }
    if (!inbox && inboxKey) {
      inbox = await prisma.inbox.findFirst({
        where: { accountId, name: inboxKey },
        select: { id: true },
      });
    }
    if (!inbox) {
      // Fallback: pega primeiro Inbox ativo com Evolution — dispatch legacy
      // que usa inbox_id numerico cai aqui. Melhor persistir sob QUALQUER
      // inbox valido do que perder a conversa.
      inbox = await prisma.inbox.findFirst({
        where: { accountId, active: true, evolutionInstance: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
    }
    if (!inbox) {
      logger.debug('[dispatch] sem Inbox valida para persistir conversa outbound', {
        accountId,
        inboxKey,
      });
      return;
    }

    // Normaliza telefone pro mesmo formato usado no webhook Evolution
    // (so digitos, sem +/mask). remoteJid = '<digits>@s.whatsapp.net'.
    let normalizedPhone: string;
    try {
      normalizedPhone = whatsappConsentService.normalizePhone(contact.telefone);
    } catch {
      // Telefone invalido — dispatch ja saiu, mas nao da pra persistir sem phone valido.
      return;
    }
    const externalId = `${normalizedPhone}@s.whatsapp.net`;

    // Cria/reusa a conversa. findOrCreateForCustomer eh idempotente por
    // (accountId, inboxId, externalId) — proximo dispatch pro mesmo contato
    // no mesmo inbox reusa a Conversation. Se o cliente responder, o webhook
    // Evolution tambem casa aqui.
    const conversation = await conversationService.findOrCreateForCustomer(
      accountId,
      inbox.id,
      {
        externalId,
        contactPhone: normalizedPhone,
        contactName: contact.nome ?? null,
      }
    );

    // Persiste a Message outbound (senderType='agent'). O messageService.create
    // cuida do increment de contadores + first response cycle.
    // BUG-DISPATCH-CHAT-002: status refletindo sucesso/falha do envio Evolution.
    await messageService.create(accountId, {
      conversationId: conversation.id,
      senderType: 'agent',
      content,
      contentType: 'text',
      externalId: evolutionMsgId ?? null,
      status,
      metadata: {
        source: 'dispatch',
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    });
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const prospectingService = new ProspectingService();
