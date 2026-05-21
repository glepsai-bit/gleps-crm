/**
 * CHATWOOT METRICS SERVICE
 * 
 * Port of the Edge Function logic to Express backend.
 * Fetches raw data from Chatwoot API (conversations, agents, inboxes)
 * and computes DashboardMetrics locally — never calls /reports/summary.
 * Also queries resolution_logs via Prisma for persistent resolution data.
 * 
 * v2: Resilient layered fetch, explicit error propagation, health metadata.
 */

import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

interface ChatwootAccountConfig {
  baseUrl: string;
  accountId: string;
  apiKey: string;
}

interface MetricsParams {
  dateFrom: string;
  dateTo: string;
  inboxId?: number;
  agentId?: number;
}

interface ResolverResult {
  type: 'ai' | 'human' | 'unclassified';
  method: 'explicit' | 'bot_native' | 'inferred' | 'fallback' | 'none';
}

interface FetchDebugInfo {
  fetchMode: 'all' | 'by_status' | 'failed';
  pagesFetched: number;
  fallbackUsed: boolean;
  chatwootFetchHealthy: boolean;
  totalRawConversations: number;
  errors: string[];
}

// ============================================================================
// CLASSIFICATION HELPERS
// ============================================================================

function classifyCurrentHandler(conv: any): 'ai' | 'human' | 'none' {
  const custom = conv.custom_attributes || {};
  const additional = conv.additional_attributes || {};

  const aiResponded = custom.ai_responded === true || additional.ai_responded === true;
  const humanActive = custom.human_active === true || additional.human_active === true;
  const humanIntervened = custom.human_intervened === true || additional.human_intervened === true;
  const handoffToHuman = custom.handoff_to_human === true || additional.handoff_to_human === true;
  const hasHumanAssignee = !!(conv.meta?.assignee?.id || conv.assignee_id);
  const hasBotAssignee = conv.meta?.assignee?.type === 'AgentBot' || !!conv.agent_bot_id;

  if (humanActive || handoffToHuman || humanIntervened) return 'human';
  if (hasBotAssignee) return 'ai';
  if (aiResponded && !hasHumanAssignee) return 'ai';
  if (aiResponded && hasHumanAssignee) return 'human';
  if (hasHumanAssignee) return 'human';
  return 'none';
}

function classifyResolver(conv: any): ResolverResult {
  if (conv.status !== 'resolved') {
    return { type: 'unclassified', method: 'none' };
  }

  const custom = conv.custom_attributes || {};
  const additional = conv.additional_attributes || {};
  const resolvedBy = custom.resolved_by || additional.resolved_by;

  if (resolvedBy === 'ai') return { type: 'ai', method: 'explicit' };
  if (resolvedBy === 'human') return { type: 'human', method: 'explicit' };

  const hasBotAssignee = conv.meta?.assignee?.type === 'AgentBot' || !!conv.agent_bot_id;
  const hasHumanAssignee = !!(conv.meta?.assignee?.id || conv.assignee_id) && !hasBotAssignee;

  if (hasBotAssignee || !!conv.agent_bot_id) return { type: 'ai', method: 'bot_native' };

  const aiResponded = custom.ai_responded === true || additional.ai_responded === true;
  if (aiResponded) {
    return hasHumanAssignee
      ? { type: 'human', method: 'inferred' }
      : { type: 'ai', method: 'inferred' };
  }

  if (hasHumanAssignee) return { type: 'human', method: 'fallback' };
  return { type: 'unclassified', method: 'none' };
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

// ============================================================================
// ROBUST PAYLOAD EXTRACTOR
// ============================================================================

function extractConversations(data: any): any[] {
  // Format 1: { data: { payload: [...] } }
  if (data?.data?.payload && Array.isArray(data.data.payload)) {
    return data.data.payload;
  }
  // Format 2: { payload: [...] }
  if (data?.payload && Array.isArray(data.payload)) {
    return data.payload;
  }
  // Format 3: direct array
  if (Array.isArray(data)) {
    return data;
  }
  // Format 4: { data: [...] }
  if (data?.data && Array.isArray(data.data)) {
    return data.data;
  }
  return [];
}

// ============================================================================
// CHATWOOT API FETCHERS (v2 — resilient)
// ============================================================================

async function fetchWithRetry(url: string, headers: Record<string, string>, retries = 2): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`[Chatwoot] Retry ${i + 1}/${retries + 1} failed for ${url}: ${lastError.message}`);
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  throw lastError;
}

