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
  /** mimetype explícito — usado quando media é base64 puro (Evolution exige). */
  mimeType?: string | null;
  instance?: string | null;
}

export interface SendAudioInput {
  number: string;
  audioUrl: string;
  instance?: string | null;
}

/**
 * Envio de texto citando (reply nativo do WhatsApp) uma msg anterior.
 * `quotedKey` identifica a msg citada; `quotedText` é o trecho de fallback
 * que aparece no bubble de quote quando a Evolution não consegue rehidratar
 * o conteúdo original a partir do id.
 */
export interface SendTextWithQuoteInput {
  number: string;
  text: string;
  quotedKey: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
  };
  quotedText?: string;
  delay?: number;
  instance?: string | null;
}

/**
 * Edição de mensagem outbound existente. Só faz sentido para msgs próprias
 * (fromMe=true, default). A janela de 15 min do WhatsApp é validada no caller
 * (message.service), não aqui.
 */
export interface UpdateMessageInput {
  number: string;
  keyId: string;
  remoteJid?: string;
  fromMe?: boolean;
  text: string;
  instance?: string | null;
}

/**
 * Delete-for-everyone (revoke) de uma msg WhatsApp.
 * Requer `keyId` + (`remoteJid` OU `number` para derivar remoteJid).
 * `participant` é usado apenas em grupos (jid do autor original).
 */
export interface DeleteMessageInput {
  keyId: string;
  remoteJid?: string;
  number?: string;
  fromMe?: boolean;
  participant?: string;
  instance?: string | null;
}

export interface DeleteMessageResult {
  ok: boolean;
  raw: any;
}

/**
 * Envio de audio PTT (push-to-talk) via /message/sendWhatsAppAudio.
 * Diferente de `SendAudioInput` (que aceita URL), aqui é sempre base64 puro
 * (sem prefixo data:) e força `encoding: true` para renderizar como bubble
 * de áudio nativo no cliente.
 */
export interface SendWhatsAppAudioInput {
  number: string;
  audioBase64: string;
  delay?: number;
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
  /**
   * AUDIT-REACTION-JID: JID real da conversa (metadata.remoteJid do webhook).
   * Quando presente, tem prioridade sobre o derivado de `number` — números BR
   * com/sem o 9 divergem do JID e o WhatsApp não localiza a msg alvo.
   */
  remoteJid?: string | null;
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

    // FIX-SEND-MEDIA: a Evolution v2 espera no campo `media` uma URL http(s)
    // pública OU base64 PURO. Uma data URL completa (`data:mime;base64,XXXX`)
    // era rejeitada — por isso documentos/mídia inline (anexos <=5MB do
    // composer viram data URL) falhavam com o ícone de erro e nunca chegavam
    // ao WhatsApp. Aqui extraímos o base64 puro e o mimetype do data URL.
    let media = input.mediaUrl;
    let mimetype: string | null = input.mimeType ?? null;
    if (/^data:/i.test(input.mediaUrl)) {
      const comma = input.mediaUrl.indexOf(',');
      const header = input.mediaUrl.slice(5, comma); // sem 'data:'
      const mimeFromHeader = header.split(';')[0]?.trim();
      if (mimeFromHeader) mimetype = mimeFromHeader;
      media = input.mediaUrl.slice(comma + 1); // base64 puro
    }

    const body: Record<string, any> = {
      number,
      mediatype: input.mediaType,
      media,
    };

