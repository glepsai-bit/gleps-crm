import { prisma } from '../config/database';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { systemSettingsService } from './system-settings.service';

// ============================================
// Types
// ============================================

interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export type EvolutionConnectionState = 'open' | 'connecting' | 'close' | 'unknown';

export interface SendTextInput {
  number: string;
  text: string;
  delay?: number;
  /**
   * Override per-Inbox: nome da instância Evolution a usar para este send.
   * Quando ausente, cai no legacy Account.evolutionInstance (campanhas e
   * prospecção ainda não migradas para per-Inbox).
   */
  instance?: string | null;
}

export interface SendMediaInput {
  number: string;
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'document';
  caption?: string;
  fileName?: string;
  instance?: string | null;
}

export interface SendAudioInput {
  number: string;
  audioUrl: string;
  instance?: string | null;
}

export interface SendStickerInput {
  number: string;
  /** base64 (sem prefixo data:) OU URL http(s) — Evolution aceita ambos */
  sticker: string;
  instance?: string | null;
}

export interface SendReactionInput {
  number: string;
  /** Emoji unicode (ex: '👍') */
  reaction: string;
  /** evolutionMsgId da mensagem que sera reagida */
  reactionToMsgId: string;
  /** fromMe da mensagem original (default false — assumindo reacao na msg do peer) */
  fromMe?: boolean;
  instance?: string | null;
}

export interface SendResult {
  messageId: string;
  raw: any;
}

export interface StatusResult {
  state: EvolutionConnectionState;
  raw: any;
}

export interface QrCodeResult {
  qrcodeBase64?: string;
  code?: string;
  raw: any;
}

export interface DisconnectResult {
  ok: boolean;
  raw: any;
}

export interface CreateInstanceInput {
  instance: string;
  webhookUrl?: string | null;
  /**
   * Token compartilhado enviado pelo webhook como header `x-crm-webhook-token`,
   * usado para autenticar callbacks da Evolution no nosso endpoint.
   */
  webhookAuthToken?: string | null;
}

export interface CreateInstanceResult {
  qrcodeBase64?: string;
  code?: string;
  raw: any;
}

export interface SetWebhookInput {
  url: string;
  events?: string[];
  byEvents?: boolean;
  base64?: boolean;
  /**
   * Token compartilhado enviado pelo webhook como header `x-crm-webhook-token`,
   * usado para autenticar callbacks da Evolution no nosso endpoint.
   */
  authToken?: string | null;
}

export interface SetWebhookResult {
  ok: boolean;
  raw: any;
}

export const DEFAULT_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'CONTACTS_UPDATE',
  'SEND_MESSAGE',
];

