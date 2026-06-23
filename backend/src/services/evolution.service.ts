import { prisma } from '../config/database';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

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
}

export interface SendMediaInput {
  number: string;
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'document';
  caption?: string;
  fileName?: string;
}

export interface SendAudioInput {
  number: string;
  audioUrl: string;
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

class EvolutionService {
  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Get account with Evolution API configuration
   */
  private async getAccountConfig(accountId: string): Promise<EvolutionConfig> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        evolutionBaseUrl: true,
        evolutionApiKey: true,
        evolutionInstance: true,
      },
    });

    if (!account || !account.evolutionBaseUrl || !account.evolutionApiKey || !account.evolutionInstance) {
      throw new ValidationError(`Configuração Evolution incompleta para conta ${accountId}`);
    }

    return {
      baseUrl: account.evolutionBaseUrl.replace(/\/$/, ''),
      apiKey: account.evolutionApiKey,
      instance: account.evolutionInstance,
    };
  }

  /**
   * Normalize phone number: keep only digits.
   * Expected to already include country code (55 + DDD + number for BR).
   */
  private normalizeNumber(number: string): string {
    return (number || '').replace(/\D+/g, '');
  }

  /**
   * Make authenticated request to Evolution API
   */
  private async makeRequest<T>(
    config: EvolutionConfig,
    path: string,
    options: RequestInit = {}
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
      });
    } catch (error) {
      logger.error('Evolution Request Failed', { url, error });
      throw new Error(
        `Falha na comunicação com Evolution API: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    const text = await response.text();

    if (!response.ok) {
      logger.error('Evolution API Error', {
        url,
        status: response.status,
        body: text,
      });
      throw new Error(`Evolution API error ${response.status}: ${text}`);
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
    const config = await this.getAccountConfig(accountId);
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
    const config = await this.getAccountConfig(accountId);
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
      }
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
    const config = await this.getAccountConfig(accountId);
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
      }
    );

    const messageId = this.extractMessageId(raw);
    logger.info('Evolution sendAudio ok', { accountId, number, messageId });

    return { messageId, raw };
  }

  // ============================================
  // Instance / Connection
  // ============================================

  /**
   * Get connection state of the Evolution instance
   */
  async getStatus(accountId: string): Promise<StatusResult> {
    const config = await this.getAccountConfig(accountId);

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
   * Get pairing QR code / pairing code for the Evolution instance
   */
  async getQrCode(accountId: string): Promise<QrCodeResult> {
    const config = await this.getAccountConfig(accountId);

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

    return {
      qrcodeBase64: typeof qrcodeBase64 === 'string' ? qrcodeBase64 : undefined,
      code: typeof code === 'string' ? code : undefined,
      raw,
    };
  }

  /**
   * Disconnect / logout the Evolution instance
   */
  async disconnect(accountId: string): Promise<DisconnectResult> {
    const config = await this.getAccountConfig(accountId);

    const raw = await this.makeRequest<any>(
      config,
      `/instance/logout/${encodeURIComponent(config.instance)}`,
      { method: 'DELETE' }
    );

    const ok = Boolean(
      raw?.status === 'SUCCESS' ||
        raw?.success === true ||
        raw?.error === false ||
        raw?.ok === true ||
        raw === ''
    );

    logger.info('Evolution disconnect', { accountId, ok });

    return { ok, raw };
  }
}

export const evolutionService = new EvolutionService();