    // Documento no WhatsApp precisa de mimetype pra abrir com o app certo.
    if (mimetype) {
      body.mimetype = mimetype;
    }

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
   * Envia texto citando (reply nativo do WhatsApp) uma mensagem anterior.
   * Evolution endpoint: POST /message/sendText/:instance
   *   body { number, text, quoted: { key: { id, remoteJid, fromMe }, message: { conversation } }, delay? }
   *
   * O caller deve montar `quotedKey` a partir de `Message.externalId` +
   * `Message.externalMetadata` (participant/remoteJid/fromMe capturados no webhook
   * MESSAGES_UPSERT). Para msg citada do próprio agente, `quotedKey.fromMe=true`.
   */
  async sendTextWithQuote(
    accountId: string,
    input: SendTextWithQuoteInput
  ): Promise<SendResult> {
    if (!input.text || input.text.trim() === '') {
      throw new ValidationError('text é obrigatório');
    }
    if (!input.quotedKey || !input.quotedKey.id) {
      throw new ValidationError('quotedKey.id é obrigatório');
    }
    if (!input.quotedKey.remoteJid) {
      throw new ValidationError('quotedKey.remoteJid é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      text: input.text,
      quoted: {
        key: {
          id: input.quotedKey.id,
          remoteJid: input.quotedKey.remoteJid,
          fromMe: input.quotedKey.fromMe,
        },
        message: {
          conversation: input.quotedText ?? '',
        },
      },
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
    logger.info('Evolution sendTextWithQuote ok', {
      accountId,
      number,
      messageId,
      quotedId: input.quotedKey.id,
    });

    return { messageId, raw };
  }

  /**
   * Edita o conteúdo textual de uma mensagem outbound previamente enviada.
   * Evolution endpoint: POST /message/updateMessage/:instance
   *   body { number, key: { id, remoteJid, fromMe }, text }
   *
   * WhatsApp permite edição até ~15 min após o envio — essa regra fica no
   * message.service (caller), não aqui. O `messageId` retornado é o próprio
   * `keyId` de entrada (edit não gera novo id).
   */
  async updateMessage(
    accountId: string,
    input: UpdateMessageInput
  ): Promise<SendResult> {
    if (!input.keyId) {
      throw new ValidationError('keyId é obrigatório');
    }
    if (!input.text || input.text.trim() === '') {
      throw new ValidationError('text é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);
    const remoteJid = input.remoteJid || `${number}@s.whatsapp.net`;

    const body: Record<string, any> = {
      number,
      key: {
        id: input.keyId,
        remoteJid,
        fromMe: input.fromMe ?? true,
      },
      text: input.text,
    };

    const raw = await this.makeRequest<any>(
      config,
      `/message/updateMessage/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    const messageId = this.extractMessageId(raw) || input.keyId;
    logger.info('Evolution updateMessage ok', {
      accountId,
      number,
      messageId,
    });

    return { messageId, raw };
  }

  /**
   * Revoga (delete-for-everyone) uma mensagem WhatsApp para todos os participantes.
   * Evolution endpoint: DELETE /chat/deleteMessageForEveryone/:instance
   *   body { id, remoteJid, fromMe, participant? }
   *
   * Diferente dos outros métodos, o path é `/chat/...` (não `/message/...`).
   * O caller (message.service) deve fazer o soft delete local (content=NULL,
   * deletedAt=now) antes ou depois de chamar este método.
   */
  async deleteMessageForEveryone(
    accountId: string,
    input: DeleteMessageInput
  ): Promise<DeleteMessageResult> {
    if (!input.keyId) {
      throw new ValidationError('keyId é obrigatório');
    }
    if (!input.remoteJid && !input.number) {
      throw new ValidationError('remoteJid ou number é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const remoteJid =
      input.remoteJid ||
      `${this.normalizeNumber(input.number!)}@s.whatsapp.net`;

    const body: Record<string, any> = {
      id: input.keyId,
      remoteJid,
      fromMe: input.fromMe ?? true,
    };

    if (input.participant) {
      body.participant = input.participant;
    }

    const raw = await this.makeRequest<any>(
      config,
      `/chat/deleteMessageForEveryone/${encodeURIComponent(config.instance)}`,
      {
        method: 'DELETE',
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

    logger.info('Evolution deleteMessageForEveryone ok', {
      accountId,
      remoteJid,
      keyId: input.keyId,
      ok,
    });

    return { ok, raw };
  }

  /**
   * Envia áudio PTT (push-to-talk) via /message/sendWhatsAppAudio.
   *
   * Coexiste com `sendAudio` (que aceita URL http(s) ou data:); esta variante
   * é otimizada para o fluxo Mic-Recording do agente: recebe base64 puro
   * (sem prefixo `data:`) e força `encoding: true` para o WhatsApp renderizar
   * como bubble de áudio nativo (com waveform + play). Aceita `delay` opcional.
   */
  async sendWhatsAppAudio(
    accountId: string,
    input: SendWhatsAppAudioInput
  ): Promise<SendResult> {
    if (!input.audioBase64) {
      throw new ValidationError('audioBase64 é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    const body: Record<string, any> = {
      number,
      audio: input.audioBase64,
      encoding: true,
    };

    if (typeof input.delay === 'number') {
      body.delay = input.delay;
    }

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
    logger.info('Evolution sendWhatsAppAudio ok', {
      accountId,
      number,
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
    // reaction === '' é válido — WhatsApp interpreta como REMOÇÃO da reaction
    // anterior. Só bloqueamos `undefined` / `null` (payload malformado).
    if (input.reaction === undefined || input.reaction === null) {
      throw new ValidationError('reaction é obrigatório');
    }
    if (!input.reactionToMsgId) {
      throw new ValidationError('reactionToMsgId é obrigatório');
    }

    const config = await this.getAccountConfig(accountId, input.instance);
    const number = this.normalizeNumber(input.number);

    // Evolution espera remoteJid no formato '<digits>@s.whatsapp.net'.
    // AUDIT-REACTION-JID: preferir o JID real vindo do webhook quando houver.
    const remoteJid =
      input.remoteJid && input.remoteJid.includes('@')
        ? input.remoteJid
        : `${number}@s.whatsapp.net`;

    // AUDIT-REACTION-V2: a Evolution v2 espera { key, reaction } no TOPO do
    // body (mesmo padrão dos demais endpoints v2 já usados aqui: sendText
    // { number, text } etc.). O wrapper `reactionMessage` era formato v1 —
    // a v2 respondia 400 e a reação nunca chegava ao WhatsApp (o erro era
    // engolido como best-effort no service).
    const body: Record<string, any> = {
      key: {
        remoteJid,
        fromMe: input.fromMe ?? false,
        id: input.reactionToMsgId,
      },
      reaction: input.reaction,
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
   * Número WhatsApp conectado da instância, em E.164 (com +). O
   * `connectionState` só devolve o estado; o dono/número vem do
   * `fetchInstances`. Retorna null se a instância não estiver pareada ou a
   * Evolution não expuser o número (a extração é defensiva — shapes variam
   * entre versões).
   */
  async getConnectedNumber(
    accountId: string,
    instanceOverride?: string | null
  ): Promise<string | null> {
    const config = await this.getAccountConfig(accountId, instanceOverride);
    const raw = await this.makeRequest<any>(
      config,
      `/instance/fetchInstances?instanceName=${encodeURIComponent(config.instance)}`,
      { method: 'GET' }
    );
    return extractConnectedNumber(raw, config.instance);
  }

  /**
   * Baixa mídia de uma mensagem WhatsApp descriptografando via Evolution.
   *
   * Bug áudio (2026-07-03): o backend estava fazendo GET direto no `sourceUrl`
   * do webhook — que aponta pra `https://mmg.whatsapp.net/.../file.enc`. Esse
   * arquivo é end-to-end encrypted; o download bruto retorna bytes cifrados
   * (magic `89 64 9b b4` em vez de `4F 67 67 53` = `OggS`). O `<audio>` do
   * browser falha com `DEMUXER_ERROR_COULD_NOT_OPEN`.
   *
   * A rota `chat/getBase64FromMediaMessage/:instance` da Evolution API pega a
   * mediaKey guardada internamente pela instância (Baileys) e devolve o
   * conteúdo já descriptografado em base64. Só precisamos do `key.id` da
   * mensagem original — o resto (remoteJid, fromMe, mediaKey) a Evolution
   * recupera do próprio store.
   *
   * Retorna null se a Evolution não conseguir localizar a mensagem (ex: chip
   * foi reconectado depois e Baileys perdeu o store); nesse caso caímos no
   * fetch direto (que pelo menos preserva os bytes cifrados pra debug).
   */
  async getBase64FromMediaMessage(
    accountId: string,
    input: { instance?: string | null; messageKeyId: string; convertToMp4?: boolean }
  ): Promise<{ base64: string; mimetype?: string | null } | null> {
    if (!input.messageKeyId) {
      throw new ValidationError('messageKeyId é obrigatório');
    }
    const config = await this.getAccountConfig(accountId, input.instance);
    try {
      const raw = await this.makeRequest<any>(
        config,
        `/chat/getBase64FromMediaMessage/${encodeURIComponent(config.instance)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            message: { key: { id: input.messageKeyId } },
            convertToMp4: input.convertToMp4 === true,
          }),
        },
        // FIX-VIDEO-TIMEOUT: descriptografar e trafegar a mídia como base64 pode
        // passar MUITO dos 15s padrão em vídeo grande (.mp4/.mov de 20MB+ viram
        // ~27MB de base64) — era a causa de vídeo virar storageStatus='failed'
        // e sumir do chat enquanto áudio (pequeno) passava. 60s, igual sendMedia.
        60000
      );
      const base64 = raw?.base64 || raw?.data?.base64;
      if (typeof base64 !== 'string' || base64.length === 0) return null;
      const mimetype = raw?.mimetype || raw?.data?.mimetype || null;
      return { base64, mimetype };
    } catch (err) {
      logger.warn('[evolution] getBase64FromMediaMessage falhou', {
        accountId,
        instance: config.instance,
        messageKeyId: input.messageKeyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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

  /**
   * Busca a URL da foto de perfil do WhatsApp Business do contato via
   * POST /chat/fetchProfilePictureUrl/{instance}. Retorna null quando o
   * numero nao tem foto publica ou nao esta no WhatsApp.
   *
   * A URL retornada e do CDN mmg.whatsapp.net e expira em ~5-30 min —
   * quem consome deve saber que precisa refresh periodico (o
   * contact.service faz isso a cada 24h no findOrCreateForCustomer).
   * NAO levanta em erro: log warn + null (contato sem foto e caso comum).
   */
  async fetchProfilePictureUrl(
    accountId: string,
    input: { instance?: string | null; number: string }
  ): Promise<string | null> {
    if (!input.number) return null;
    try {
      const config = await this.getAccountConfig(accountId, input.instance);
      const number = this.normalizeNumber(input.number);
      const raw = await this.makeRequest<any>(
        config,
        `/chat/fetchProfilePictureUrl/${encodeURIComponent(config.instance)}`,
        {
          method: 'POST',
          body: JSON.stringify({ number }),
        }
      );
      const url =
        typeof raw?.profilePictureUrl === 'string' ? raw.profilePictureUrl :
        typeof raw?.url === 'string' ? raw.url :
        typeof raw?.profilePicUrl === 'string' ? raw.profilePicUrl :
        null;
      return url || null;
    } catch (err) {
      logger.warn('[evolution] fetchProfilePictureUrl falhou', {
        accountId,
        number: input.number,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

}

export const evolutionService = new EvolutionService();

/**
 * Extrai o número WhatsApp conectado (E.164 com +) da resposta do
 * `fetchInstances` da Evolution. Defensivo contra as variações de shape entre
 * versões: a resposta pode ser array ou objeto único; o número pode vir como
 * `ownerJid` / `owner` / `number` / `wid`, no nível raiz ou aninhado em
 * `instance`. Retorna null quando nenhum candidato válido é encontrado.
 */
export function extractConnectedNumber(
  raw: unknown,
  instanceName?: string
): string | null {
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw as any] : [];
  const nameOf = (i: any): string | undefined =>
    i?.name ?? i?.instanceName ?? i?.instance?.instanceName ?? i?.instance?.name;
  const pick =
    (instanceName ? list.find((i) => nameOf(i) === instanceName) : undefined) ??
    list[0];
  if (!pick) return null;
  const src = (pick as any).instance ?? pick;
  const candidate =
    src?.ownerJid ??
    src?.owner ??
    src?.number ??
    src?.wid ??
    (pick as any)?.ownerJid ??
    (pick as any)?.owner ??
    (pick as any)?.number ??
    null;
  if (!candidate) return null;
  const digits = String(candidate).replace(/@.*/, '').replace(/\D+/g, '');
  return digits ? `+${digits}` : null;
}