class EvolutionService {
  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Resolve Evolution API configuration para uma conta.
   *
   * Modelo correto (refactor pós-Sprint 4):
   *   - Super Admin configura URL+Key GLOBAIS em SystemSettings (1 vez).
   *   - Cada Inbox da conta carrega seu próprio `evolutionInstance` (escaneado via QR).
   *   - O nome da instância continua sendo lido do Account (campo `evolutionInstance`)
   *     para preservar a assinatura externa do adapter; callers que operam por Inbox
   *     devem ser migrados em sprint dedicado.
   *
   * Resolução de credenciais (baseUrl + apiKey):
   *   1. Se a Account tem ambos `evolutionBaseUrl` + `evolutionApiKey` preenchidos,
   *      usa o override per-account (enterprise).
   *   2. Senão, usa o singleton global de SystemSettings.
   *   3. Senão, lança ValidationError pedindo configuração global.
   */
  private async getAccountConfig(
    accountId: string,
    instanceOverride?: string | null
  ): Promise<EvolutionConfig> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        evolutionBaseUrl: true,
        evolutionApiKey: true,
        evolutionInstance: true,
      },
    });

    if (!account) {
      throw new ValidationError(`Conta ${accountId} não encontrada`);
    }

    // Modelo per-Inbox: callers que operam sobre um Inbox específico passam o
    // `instanceOverride` (campo Inbox.evolutionInstance). Quando ausente,
    // caímos no legacy account.evolutionInstance pra manter compat com sends
    // antigos (campanhas, prospecção) ainda não migrados pra per-Inbox.
    const instance = instanceOverride ?? account.evolutionInstance ?? null;

    if (!instance) {
      throw new ValidationError(
        `Conta ${accountId} sem instância Evolution (passe instanceOverride ou configure Account.evolutionInstance)`
      );
    }

    // 1) Override per-account: ambos campos preenchidos.
    const hasAccountOverride = Boolean(account.evolutionBaseUrl && account.evolutionApiKey);

    if (hasAccountOverride) {
      return {
        baseUrl: account.evolutionBaseUrl!.replace(/\/$/, ''),
        apiKey: account.evolutionApiKey!,
        instance,
      };
    }

    // 2) Global singleton de SystemSettings.
    const globalConfig = await systemSettingsService.getEvolutionConfig();

    if (globalConfig) {
      return {
        baseUrl: globalConfig.baseUrl.replace(/\/$/, ''),
        apiKey: globalConfig.apiKey,
        instance,
      };
    }

    // 3) Nenhuma configuração disponível.
    throw new ValidationError(
      'Evolution não configurado: super-admin precisa preencher URL+Key globalmente em /super-admin/system-settings'
    );
  }

  /**
   * Normalize phone number: keep only digits.
   * Expected to already include country code (55 + DDD + number for BR).
   *
   * Validation rules:
   * - length < 10 ou > 15: inválido
   * - length === 11 (BR sem código país, ex: 11999998888): prefixa '55'
   * - length === 10 (BR sem 9, ex: 1133334444): inválido — exige formato 55DDDNNNNN com 9
   */
  private normalizeNumber(number: string): string {
    const digits = (number || '').replace(/\D+/g, '');

    if (digits.length < 10 || digits.length > 15) {
      throw new ValidationError(
        `Telefone inválido — comprimento ${digits.length} fora do intervalo permitido (10-15)`
      );
    }

    if (digits.length === 10) {
      throw new ValidationError(
        'Telefone inválido — esperado formato 55DDDNNNNN com 9'
      );
    }

    if (digits.length === 11) {
      return `55${digits}`;
    }

    return digits;
  }

  /**
   * Make authenticated request to Evolution API.
   *
   * `timeoutMs` permite ajustar o timeout por tipo de chamada:
   * - sendText/getStatus/getQrCode/disconnect → 15s (default)
   * - sendMedia/sendAudio → 60s (base64 grande pode estourar 15s)
   */
  private async makeRequest<T>(
    config: EvolutionConfig,
    path: string,
    options: RequestInit = {},
    timeoutMs: number = 15000
  ): Promise<T> {
    const url = `${config.baseUrl}${path}`;

    const baseHeaders: Record<string, string> = {
      apikey: config.apiKey,
      'Content-Type': 'application/json',
    };

    if (options.headers) {
      const h = options.headers as Record<string, string>;
      Object.assign(baseHeaders, h);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: baseHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger.error('Evolution Request Failed', { url, error });
      throw new Error(
        `Falha na comunicação com Evolution API: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    const text = await response.text();

    if (!response.ok) {
      // BUG-024: não propagar body cru no erro lançado.
      // Log completo (truncado a 200 chars) fica no logger; mensagem do erro só leva o status.
      logger.error('Evolution API Error', {
        url,
        status: response.status,
        body: (text || '').slice(0, 200),
      });
      throw new Error(`Evolution API retornou status ${response.status}`);
    }

    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // Some endpoints might return non-JSON; preserve as raw text
      return text as unknown as T;
    }
  }

  /**
   * Try to extract a stable messageId from the various shapes the
   * Evolution API may return.
   */
  private extractMessageId(raw: any): string {
    if (!raw || typeof raw !== 'object') return '';
    return (
      raw?.key?.id ||
      raw?.messageId ||
      raw?.message?.key?.id ||
      raw?.data?.key?.id ||
      raw?.id ||
      ''
    );
  }

  // ============================================
  // Messaging
  // ============================================

  /**
   * Send a plain text WhatsApp message via Evolution API
   */
  async sendText(accountId: string, input: SendTextInput): Promise<SendResult> {
    if (!input.text || input.text.trim() === '') {
      throw new ValidationError('text é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      text: input.text,
    };

    if (typeof input.delay === 'number') {
      body.delay = input.delay;
    }

    const raw = await this.makeRequest<any>(
      config,
      `/message/sendText/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendText ok', { accountId, number, messageId });

    return { messageId, raw };
  }

  /**
   * Send a media message (image, video, document) via Evolution API.
   * `mediaUrl` may be a public URL or a base64-encoded payload.
   */
  async sendMedia(accountId: string, input: SendMediaInput): Promise<SendResult> {
    if (!input.mediaUrl) {
      throw new ValidationError('mediaUrl é obrigatório');
    }
    if (
      !/^https?:\/\//i.test(input.mediaUrl) &&
      !/^data:/i.test(input.mediaUrl)
    ) {
      throw new ValidationError(
        'mediaUrl inválido — esperado http(s):// ou data:'
      );
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      mediatype: input.mediaType,
      media: input.mediaUrl,
    };

    if (input.caption) {
      body.caption = input.caption;
    }

    if (input.fileName) {
      body.fileName = input.fileName;
    }

    const raw = await this.makeRequest<any>(
      config,
      `/message/sendMedia/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      60000
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendMedia ok', {
      accountId,
      number,
      mediaType: input.mediaType,
      messageId,
    });

    return { messageId, raw };
  }

  /**
   * Send a WhatsApp audio message (PTT-style) via Evolution API.
   * `audioUrl` may be a public URL or base64-encoded payload.
   */
  async sendAudio(accountId: string, input: SendAudioInput): Promise<SendResult> {
    if (!input.audioUrl) {
      throw new ValidationError('audioUrl é obrigatório');
    }
    if (
      !/^https?:\/\//i.test(input.audioUrl) &&
      !/^data:/i.test(input.audioUrl)
    ) {
      throw new ValidationError(
        'audioUrl inválido — esperado http(s):// ou data:'
      );
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      audio: input.audioUrl,
    };

    const raw = await this.makeRequest<any>(
      config,
      `/message/sendWhatsAppAudio/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      60000
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendAudio ok', { accountId, number, messageId });

    return { messageId, raw };
  }

  /**
   * Send a WhatsApp sticker (WEBP <500KB) via Evolution API.
   * `sticker` may be a public URL (http(s)://...), a data URL (data:image/webp;base64,...)
   * ou base64 puro (sem prefixo).
   */
  async sendSticker(accountId: string, input: SendStickerInput): Promise<SendResult> {
    if (!input.sticker) {
      throw new ValidationError('sticker é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      sticker: input.sticker,
    };

    const raw = await this.makeRequest<any>(
      config,
      `/message/sendSticker/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      60000
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendSticker ok', { accountId, number, messageId });

    return { messageId, raw };
  }

  /**
   * Reage a uma mensagem existente com um emoji.
   * Evolution endpoint: POST /message/sendReaction/:instance
   *   body { reactionMessage: { key: { remoteJid, fromMe, id }, reaction: '<emoji>' } }
   *
   * `reactionToMsgId` = evolutionMsgId da msg que sera reagida (lookup em
   * WarmupMessage.evolutionMsgId pelo caller).
   */
  async sendReaction(accountId: string, input: SendReactionInput): Promise<SendResult> {
    if (!input.reaction) {
      throw new ValidationError('reaction é obrigatório');
    }
    if (!input.reactionToMsgId) {
      throw new ValidationError('reactionToMsgId é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    // Evolution espera remoteJid no formato '<digits>@s.whatsapp.net'
    const remoteJid = `${number}@s.whatsapp.net`;

    const body: Record<string, any> = {
      reactionMessage: {
        key: {
          remoteJid,
          fromMe: input.fromMe ?? false,
          id: input.reactionToMsgId,
        },
        reaction: input.reaction,
      },
    };

    const raw = await this.makeRequest<any>(
      config,
      `/message/sendReaction/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendReaction ok', { accountId, number, messageId });

    return { messageId, raw };
  }

  // ============================================
  // Instance / Connection
  // ============================================

  /**
   * Get connection state of the Evolution instance.
   * `instanceOverride` permite consultar uma instance específica de um Inbox
   * (novo modelo per-Inbox); sem ele, usa Account.evolutionInstance (legacy).
   */
  async getStatus(
    accountId: string,
    instanceOverride?: string | null
  ): Promise<StatusResult> {
    const config = await this.getAccountConfig(accountId, instanceOverride);

    const raw = await this.makeRequest<any>(
      config,
      `/instance/connectionState/${encodeURIComponent(config.instance)}`,
      { method: 'GET' }
    );

    const rawState =
      raw?.instance?.state ||
      raw?.state ||
      raw?.data?.state ||
      raw?.status ||
      'unknown';

    const allowed: EvolutionConnectionState[] = ['open', 'connecting', 'close'];
    const state: EvolutionConnectionState = allowed.includes(rawState as EvolutionConnectionState)
      ? (rawState as EvolutionConnectionState)
      : 'unknown';

    return { state, raw };
  }

  /**
   * Get pairing QR code / pairing code for the Evolution instance.
   * `instanceOverride` permite consultar uma instance específica de um Inbox.
   */
  async getQrCode(
    accountId: string,
    instanceOverride?: string | null
  ): Promise<QrCodeResult> {
    const config = await this.getAccountConfig(accountId, instanceOverride);

    const raw = await this.makeRequest<any>(
      config,
      `/instance/connect/${encodeURIComponent(config.instance)}`,
      { method: 'GET' }
    );

    const qrcodeBase64: string | undefined =
      raw?.qrcode?.base64 ||
      raw?.base64 ||
      raw?.qrcode ||
      raw?.data?.qrcode?.base64;

    const code: string | undefined =
      raw?.code ||
      raw?.qrcode?.code ||
      raw?.pairingCode ||
      raw?.data?.code;

    const normalizedQr = typeof qrcodeBase64 === 'string' ? qrcodeBase64 : undefined;
    const normalizedCode = typeof code === 'string' ? code : undefined;

    // BUG-057: se ambos vierem undefined mas o raw tem dados, falhar explicitamente
    // ao invés de devolver um QrCodeResult vazio que confunde o caller.
    if (!normalizedQr && !normalizedCode) {
      const hasRawPayload =
        raw !== undefined &&
        raw !== null &&
        !(typeof raw === 'object' && Object.keys(raw).length === 0) &&
        !(typeof raw === 'string' && raw.length === 0);

      if (hasRawPayload) {
        throw new Error(
          `Evolution não retornou QR code nem code; resposta: ${JSON.stringify(raw).slice(0, 200)}`
        );
      }
    }

    return {
      qrcodeBase64: normalizedQr,
      code: normalizedCode,
      raw,
    };
  }

  /**
   * Disconnect / logout the Evolution instance.
   * `instanceOverride` permite deslogar uma instance específica de um Inbox.
   */
  async disconnect(
    accountId: string,
    instanceOverride?: string | null
  ): Promise<DisconnectResult> {
    const config = await this.getAccountConfig(accountId, instanceOverride);

    // makeRequest já lança em HTTP não-2xx, então chegar aqui implica 2xx.
    // Default ok=true; só negamos se houver marcador explícito de erro no corpo.
    const raw = await this.makeRequest<any>(
      config,
      `/instance/logout/${encodeURIComponent(config.instance)}`,
      { method: 'DELETE' }
    );

    let ok = true;
    if (raw && typeof raw === 'object') {
      const hasError =
        (raw.error !== undefined && raw.error !== false && raw.error !== null) ||
        raw.success === false ||
        raw.ok === false;
      if (hasError) {
        ok = false;
      }
    }

    logger.info('Evolution disconnect', { accountId, ok });

    return { ok, raw };
  }

  /**
   * Cria uma nova instance Evolution. Idempotente do lado do CRM:
   * o caller (inboxChannelService.ensureEvolutionInstance) é responsável
   * por checar se já existe antes de chamar — aqui apenas executamos o POST.
   *
   * Resolve URL+Key via SystemSettings (global) ou Account override (fallback),
   * usando o mesmo getAccountConfig com `instanceOverride` passando a instance nova.
   *
   * Evolution responde já com o QR code no body do create, então devolvemos
   * `qrcodeBase64` + `code` quando disponíveis.
   */
  async createInstance(
    accountId: string,
    input: CreateInstanceInput
  ): Promise<CreateInstanceResult> {
    if (!input.instance || input.instance.trim() === '') {
      throw new ValidationError('instance é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);

    const body: Record<string, any> = {
      instanceName: input.instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    };

    if (input.webhookUrl) {
      body.webhook = {
        enabled: true,
        url: input.webhookUrl,
        byEvents: false,
        base64: false,
        events: [
          'MESSAGES_UPSERT',
          'MESSAGES_UPDATE',
          'CONNECTION_UPDATE',
          'CONTACTS_UPDATE',
          'SEND_MESSAGE',
        ],
        headers: input.webhookAuthToken
          ? { 'x-crm-webhook-token': input.webhookAuthToken }
          : undefined,
      };
    }

    const raw = await this.makeRequest<any>(
      config,
      `/instance/create`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    const qrcodeBase64: string | undefined =
      raw?.qrcode?.base64 ||
      raw?.base64 ||
      raw?.instance?.qrcode?.base64 ||
      raw?.data?.qrcode?.base64;

    const code: string | undefined =
      raw?.qrcode?.code ||
      raw?.code ||
      raw?.pairingCode ||
      raw?.data?.code;

    const normalizedQr = typeof qrcodeBase64 === 'string' ? qrcodeBase64 : undefined;
    const normalizedCode = typeof code === 'string' ? code : undefined;

    logger.info('Evolution createInstance ok', {
      accountId,
      instance: input.instance,
      hasQrcode: Boolean(normalizedQr),
      hasCode: Boolean(normalizedCode),
    });

    return {
      qrcodeBase64: normalizedQr,
      code: normalizedCode,
      raw,
    };
  }

  /**
   * Configura (ou reconfigura) o webhook de uma instance Evolution.
   * Idempotente: o endpoint POST /webhook/set/{instance} sobrescreve a config
   * existente, então pode ser chamado tanto no create quanto em healthcheck/reconnect.
   *
   * Falhas aqui NÃO devem derrubar o fluxo principal (create/connect) — o caller
   * deve capturar e logar warning, garantindo que QR code volte pro usuário mesmo
   * que a configuração de webhook tenha falhado (será re-tentada no próximo healthcheck).
   */
  async setWebhook(
    accountId: string,
    instance: string,
    input: SetWebhookInput
  ): Promise<SetWebhookResult> {
    if (!instance || instance.trim() === '') {
      throw new ValidationError('instance é obrigatório');
    }
    if (!input.url || input.url.trim() === '') {
      throw new ValidationError('webhook url é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, instance);

    const body = {
      webhook: {
        enabled: true,
        url: input.url,
        byEvents: input.byEvents ?? false,
        base64: input.base64 ?? false,
        events: input.events ?? DEFAULT_WEBHOOK_EVENTS,
        headers: input.authToken
          ? { 'x-crm-webhook-token': input.authToken }
          : undefined,
      },
    };

    const raw = await this.makeRequest<any>(
      config,
      `/webhook/set/${encodeURIComponent(instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    let ok = true;
    if (raw && typeof raw === 'object') {
      const hasError =
        (raw.error !== undefined && raw.error !== false && raw.error !== null) ||
        raw.success === false ||
        raw.ok === false;
      if (hasError) ok = false;
    }

    logger.info('Evolution setWebhook', {
      accountId,
      instance,
      url: input.url,
      ok,
    });

    return { ok, raw };
  }
}

export const evolutionService = new EvolutionService();