/**
 * Fetch contact details from Chatwoot Contacts API.
 * Returns the contact's created_at (immutable registration date).
 */
async function fetchContactDetails(
  baseUrl: string,
  accountId: string,
  contactId: number,
  headers: Record<string, string>
): Promise<{ id: number; created_at: number } | null> {
  try {
    const url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    const response = await fetchWithRetry(url, headers, 1);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const contact = data?.payload || data;
    if (!contact?.created_at) return null;
    return { id: contact.id, created_at: contact.created_at };
  } catch {
    return null;
  }
}

/**
 * Strategy A: Fetch all conversations with status=all (paginated).
 * Returns { conversations, healthy, pagesFetched, errors }.
 */
async function fetchConversationsAll(
  baseUrl: string,
  accountId: string,
  headers: Record<string, string>,
): Promise<{ conversations: any[]; healthy: boolean; pagesFetched: number; errors: string[] }> {
  const allConversations: any[] = [];
  const errors: string[] = [];
  let page = 1;
  const perPage = 50;
  let hasMore = true;
  let hadSuccessfulPage = false;

  while (hasMore && page <= 10) {
    try {
      const url = `${baseUrl}/api/v1/accounts/${accountId}/conversations?status=all&page=${page}&per_page=${perPage}`;
      const response = await fetchWithRetry(url, headers, 1);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        errors.push(`Page ${page}: HTTP ${response.status} - ${errText.substring(0, 200)}`);
        break;
      }

      const data = await response.json();
      const conversations = extractConversations(data);

      if (conversations.length === 0) {
        hasMore = false;
      } else {
        hadSuccessfulPage = true;
        allConversations.push(...conversations);
        page++;
        if (conversations.length < perPage) hasMore = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Page ${page}: ${msg}`);
      break;
    }
  }

  return {
    conversations: allConversations,
    healthy: hadSuccessfulPage || (allConversations.length === 0 && errors.length === 0),
    pagesFetched: page - 1,
    errors,
  };
}

/**
 * Strategy B (fallback): Fetch conversations by individual status.
 * Merges by conversation_id to deduplicate.
 */
async function fetchConversationsByStatus(
  baseUrl: string,
  accountId: string,
  headers: Record<string, string>,
): Promise<{ conversations: any[]; healthy: boolean; pagesFetched: number; errors: string[] }> {
  const statuses = ['open', 'pending', 'resolved', 'snoozed'];
  const allMap = new Map<number, any>();
  const errors: string[] = [];
  let totalPages = 0;
  let hadSuccess = false;

  for (const status of statuses) {
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) {
      try {
        const url = `${baseUrl}/api/v1/accounts/${accountId}/conversations?status=${status}&page=${page}&per_page=50`;
        const response = await fetchWithRetry(url, headers, 1);

        if (!response.ok) {
          errors.push(`${status} page ${page}: HTTP ${response.status}`);
          break;
        }

        const data = await response.json();
        const conversations = extractConversations(data);

        if (conversations.length === 0) {
          hasMore = false;
        } else {
          hadSuccess = true;
          for (const conv of conversations) {
            if (conv.id && !allMap.has(conv.id)) {
              allMap.set(conv.id, conv);
            }
          }
          page++;
          totalPages++;
          if (conversations.length < 50) hasMore = false;
        }
      } catch (err) {
        errors.push(`${status} page ${page}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }

  return {
    conversations: Array.from(allMap.values()),
    healthy: hadSuccess,
    pagesFetched: totalPages,
    errors,
  };
}

/**
 * Layered fetch: tries Strategy A first, falls back to Strategy B.
 * Throws if BOTH strategies fail completely.
 */
async function fetchAllConversationsResilient(
  baseUrl: string,
  accountId: string,
  headers: Record<string, string>,
): Promise<{ conversations: any[]; debug: FetchDebugInfo }> {
  // Strategy A: status=all
  const resultA = await fetchConversationsAll(baseUrl, accountId, headers);

  if (resultA.healthy && resultA.conversations.length > 0) {
    return {
      conversations: resultA.conversations,
      debug: {
        fetchMode: 'all',
        pagesFetched: resultA.pagesFetched,
        fallbackUsed: false,
        chatwootFetchHealthy: true,
        totalRawConversations: resultA.conversations.length,
        errors: resultA.errors,
      },
    };
  }

  // Strategy A returned 0 conversations with no errors — could be genuinely empty
  if (resultA.healthy && resultA.conversations.length === 0 && resultA.errors.length === 0) {
    return {
      conversations: [],
      debug: {
        fetchMode: 'all',
        pagesFetched: resultA.pagesFetched,
        fallbackUsed: false,
        chatwootFetchHealthy: true,
        totalRawConversations: 0,
        errors: [],
      },
    };
  }

  // Strategy A failed or returned 0 with errors — try Strategy B
  logger.warn('[Chatwoot] Strategy A failed or empty with errors, trying Strategy B (by_status)', {
    errorsA: resultA.errors,
    countA: resultA.conversations.length,
  });

  const resultB = await fetchConversationsByStatus(baseUrl, accountId, headers);

  if (resultB.healthy) {
    return {
      conversations: resultB.conversations,
      debug: {
        fetchMode: 'by_status',
        pagesFetched: resultB.pagesFetched,
        fallbackUsed: true,
        chatwootFetchHealthy: true,
        totalRawConversations: resultB.conversations.length,
        errors: [...resultA.errors, ...resultB.errors],
      },
    };
  }

  // BOTH strategies failed — throw explicit error (no silent degradation)
  const allErrors = [...resultA.errors, ...resultB.errors];
  logger.error('[Chatwoot] BOTH fetch strategies failed', { errors: allErrors });
  throw new Error(
    `Falha ao buscar conversas do Chatwoot. Erros: ${allErrors.slice(0, 3).join('; ')}`
  );
}

async function fetchAgents(
  baseUrl: string,
  accountId: string,
  headers: Record<string, string>
): Promise<any[]> {
  try {
    const url = `${baseUrl}/api/v1/accounts/${accountId}/agents`;
    const response = await fetchWithRetry(url, headers);

    if (response.ok) {
      const data = await response.json() as any;
      return Array.isArray(data) ? data : (data.payload || []);
    }

    logger.error(`[Chatwoot] Agents fetch failed: ${response.status}`);
    return [];
  } catch (err) {
    logger.error('[Chatwoot] Error fetching agents:', err);
    return [];
  }
}

async function fetchInboxes(
  baseUrl: string,
  accountId: string,
  headers: Record<string, string>
): Promise<any[]> {
  try {
    const url = `${baseUrl}/api/v1/accounts/${accountId}/inboxes`;
    const response = await fetchWithRetry(url, headers);

    if (response.ok) {
      const data = await response.json() as any;
      return data.payload || [];
    }

    logger.error(`[Chatwoot] Inboxes fetch failed: ${response.status}`);
    return [];
  } catch (err) {
    logger.error('[Chatwoot] Error fetching inboxes:', err);
    return [];
  }
}

// ============================================================================
// MAIN SERVICE
// ============================================================================

class ChatwootMetricsService {
  async computeMetrics(dbAccountId: string, params: MetricsParams) {
    // 1. Get Chatwoot config from DB
    const account = await prisma.account.findUnique({
      where: { id: dbAccountId },
      select: {
        chatwootBaseUrl: true,
        chatwootAccountId: true,
        chatwootApiKey: true,
      },
    });

    if (!account?.chatwootBaseUrl || !account?.chatwootAccountId || !account?.chatwootApiKey) {
      throw new Error('Configuração do Chatwoot incompleta.');
    }

    const baseUrl = account.chatwootBaseUrl.replace(/\/$/, '');
    const chatwootAccountId = account.chatwootAccountId;
    const apiKey = account.chatwootApiKey;

    logger.info('[Chatwoot] Credentials loaded from DB', {
      baseUrl,
      chatwootAccountId,
      apiKeyPreview: apiKey.substring(0, 4) + '****',
    });

    const headers: Record<string, string> = {
      'api_access_token': apiKey,
      'Accept': 'application/json',
      'User-Agent': 'GLEPS-CRM/2.0',
    };

    // Normalize dates to full-day boundaries
    const dateFromParsed = new Date(params.dateFrom);
    dateFromParsed.setHours(0, 0, 0, 0);
    const dateToParsed = new Date(params.dateTo);
    dateToParsed.setHours(23, 59, 59, 999);

    // 2. Fetch raw data in parallel — conversations use resilient layered fetch
    const [conversationsResult, agents, inboxes] = await Promise.all([
      fetchAllConversationsResilient(baseUrl, chatwootAccountId, headers),
      fetchAgents(baseUrl, chatwootAccountId, headers),
      fetchInboxes(baseUrl, chatwootAccountId, headers),
    ]);

    const allConversations = conversationsResult.conversations;
    const fetchDebug = conversationsResult.debug;

    logger.info('[Metrics] Raw data fetched', {
      conversations: allConversations.length,
      agents: agents.length,
      inboxes: inboxes.length,
      fetchMode: fetchDebug.fetchMode,
      fallbackUsed: fetchDebug.fallbackUsed,
      healthy: fetchDebug.chatwootFetchHealthy,
    });

    // ========================================================================
    // CAMADA 1: Atendimento ao Vivo — APENAS CONVERSAS ABERTAS (SEM FILTRO DE DATA)
    // ========================================================================
    const liveConversations = allConversations.filter((c: any) => c.status === 'open');
    const filteredLiveConversations = params.inboxId
      ? liveConversations.filter((c: any) => c.inbox_id === params.inboxId)
      : liveConversations;

    // ========================================================================
    // CAMADA 2: Resolução & Histórico — FILTRADO POR DATA
    // ========================================================================
    // Filtra conversas históricas APENAS por created_at.
    // Mudanças administrativas (etiquetas, atribuições) atualizam last_activity_at
    // mas NÃO devem inflar a contagem de leads no período.
    const historyConversations = allConversations.filter((conv: any) => {
      const rawCreatedAt = conv.created_at;
      const createdAtMs = typeof rawCreatedAt === 'number' ? rawCreatedAt * 1000 : new Date(rawCreatedAt).getTime();
      const createdAt = new Date(createdAtMs);
      return createdAt >= dateFromParsed && createdAt <= dateToParsed;
    });

    const filteredHistoryConversations = params.inboxId
      ? historyConversations.filter((c: any) => c.inbox_id === params.inboxId)
      : historyConversations;

    const finalConversations = params.agentId
      ? filteredHistoryConversations.filter((c: any) =>
          c.meta?.assignee?.id === params.agentId || c.assignee_id === params.agentId
        )
      : filteredHistoryConversations;

    // ========================================================================
    // COUNTERS
    // ========================================================================
    let openCount = 0;
    let resolvedCount = 0;
    let pendingCount = 0;
    let unattendedCount = 0;
    let leadsInPeriod = 0;

    const atendimento = { total: 0, ia: 0, humano: 0, semAssignee: 0 };
    const now = Date.now();
    const backlog = { ate15min: 0, de15a60min: 0, acima60min: 0 };

    const agentStats: Record<number, {
      name: string; email: string; thumbnail?: string;
      conversations: number; resolved: number;
      totalResponseTime: number; responseCount: number;
    }> = {};

    for (const agent of agents) {
      agentStats[agent.id] = {
        name: agent.name || agent.email,
        email: agent.email,
        thumbnail: agent.thumbnail,
        conversations: 0, resolved: 0,
        totalResponseTime: 0, responseCount: 0,
      };
    }

    const hourlyCount: Record<number, number> = {};
    for (let h = 0; h <= 23; h++) hourlyCount[h] = 0;

    // ============================================================
    // PROCESSO 1: ATENDIMENTO AO VIVO
    // ============================================================
    for (const conv of filteredLiveConversations) {
      atendimento.total++;
      const handler = classifyCurrentHandler(conv);

      if (handler === 'ai') atendimento.ia++;
      else if (handler === 'human') atendimento.humano++;
      else atendimento.semAssignee++;

      const hasBotAssignee = conv.meta?.assignee?.type === 'AgentBot' || !!conv.agent_bot_id;
      const hasHumanAssignee = !!(conv.meta?.assignee?.id || conv.assignee_id) && !hasBotAssignee;
      if (hasHumanAssignee) {
        let waitingMs: number;
        if (conv.waiting_since) {
          waitingMs = now - (conv.waiting_since * 1000);
        } else {
          const lastActivity = conv.last_activity_at
            ? conv.last_activity_at * 1000
            : new Date(conv.created_at).getTime();
          waitingMs = now - lastActivity;
        }
        const waitingMinutes = waitingMs / 60000;
        if (waitingMinutes <= 15) backlog.ate15min++;
        else if (waitingMinutes <= 60) backlog.de15a60min++;
        else backlog.acima60min++;
      }
    }

    // ============================================================
    // PROCESSO 2: HISTÓRICO & RESOLUÇÃO
    // ============================================================
    for (const conv of finalConversations) {
      switch (conv.status) {
        case 'open': openCount++; break;
        case 'resolved': resolvedCount++; break;
        case 'pending': pendingCount++; break;
      }

      if (conv.agent_last_seen_at === null && conv.status === 'open') {
        unattendedCount++;
      }

      const hasBotAssignee = conv.meta?.assignee?.type === 'AgentBot' || !!conv.agent_bot_id;
      const hasHumanAssignee = !!(conv.meta?.assignee?.id || conv.assignee_id) && !hasBotAssignee;
      if (hasHumanAssignee) {
        const agentIdVal = conv.meta?.assignee?.id || conv.assignee_id;
        if (agentStats[agentIdVal]) {
          agentStats[agentIdVal].conversations++;
          if (conv.status === 'resolved') agentStats[agentIdVal].resolved++;

          if (conv.first_reply_created_at && conv.created_at) {
            const createdAtMs = typeof conv.created_at === 'number'
              ? conv.created_at * 1000 : new Date(conv.created_at).getTime();
            const firstReplyMs = typeof conv.first_reply_created_at === 'number'
              ? conv.first_reply_created_at * 1000 : new Date(conv.first_reply_created_at).getTime();
            const responseTime = firstReplyMs - createdAtMs;
            if (responseTime > 0) {
              agentStats[agentIdVal].totalResponseTime += responseTime;
              agentStats[agentIdVal].responseCount++;
            }
          }
        }
      }

      const rawCreatedAt = conv.created_at;
      const createdAtMs = typeof rawCreatedAt === 'number' ? rawCreatedAt * 1000 : new Date(rawCreatedAt).getTime();
      const createdAt = new Date(createdAtMs);
      if (createdAt >= dateFromParsed && createdAt <= dateToParsed) {
        leadsInPeriod++;
        const hourLocal = parseInt(
          new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' })
            .format(createdAt),
          10
        );
        hourlyCount[hourLocal]++;
      }
    }

    // ========================================================================
    // RESOLUTION LOGS: Sync + Query via Prisma
    // ========================================================================
    let historicoResolucoes = { totalIA: 0, totalHumano: 0, transbordoCount: 0, percentualIA: 0, percentualHumano: 0 };

    // ========================================================================
    // NOVOS LEADS: Contatos cujo created_at na API de Contatos do Chatwoot
    // está dentro do período. O created_at é imutável e não depende de paginação.
    // ========================================================================
    let novosLeads = await (async () => {
      const contactIdsInPeriod = [...new Set(
        finalConversations
          .map((c: any) => c.meta?.sender?.id)
          .filter(Boolean)
      )] as number[];

      if (contactIdsInPeriod.length === 0) return 0;

      let count = 0;
      const batchSize = 5;
      for (let i = 0; i < contactIdsInPeriod.length; i += batchSize) {
        const batch = contactIdsInPeriod.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(id => fetchContactDetails(baseUrl, chatwootAccountId, id, headers))
        );
        for (const contact of results) {
          if (!contact?.created_at) continue; // sem dados = NÃO conta como novo
          const createdAtMs = typeof contact.created_at === 'number'
            ? contact.created_at * 1000
            : new Date(contact.created_at).getTime();
          if (createdAtMs >= dateFromParsed.getTime()) { count++; }
        }
      }

      logger.info(`[Metrics] Novos Leads: ${count}/${contactIdsInPeriod.length} (via Contacts API created_at)`);
      return count;
    })();

    let resolutionLogsAvailable = false;

    try {
      await prisma.$queryRaw`SELECT 1 FROM resolution_logs LIMIT 0`;
      resolutionLogsAvailable = true;
    } catch (_) {
      logger.warn('[Metrics] resolution_logs table not available — using fallback');
    }

    // --- Sync resolution_logs (only if table exists) ---
    if (resolutionLogsAvailable) {
      try {
        const resolvedConversations = finalConversations.filter((c: any) => c.status === 'resolved');

        for (const conv of resolvedConversations) {
          const custom = conv.custom_attributes || {};
          const additional = conv.additional_attributes || {};
          const resolvedByAttr = custom.resolved_by || additional.resolved_by;

          if (resolvedByAttr === 'ai') continue;

          const lastActivityAt = conv.last_activity_at;
          if (!lastActivityAt) continue;

          const resolvedAt = typeof lastActivityAt === 'number'
            ? new Date(lastActivityAt * 1000)
            : new Date(lastActivityAt);

          try {
            const aiParticipated =
              custom.ai_responded === true ||
              additional.ai_responded === true ||
              custom.ai_participated === true ||
              additional.ai_participated === true ||
              custom.handoff_to_human === true ||
              additional.handoff_to_human === true;

            await prisma.$executeRaw`
              INSERT INTO resolution_logs (account_id, conversation_id, resolved_by, resolution_type, ai_participated, resolved_at)
              VALUES (${dbAccountId}::uuid, ${conv.id}, 'human', 'inferred', ${aiParticipated}, ${resolvedAt})
              ON CONFLICT (account_id, conversation_id)
              DO UPDATE SET ai_participated = ${aiParticipated}, resolved_at = ${resolvedAt}
            `;
          } catch (insertErr) {
            // Non-fatal — skip duplicates silently
          }
        }
      } catch (syncErr) {
        logger.warn('[Metrics] resolution_logs sync error (non-fatal):', syncErr as any);
      }
    }

    // --- Query resolution totals from DB (only if table exists) ---
    if (resolutionLogsAvailable) {
      try {
        const resolutionLogs = await prisma.$queryRaw<Array<{ resolved_by: string; ai_participated: boolean | null }>>`
          SELECT resolved_by, ai_participated FROM resolution_logs
          WHERE account_id = ${dbAccountId}::uuid
            AND resolved_at >= ${dateFromParsed}
            AND resolved_at <= ${dateToParsed}
        `;

        if (resolutionLogs.length > 0) {
          const aiCount = resolutionLogs.filter(r => r.resolved_by === 'ai').length;
          const humanCount = resolutionLogs.filter(r => r.resolved_by === 'human').length;
          const transbordoCount = resolutionLogs.filter(
            r => r.resolved_by === 'human' && r.ai_participated === true
          ).length;
          const total = aiCount + humanCount;

          historicoResolucoes = {
            totalIA: aiCount,
            totalHumano: humanCount,
            transbordoCount,
            percentualIA: total > 0 ? Math.round((aiCount / total) * 100) : 0,
            percentualHumano: total > 0 ? Math.round((humanCount / total) * 100) : 0,
          };
        }
      } catch (dbErr) {
        logger.warn('[Metrics] resolution_logs query error (non-fatal):', dbErr as any);
      }
    }

    // ========================================================================
    // FALLBACK TOTAL: compute from raw Chatwoot data if resolution_logs empty
    // ========================================================================
    if (historicoResolucoes.totalIA === 0 && historicoResolucoes.totalHumano === 0) {
      const resolvedConversations = finalConversations.filter(
        (c: any) => c.status === 'resolved'
      );

      let fallbackIA = 0;
      let fallbackHumano = 0;
      let fallbackTransbordo = 0;

      for (const conv of resolvedConversations) {
        const result = classifyResolver(conv);
        if (result.type === 'ai') {
          fallbackIA++;
        } else if (result.type === 'human') {
          fallbackHumano++;
          const custom = conv.custom_attributes || {};
          const additional = conv.additional_attributes || {};
          const aiParticipated =
            custom.ai_responded === true ||
            additional.ai_responded === true ||
            custom.ai_participated === true ||
            additional.ai_participated === true;
          if (aiParticipated) {
            fallbackTransbordo++;
          }
        }
      }

      const fallbackTotal = fallbackIA + fallbackHumano;
      historicoResolucoes = {
        totalIA: fallbackIA,
        totalHumano: fallbackHumano,
        transbordoCount: fallbackTransbordo,
        percentualIA: fallbackTotal > 0 ? Math.round((fallbackIA / fallbackTotal) * 100) : 0,
        percentualHumano: fallbackTotal > 0 ? Math.round((fallbackHumano / fallbackTotal) * 100) : 0,
      };
    } else if (historicoResolucoes.totalIA === 0 && historicoResolucoes.totalHumano > 0) {
      const resolvedConversations = finalConversations.filter(
        (c: any) => c.status === 'resolved'
      );

      let fallbackIA = 0;
      for (const conv of resolvedConversations) {
        const result = classifyResolver(conv);
        if (result.type === 'ai') fallbackIA++;
      }

      if (fallbackIA > 0) {
        historicoResolucoes.totalIA = fallbackIA;
        const total = historicoResolucoes.totalIA + historicoResolucoes.totalHumano;
        historicoResolucoes.percentualIA = Math.round((fallbackIA / total) * 100);
        historicoResolucoes.percentualHumano = 100 - historicoResolucoes.percentualIA;
      }
    }

    // ========================================================================
    // BUILD RESOLUCAO FROM PERSISTENT DATA
    // ========================================================================
    const resolucao = {
      total: historicoResolucoes.totalIA + historicoResolucoes.totalHumano,
      ia: { total: historicoResolucoes.totalIA, explicito: historicoResolucoes.totalIA, botNativo: 0, inferido: 0 },
      humano: { total: historicoResolucoes.totalHumano, explicito: historicoResolucoes.totalHumano, inferido: 0 },
      naoClassificado: 0,
      transbordoFinalizado: historicoResolucoes.transbordoCount,
    };

    const totalResolvidosClassificados = resolucao.ia.total + resolucao.humano.total;
    const taxaResolucaoIA = totalResolvidosClassificados > 0
      ? Math.round((resolucao.ia.total / totalResolvidosClassificados) * 100) : 0;
    const taxaResolucaoHumano = totalResolvidosClassificados > 0
      ? 100 - taxaResolucaoIA : 0;
    const iniciadasPorIACount = resolucao.ia.total + resolucao.transbordoFinalizado;
    const taxaTransbordo = iniciadasPorIACount > 0
      ? Math.round((resolucao.transbordoFinalizado / iniciadasPorIACount) * 100) : 0;
    const eficienciaIA = resolucao.total > 0
      ? Math.round((resolucao.ia.total / resolucao.total) * 100) : 0;

    const taxas = {
      resolucaoIA: `${taxaResolucaoIA}%`,
      resolucaoHumano: `${taxaResolucaoHumano}%`,
      transbordo: `${taxaTransbordo}%`,
      eficienciaIA: `${eficienciaIA}%`,
    };

    // Average response time
    let totalResponseTime = 0;
    let totalResponseCount = 0;
    for (const stats of Object.values(agentStats)) {
      totalResponseTime += stats.totalResponseTime;
      totalResponseCount += stats.responseCount;
    }
    const avgFirstResponseMs = totalResponseCount > 0 ? totalResponseTime / totalResponseCount : 0;

    // Agent performance array
    const agentPerformance = Object.entries(agentStats)
      .filter(([_, stats]) => stats.conversations > 0)
      .map(([id, stats]) => ({
        agentId: parseInt(id),
        agentName: stats.name,
        agentEmail: stats.email,
        thumbnail: stats.thumbnail,
        atendimentosAssumidos: stats.conversations,
        atendimentosResolvidos: stats.resolved,
        tempoMedioResposta: stats.responseCount > 0
          ? formatTime(stats.totalResponseTime / stats.responseCount) : '0s',
        taxaResolucao: stats.conversations > 0
          ? Math.round((stats.resolved / stats.conversations) * 100) : 0,
      }));

    // Conversations by channel
    const conversasPorCanal = inboxes.map((inbox: any) => {
      const count = finalConversations.filter((c: any) => c.inbox_id === inbox.id).length;
      let mappedChannel = 'webchat';
      const channelType = inbox.channel_type || '';
      if (channelType.includes('Whatsapp')) mappedChannel = 'whatsapp';
      else if (channelType.includes('Instagram') || channelType.includes('Facebook')) mappedChannel = 'instagram';

      return { inboxId: inbox.id, canal: mappedChannel, inboxName: inbox.name, totalConversas: count };
    });

    // Hourly peak
    const picoPorHora = Object.entries(hourlyCount)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([hora, total]) => ({ hora: Number(hora), totalConversas: total }));

    // ========================================================================
    // RESPONSE
    // ========================================================================
    return {
      totalLeads: (() => {
        const ids = new Set(finalConversations.map((c: any) => c.meta?.sender?.id).filter(Boolean));
        return ids.size || finalConversations.length;
      })(),
      conversasAtivas: novosLeads,
      retornosNoPeriodo: (() => {
        const ids = new Set(finalConversations.map((c: any) => c.meta?.sender?.id).filter(Boolean));
        const total = ids.size || finalConversations.length;
        return Math.max(0, total - novosLeads);
      })(),
      conversasResolvidas: resolvedCount,
      conversasPendentes: pendingCount,
      conversasSemResposta: unattendedCount,

      atendimento,
      resolucao,
      taxas,

      atendimentosIA: resolucao.ia.total,
      atendimentosHumano: resolucao.humano.total,
      atendimentosClassificados: totalResolvidosClassificados,
      percentualIA: taxaResolucaoIA,
      percentualHumano: taxaResolucaoHumano,
      taxaTransbordo: taxas.transbordo,

      transbordo: {
        total: resolucao.transbordoFinalizado,
        iniciadasPorIA: iniciadasPorIACount,
        taxa: taxas.transbordo,
      },

      tempoMedioPrimeiraResposta: formatTime(avgFirstResponseMs),
      tempoMedioResolucao: '0s',

      conversasPorCanal,
      picoPorHora,
      backlog,

      agentes: agentPerformance,

      qualidade: {
        conversasSemResposta: unattendedCount,
        taxaAtendimentoVenda: '0%',
      },

      _debug: {
        ...fetchDebug,
        totalConversationsFiltered: finalConversations.length,
        atendimento,
        resolucao,
        inboxesCount: inboxes.length,
        agentsCount: agents.length,
        dateRange: { from: params.dateFrom, to: params.dateTo },
      },
    };
  }
}

export const chatwootMetricsService = new ChatwootMetricsService();
