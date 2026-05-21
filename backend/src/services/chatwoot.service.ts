import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  ChatwootAgent,
  ChatwootLabel,
  ChatwootInbox,
  ChatwootConversation,
  ChatwootContact,
  ChatwootApiError,
  ChatwootAccountConfig,
  CreateLabelInput,
  UpdateLabelInput,
  ConversationFilters,
  DateRange,
  ChatwootAgentMetrics,
  ChatwootReportMetrics,
  ChatwootAccountMetrics,
} from '../types/chatwoot.types';
import { normalizeStageKey, resolveLatestStageTagFromLabels } from '../utils/chatwoot-stage.util';

class ChatwootService {
  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Get account with Chatwoot configuration
   */
  private async getAccountConfig(accountId: string): Promise<ChatwootAccountConfig> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        chatwootBaseUrl: true,
        chatwootAccountId: true,
        chatwootApiKey: true,
      },
    });

    if (!account) {
      throw new NotFoundError('Conta');
    }

    if (!account.chatwootBaseUrl || !account.chatwootAccountId || !account.chatwootApiKey) {
      throw new ValidationError('Configuração do Chatwoot incompleta. Configure a URL, Account ID e API Key.');
    }

    return {
      baseUrl: account.chatwootBaseUrl.replace(/\/$/, ''), // Remove trailing slash
      accountId: account.chatwootAccountId,
      apiKey: account.chatwootApiKey,
    };
  }

  /**
   * Make authenticated request to Chatwoot API
   */
  private async makeRequest<T>(
    config: ChatwootAccountConfig,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${config.baseUrl}/api/v1/accounts/${config.accountId}${endpoint}`;

    const baseHeaders: Record<string, string> = {
      'api_access_token': config.apiKey,
      'Content-Type': 'application/json',
    };

    if (options.headers) {
      const h = options.headers as Record<string, string>;
      Object.assign(baseHeaders, h);
    }

    const headers = baseHeaders;

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error('Chatwoot API Error', {
          url,
          status: response.status,
          body: errorBody,
        });
        throw new ChatwootApiError(response.status, errorBody);
      }

      // Some endpoints return empty response
      const text = await response.text();
      return text ? JSON.parse(text) : {} as T;
    } catch (error) {
      if (error instanceof ChatwootApiError) {
        throw error;
      }
      logger.error('Chatwoot Request Failed', { url, error });
      throw new Error(`Falha na comunicação com Chatwoot: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ============================================
  // Connection & Validation
  // ============================================

  /**
   * Test connection to Chatwoot
   */
  async testConnection(accountId: string): Promise<{ success: boolean; message: string }> {
    try {
      const config = await this.getAccountConfig(accountId);
      
      // Try to fetch account info
      await this.makeRequest(config, '/agents');
      
      return {
        success: true,
        message: 'Conexão com Chatwoot estabelecida com sucesso!',
      };
    } catch (error) {
      if (error instanceof ChatwootApiError) {
        if (ChatwootApiError.isUnauthorized(error)) {
          return { success: false, message: 'API Key inválida ou sem permissões' };
        }
        return { success: false, message: `Erro da API: ${error.statusCode}` };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Erro desconhecido',
      };
    }
  }

  /**
   * Test connection with provided credentials (for setup)
   */
  async testConnectionWithCredentials(
    baseUrl: string,
    chatwootAccountId: string,
    apiKey: string
  ): Promise<{
    success: boolean;
    message: string;
    agents?: any[];
    inboxes?: any[];
    labels?: any[];
  }> {
    const config: ChatwootAccountConfig = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      accountId: chatwootAccountId,
      apiKey,
    };

    try {
      // Primary validation: fetch agents
      const agents = await this.makeRequest<any[]>(config, '/agents');
      const mappedAgents = (Array.isArray(agents) ? agents : []).map((a: any) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        role: a.role,
        availability_status: a.availability_status,
      }));

      // Secondary: fetch inboxes and labels (best effort)
      let inboxes: any[] = [];
      let labels: any[] = [];

      try {
        const inboxesData = await this.makeRequest<{ payload?: any[] } | any[]>(config, '/inboxes');
        const raw = Array.isArray(inboxesData) ? inboxesData : (inboxesData as any).payload || [];
        inboxes = raw.map((i: any) => ({ id: i.id, name: i.name, channel_type: i.channel_type }));
      } catch (e) {
        logger.warn('Failed to fetch inboxes during connection test', { error: e });
      }

      try {
        const labelsData = await this.makeRequest<{ payload?: any[] } | any[]>(config, '/labels');
        const raw = Array.isArray(labelsData) ? labelsData : (labelsData as any).payload || [];
        labels = raw.map((l: any) => ({ id: l.id, title: l.title, color: l.color }));
      } catch (e) {
        logger.warn('Failed to fetch labels during connection test', { error: e });
      }

      return {
        success: true,
        message: `Conexão com Chatwoot estabelecida com sucesso! ${mappedAgents.length} agente(s) encontrado(s).`,
        agents: mappedAgents,
        inboxes,
        labels,
      };
    } catch (error) {
      if (error instanceof ChatwootApiError) {
        if (ChatwootApiError.isUnauthorized(error)) {
          return { success: false, message: 'API Key inválida ou sem permissões' };
        }
        return { success: false, message: `Erro da API: ${error.statusCode}` };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Erro desconhecido',
      };
    }
  }

  // ============================================
  // Agents
  // ============================================

  /**
   * List all agents in the Chatwoot account
   */
  async getAgents(accountId: string): Promise<ChatwootAgent[]> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<ChatwootAgent[]>(config, '/agents');
    return response;
  }

  /**
   * Get agent by ID
   */
  async getAgentById(accountId: string, agentId: number): Promise<ChatwootAgent | null> {
    const agents = await this.getAgents(accountId);
    return agents.find(a => a.id === agentId) || null;
  }

  /**
   * Fetch agents with provided credentials (for import during setup)
   */
  async getAgentsWithCredentials(
    baseUrl: string,
    chatwootAccountId: string,
    apiKey: string
  ): Promise<ChatwootAgent[]> {
    const config: ChatwootAccountConfig = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      accountId: chatwootAccountId,
      apiKey,
    };
    return this.makeRequest<ChatwootAgent[]>(config, '/agents');
  }

  // ============================================
  // Inboxes (Channels)
  // ============================================

  /**
   * List all inboxes (channels)
   */
  async getInboxes(accountId: string): Promise<ChatwootInbox[]> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<{ payload: ChatwootInbox[] }>(config, '/inboxes');
    return response.payload || [];
  }

  // ============================================
  // Labels
  // ============================================

  /**
   * List all labels
   */
  async getLabels(accountId: string): Promise<ChatwootLabel[]> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<{ payload: ChatwootLabel[] }>(config, '/labels');
    return response.payload || [];
  }

  /**
   * Create a new label
   */
  async createLabel(accountId: string, input: CreateLabelInput): Promise<ChatwootLabel> {
    const config = await this.getAccountConfig(accountId);
    
    const body = {
      title: input.title,
      description: input.description || `Etapa do Kanban: ${input.title}`,
      color: input.color && input.color.startsWith('#') ? input.color : `#${input.color || '6366F1'}`,
      show_on_sidebar: input.show_on_sidebar ?? true,
    };

    const response = await this.makeRequest<ChatwootLabel>(config, '/labels', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    logger.info('Label created in Chatwoot', { accountId, label: response });
    return response;
  }

  /**
   * Update a label
   */
  async updateLabel(accountId: string, labelId: number, input: UpdateLabelInput): Promise<ChatwootLabel> {
    const config = await this.getAccountConfig(accountId);
    
    const body: Record<string, any> = {};
    if (input.title) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.color) body.color = input.color.startsWith('#') ? input.color : `#${input.color}`;
    if (input.show_on_sidebar !== undefined) body.show_on_sidebar = input.show_on_sidebar;

    const response = await this.makeRequest<ChatwootLabel>(config, `/labels/${labelId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    logger.info('Label updated in Chatwoot', { accountId, labelId, changes: input });
    return response;
  }

  /**
   * Delete a label
   */
  async deleteLabel(accountId: string, labelId: number): Promise<void> {
    const config = await this.getAccountConfig(accountId);
    
    await this.makeRequest(config, `/labels/${labelId}`, {
      method: 'DELETE',
    });

    logger.info('Label deleted in Chatwoot', { accountId, labelId });
  }

  // ============================================
  // Conversations
  // ============================================

  /**
   * List conversations with filters
   */
  async getConversations(
    accountId: string,
    filters: ConversationFilters = {}
  ): Promise<ChatwootConversation[]> {
    const config = await this.getAccountConfig(accountId);
    
    const queryParams = new URLSearchParams();
    if (filters.status && filters.status !== 'all') queryParams.set('status', filters.status);
    if (filters.inbox_id) queryParams.set('inbox_id', String(filters.inbox_id));
    if (filters.assignee_type) queryParams.set('assignee_type', filters.assignee_type);
    if (filters.page) queryParams.set('page', String(filters.page));
    if (filters.labels?.length) queryParams.set('labels', filters.labels.join(','));

    const query = queryParams.toString();
    const endpoint = `/conversations${query ? `?${query}` : ''}`;
    
    const response = await this.makeRequest<{ data: { payload: ChatwootConversation[] } }>(config, endpoint);
    return response.data?.payload || [];
  }

  /**
   * Get a single conversation
   */
  async getConversation(accountId: string, conversationId: number): Promise<ChatwootConversation> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<ChatwootConversation>(config, `/conversations/${conversationId}`);
    return response;
  }

  /**
   * Add labels to a conversation
   */
  async addLabelsToConversation(
    accountId: string,
    conversationId: number,
    labels: string[]
  ): Promise<ChatwootLabel[]> {
    const config = await this.getAccountConfig(accountId);
    
    const response = await this.makeRequest<{ payload: ChatwootLabel[] }>(
      config,
      `/conversations/${conversationId}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({ labels }),
      }
    );

    logger.info('Labels added to conversation', { accountId, conversationId, labels });
    return response.payload || [];
  }

  /**
   * Update conversation labels (replace all)
   */
  async updateConversationLabels(
    accountId: string,
    conversationId: number,
    labels: string[]
  ): Promise<ChatwootLabel[]> {
    const config = await this.getAccountConfig(accountId);
    
    // Chatwoot replaces all labels on POST to /labels
    const response = await this.makeRequest<{ payload: ChatwootLabel[] }>(
      config,
      `/conversations/${conversationId}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({ labels }),
      }
    );

    logger.info('Conversation labels updated', { accountId, conversationId, labels });
    return response.payload || [];
  }

  /**
   * List labels applied directly to a contact
   */
  async getContactLabels(accountId: string, contactId: number): Promise<string[]> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<{ payload?: string[] } | string[]>(
      config,
      `/contacts/${contactId}/labels`
    );

    return Array.isArray(response)
      ? response
      : ((response as { payload?: string[] })?.payload || []);
  }

  /**
   * Update contact labels (replace all)
   */
  async updateContactLabels(
    accountId: string,
    contactId: number,
    labels: string[]
  ): Promise<ChatwootLabel[]> {
    const config = await this.getAccountConfig(accountId);

    const response = await this.makeRequest<{ payload: ChatwootLabel[] }>(
      config,
      `/contacts/${contactId}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({ labels }),
      }
    );

    logger.info('Contact labels updated', { accountId, contactId, labels });
    return response.payload || [];
  }

  // ============================================
  // Contacts
  // ============================================

  /**
   * Get a contact by ID
   */
  async getContact(accountId: string, contactId: number): Promise<ChatwootContact> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<{ payload: ChatwootContact }>(config, `/contacts/${contactId}`);
    return response.payload;
  }

  /**
   * Search contacts
   */
  async searchContacts(accountId: string, query: string): Promise<ChatwootContact[]> {
    const config = await this.getAccountConfig(accountId);
    const response = await this.makeRequest<{ payload: ChatwootContact[] }>(
      config,
      `/contacts/search?q=${encodeURIComponent(query)}`
    );
    return response.payload || [];
  }

  // ============================================
  // Metrics & Reports
  // ============================================

  /**
   * Get account overview metrics
   */
  async getAccountMetrics(
    accountId: string,
    dateRange?: DateRange,
    inboxId?: number,
    agentId?: number,
  ): Promise<ChatwootAccountMetrics> {
    const config = await this.getAccountConfig(accountId);

    const queryParams = new URLSearchParams({ type: 'account' });
    if (dateRange?.since) queryParams.set('since', dateRange.since);
    if (dateRange?.until) queryParams.set('until', dateRange.until);
    if (inboxId) queryParams.set('inbox_id', String(inboxId));
    if (agentId) queryParams.set('agent_id', String(agentId));

    const response = await this.makeRequest<ChatwootAccountMetrics>(
      config,
      `/reports/summary?${queryParams.toString()}`
    );

    return response;
  }

  /**
   * Get conversation metrics for a date range
   */
  async getConversationMetrics(accountId: string, dateRange?: DateRange): Promise<ChatwootReportMetrics> {
    const config = await this.getAccountConfig(accountId);
    
    const queryParams = new URLSearchParams({ metric: 'conversations_count' });
    if (dateRange?.since) queryParams.set('since', dateRange.since);
    if (dateRange?.until) queryParams.set('until', dateRange.until);

    const response = await this.makeRequest<ChatwootReportMetrics>(
      config,
      `/reports?${queryParams.toString()}`
    );
    
    return response;
  }

  /**
   * Get agent performance metrics
   */
  async getAgentMetrics(accountId: string, dateRange?: DateRange): Promise<ChatwootAgentMetrics[]> {
    const config = await this.getAccountConfig(accountId);
    
    const queryParams = new URLSearchParams();
    if (dateRange?.since) queryParams.set('since', dateRange.since);
    if (dateRange?.until) queryParams.set('until', dateRange.until);

    const query = queryParams.toString();
    const response = await this.makeRequest<ChatwootAgentMetrics[]>(
      config,
      `/reports/agents${query ? `?${query}` : ''}`
    );
    
    return response;
  }

  /**
   * Get bot vs human metrics (IA vs Humano)
   */
  async getBotMetrics(accountId: string, dateRange?: DateRange): Promise<{ bot: number; human: number }> {
    const config = await this.getAccountConfig(accountId);
    
    // Fetch conversations and categorize by assignee type
    const queryParams = new URLSearchParams();
    if (dateRange?.since) queryParams.set('since', dateRange.since);
    if (dateRange?.until) queryParams.set('until', dateRange.until);

    const response = await this.makeRequest<{ bot_count?: number; human_count?: number }>(
      config,
      `/reports/bot?${queryParams.toString()}`
    );

    return {
      bot: response.bot_count || 0,
      human: response.human_count || 0,
    };
  }

  // ============================================
  // Sync Helpers
  // ============================================

  /**
   * Sync a local tag with Chatwoot label
   * Garante vínculo por slug, reaproveita labels existentes e corrige IDs quebrados
   */
  async syncTagToLabel(tagId: string, accountId: string): Promise<number | null> {
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag || tag.type !== 'stage') return null;

    const desiredTitle = tag.slug;
    const desiredDescription = `Etapa do Kanban: ${tag.name}`;
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '_');

    try {
      const labels = await this.getLabels(accountId);

      // 1) Se já existe vínculo e a label existe no Chatwoot, apenas atualiza
      const linkedLabel = tag.chatwootLabelId
        ? labels.find((label) => label.id === tag.chatwootLabelId)
        : undefined;

      if (linkedLabel) {
        await this.updateLabel(accountId, linkedLabel.id, {
          title: desiredTitle,
          description: desiredDescription,
          color: tag.color,
        });

        if (linkedLabel.id !== tag.chatwootLabelId) {
          await prisma.tag.update({
            where: { id: tag.id },
            data: { chatwootLabelId: linkedLabel.id },
          });
        }

        return linkedLabel.id;
      }

      // 2) Se havia vínculo salvo mas não existe mais no Chatwoot, limpa vínculo local
      if (tag.chatwootLabelId && !linkedLabel) {
        await prisma.tag.update({
          where: { id: tag.id },
          data: { chatwootLabelId: null },
        });
      }

      // 3) Reaproveita label existente por slug (evita duplicidade)
      const matchedBySlug = labels.find((label) => normalize(label.title) === desiredTitle);
      if (matchedBySlug) {
        await this.updateLabel(accountId, matchedBySlug.id, {
          title: desiredTitle,
          description: desiredDescription,
          color: tag.color,
        });

        await prisma.tag.update({
          where: { id: tag.id },
          data: { chatwootLabelId: matchedBySlug.id },
        });

        return matchedBySlug.id;
      }

      // 4) Cria label nova quando não há correspondente
      const label = await this.createLabel(accountId, {
        title: desiredTitle,
        description: desiredDescription,
        color: tag.color,
      });

      await prisma.tag.update({
        where: { id: tag.id },
        data: { chatwootLabelId: label.id },
      });

      return label.id;
    } catch (error) {
      logger.error('Failed to sync Chatwoot label from tag', {
        tagId,
        desiredTitle,
        error,
      });
      return null;
    }
  }

  /**
   * Apply stage labels to conversation when lead changes stage
   */
  async syncLeadStageToConversation(
    contactId: string,
    tagSlug: string,
    accountId: string
  ): Promise<void> {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        chatwootConversationId: true,
        leadTags: {
          include: { tag: true },
          where: { tag: { type: 'stage' } },
        },
      },
    });

    if (!contact?.chatwootConversationId) {
      logger.debug('Contact has no Chatwoot conversation', { contactId });
      return;
    }

    try {
      const stageLabels = [...new Set(contact.leadTags.map((lt) => lt.tag.slug))];
      if (!stageLabels.includes(tagSlug)) stageLabels.push(tagSlug);

      const currentConversation = await this.getConversation(accountId, contact.chatwootConversationId);
      const conversationLabels = Array.isArray(currentConversation?.labels) ? currentConversation.labels : [];
      const contactRecord = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { chatwootContactId: true },
      });

      const allStageTags = await prisma.tag.findMany({
        where: { accountId, type: 'stage', ativo: true },
        select: { slug: true, name: true },
      });

      const normalizeStageKey = (value: string) => value.toLowerCase().replace(/-/g, '_');
      const stageKeys = new Set(
        allStageTags.flatMap((tag) => [normalizeStageKey(tag.slug), normalizeStageKey(tag.name)])
      );

      const preserveNonStageLabels = (labels: string[]) =>
        labels.filter((label) => !stageKeys.has(normalizeStageKey(label)));

      const nextConversationLabels = [...new Set([...preserveNonStageLabels(conversationLabels), ...stageLabels])];
      await this.updateConversationLabels(accountId, contact.chatwootConversationId, nextConversationLabels);

      if (contactRecord?.chatwootContactId) {
        const existingContactLabels = await this.getContactLabels(accountId, contactRecord.chatwootContactId);
        const nextContactLabels = [...new Set([...preserveNonStageLabels(existingContactLabels), ...stageLabels])];
        await this.updateContactLabels(accountId, contactRecord.chatwootContactId, nextContactLabels);
      }

      logger.info('Synced lead stage to Chatwoot conversation', {
        contactId,
        conversationId: contact.chatwootConversationId,
        labels: stageLabels,
      });
    } catch (error) {
      logger.error('Failed to sync lead stage to Chatwoot', { contactId, tagSlug, error });
    }
  }

  /**
   * Find or create contact from Chatwoot data
   */
  async findOrCreateContactFromChatwoot(
    accountId: string,
    chatwootContactId: number,
    chatwootConversationId?: number,
    contactData?: { name?: string; phone_number?: string; email?: string }
  ): Promise<string> {
    // Try to find existing contact
    let contact = await prisma.contact.findFirst({
      where: {
        accountId,
        chatwootContactId,
      },
    });

    if (contact) {
      // Update conversation ID if provided
      if (chatwootConversationId && !contact.chatwootConversationId) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { chatwootConversationId },
        });
      }
      return contact.id;
    }

    // Create new contact
    contact = await prisma.contact.create({
      data: {
        accountId,
        chatwootContactId,
        chatwootConversationId,
        nome: contactData?.name,
        telefone: contactData?.phone_number,
        email: contactData?.email?.toLowerCase(),
        origem: 'whatsapp', // Default to WhatsApp, can be updated based on inbox type
      },
    });

    logger.info('Contact created from Chatwoot', {
      contactId: contact.id,
      chatwootContactId,
    });

    return contact.id;
  }
  // ============================================
  // Contact Sync
  // ============================================

  /**
   * Sync contacts from Chatwoot conversations into the database
   */
  async syncContacts(accountId: string): Promise<{
    contacts_created: number;
    contacts_updated: number;
    contacts_deleted: number;
    lead_tags_applied: number;
  }> {
    const config = await this.getAccountConfig(accountId);
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let leadTagsApplied = 0;

    // Get all stage tags for label matching
    const stageTags = await prisma.tag.findMany({
      where: { accountId, type: 'stage', ativo: true },
    });
    const stageTagCandidates = stageTags.map((tag) => ({
      id: tag.id,
      slug: tag.slug,
      name: tag.name,
    }));

    // ============================================================
    // ETAPA 1: Coletar TODAS as conversas e agrupar por contato
    // ------------------------------------------------------------
    // Um contato no Chatwoot pode ter múltiplas conversas (abertas,
    // resolvidas, reabertas). Cada conversa tem seu próprio conjunto
    // de labels. Para decidir corretamente a etapa do Kanban, NUNCA
    // devemos processar conversa-a-conversa (isso causa oscilação).
    // Em vez disso, agregamos todas as conversas do contato e
    // escolhemos a MAIS RECENTE (last_activity_at) como fonte de
    // verdade — é a que reflete o estado atual do atendimento.
    // ============================================================
    const seenChatwootContactIds = new Set<number>();
    const conversationsByContact = new Map<number, { sender: any; conversations: any[] }>();
    let page = 1;
    const maxPages = 50;

    while (page <= maxPages) {
      let conversations: any[];
      try {
        const response = await this.makeRequest<any>(config, `/conversations?status=all&page=${page}`);
        conversations = response?.data?.payload || [];
      } catch (error) {
        logger.error('[SyncContacts] Failed to fetch conversations page', { page, error });
        break;
      }

      if (conversations.length === 0) break;

      for (const conv of conversations) {
        const sender = conv.meta?.sender;
        if (!sender?.id) continue;

        seenChatwootContactIds.add(sender.id);

        const bucket = conversationsByContact.get(sender.id);
        if (bucket) {
          bucket.conversations.push(conv);
        } else {
          conversationsByContact.set(sender.id, { sender, conversations: [conv] });
        }
      }

      page++;
    }

    // ============================================================
    // ETAPA 2: Para cada contato, decidir a etapa baseando-se na
    // conversa MAIS RECENTE (último last_activity_at).
    // Fallback: se nenhuma conversa tem label de etapa, usar labels
    // aplicadas diretamente no contato (n8n pode aplicar lá).
    // ============================================================
    const conversationActivity = (c: any): number => {
      // Chatwoot expõe timestamps em segundos (epoch). Quanto maior, mais recente.
      return (
        Number(c.last_activity_at) ||
        Number(c.timestamp) ||
        Number(c.last_non_activity_message?.created_at) ||
        Number(c.created_at) ||
        0
      );
    };

    for (const { sender, conversations } of conversationsByContact.values()) {
      // Find or create contact
      let contact = await prisma.contact.findFirst({
        where: { accountId, chatwootContactId: sender.id },
      });

      // Conversa mais recente = fonte da verdade
      const sortedConvs = [...conversations].sort(
        (a, b) => conversationActivity(b) - conversationActivity(a)
      );
      const latestConv = sortedConvs[0];

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            accountId,
            chatwootContactId: sender.id,
            chatwootConversationId: latestConv.id,
            nome: sender.name || null,
            telefone: sender.phone_number || null,
            email: sender.email?.toLowerCase() || null,
            origem: 'whatsapp',
          },
        });
        created++;
      } else {
        const updates: any = {};
        if (sender.name && sender.name !== contact.nome) updates.nome = sender.name;
        if (sender.phone_number && sender.phone_number !== contact.telefone) updates.telefone = sender.phone_number;
        if (sender.email && sender.email.toLowerCase() !== contact.email) updates.email = sender.email.toLowerCase();
        if (latestConv.id && latestConv.id !== contact.chatwootConversationId) {
          updates.chatwootConversationId = latestConv.id;
        }

        if (Object.keys(updates).length > 0) {
          await prisma.contact.update({
            where: { id: contact.id },
            data: updates,
          });
          updated++;
        }
      }

      // ----------------------------------------------------------
      // Resolver etapa: prioridade das labels do CONTATO.
      // No Chatwoot, um contato pode ter múltiplas conversas com
      // labels históricas diferentes; a automação externa costuma
      // escrever a etapa atual no contato. Portanto, o contato é a
      // fonte principal de verdade e as conversas viram fallback.
      // ----------------------------------------------------------
      let resolvedTagId: string | null = null;
      let resolvedLabel: string | null = null;
      let resolvedSource: 'conversation' | 'contact' | null = null;
      let resolvedConvId: number | null = null;
      let resolvedStageMatches = 0;

      try {
        const contactLabels = await this.getContactLabels(accountId, sender.id);
        const resolvedFromContact = resolveLatestStageTagFromLabels(contactLabels, stageTagCandidates);
        if (resolvedFromContact.tag) {
          resolvedTagId = resolvedFromContact.tag.id;
          resolvedLabel = resolvedFromContact.label;
          resolvedSource = 'contact';
          resolvedStageMatches = resolvedFromContact.matchCount;

          if (contact.chatwootContactId) {
            const winningKey = resolvedFromContact.normalizedKey;
            const dedupedContactLabels = contactLabels.filter((label) => {
              const labelKey = normalizeStageKey(label);
              if (!labelKey) return false;
              const isStageLabel = stageTagCandidates.some((tag) =>
                [tag.slug, tag.name].some((candidate) => normalizeStageKey(candidate) === labelKey)
              );
              return !isStageLabel || labelKey === winningKey;
            });

            const uniqueLabels = Array.from(new Set(dedupedContactLabels));
            if (uniqueLabels.length !== contactLabels.length) {
              await this.updateContactLabels(accountId, contact.chatwootContactId, uniqueLabels);
              logger.info('[SyncContacts] Normalized contact stage labels', {
                contactId: contact.id,
                chatwootContactId: contact.chatwootContactId,
                before: contactLabels,
                after: uniqueLabels,
                winningLabel: resolvedFromContact.label,
              });
            }
          }
        }
      } catch (err) {
        logger.debug('[SyncContacts] Failed to fetch contact labels', {
          chatwootContactId: sender.id,
          error: (err as any)?.message,
        });
      }

      if (!resolvedTagId) {
        for (const conv of sortedConvs) {
          const labels: string[] = Array.isArray(conv.labels) ? conv.labels : [];
          const resolvedFromConversation = resolveLatestStageTagFromLabels(labels, stageTagCandidates);
          if (!resolvedFromConversation.tag) continue;

          resolvedTagId = resolvedFromConversation.tag.id;
          resolvedLabel = resolvedFromConversation.label;
          resolvedSource = 'conversation';
          resolvedConvId = conv.id;
          resolvedStageMatches = resolvedFromConversation.matchCount;
          break;
        }
      }

      if (resolvedTagId) {
        const currentStageTag = await prisma.leadTag.findFirst({
          where: { contactId: contact.id, tag: { type: 'stage' } },
          select: { tagId: true },
        });

        if (currentStageTag?.tagId !== resolvedTagId) {
          await prisma.leadTag.deleteMany({
            where: { contactId: contact.id, tag: { type: 'stage' } },
          });
          await prisma.leadTag.create({
            data: {
              contactId: contact.id,
              tagId: resolvedTagId,
              appliedByType: 'system',
              source: 'chatwoot',
            },
          });
          leadTagsApplied++;
          logger.info('[SyncContacts] Stage updated from Chatwoot', {
            contactId: contact.id,
            chatwootContactId: sender.id,
            conversationId: resolvedConvId,
            label: resolvedLabel,
            newStageTagId: resolvedTagId,
            source: resolvedSource,
            matchedStageLabels: resolvedStageMatches,
            totalConversations: sortedConvs.length,
          });
        }
      }
    }

    // Delete orphan contacts (created > 5 min ago, not seen in Chatwoot)
    if (seenChatwootContactIds.size > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const orphans = await prisma.contact.findMany({
        where: {
          accountId,
          chatwootContactId: { notIn: Array.from(seenChatwootContactIds) },
          createdAt: { lt: fiveMinAgo },
        },
        select: { id: true },
      });

      for (const orphan of orphans) {
        // Only delete if no sales
        const salesCount = await prisma.sale.count({ where: { contactId: orphan.id } });
        if (salesCount === 0) {
          await prisma.contact.delete({ where: { id: orphan.id } });
          deleted++;
        }
      }
    }

    logger.info('[SyncContacts] Completed', { accountId, created, updated, deleted, leadTagsApplied });

    return {
      contacts_created: created,
      contacts_updated: updated,
      contacts_deleted: deleted,
      lead_tags_applied: leadTagsApplied,
    };
  }
}

export const chatwootService = new ChatwootService();
