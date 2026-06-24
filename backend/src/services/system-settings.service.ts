import type { SystemSettings } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

/**
 * SystemSettingsService — gerencia o singleton de configurações globais do sistema.
 *
 * Atualmente armazena as credenciais GLOBAIS da Evolution API (WhatsApp não-oficial)
 * que o Super Admin configura uma única vez. Cada conta (Account) cria seus próprios
 * Inboxes WhatsApp escaneando QR code; o adapter em evolution.service resolve as
 * credenciais usando este singleton, com fallback opcional per-account override.
 *
 * Padrão: classe singleton + cache em memória com TTL de 60s.
 */

const SINGLETON_ID = 'singleton';
const CACHE_TTL_MS = 60_000;

export interface UpdateSystemSettingsInput {
  evolutionBaseUrl?: string | null;
  evolutionApiKey?: string | null;
  evolutionWebhookUrl?: string | null;
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  webhookUrl: string | null;
}

interface CacheEntry {
  value: SystemSettings;
  expiresAt: number;
}

class SystemSettingsService {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Retorna o singleton de SystemSettings. Cria a linha se ainda não existir.
   * Usa cache em memória com TTL de 60s.
   */
  async get(): Promise<SystemSettings> {
    const cached = this.cache.get(SINGLETON_ID);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let settings = await prisma.systemSettings.findUnique({
      where: { id: SINGLETON_ID },
    });

    if (!settings) {
      logger.info('SystemSettings singleton não encontrado, criando');
      settings = await prisma.systemSettings.create({
        data: { id: SINGLETON_ID },
      });
    }

    this.cache.set(SINGLETON_ID, {
      value: settings,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return settings;
  }

  /**
   * Atualiza o singleton de SystemSettings via upsert no id='singleton'.
   * Invalida o cache em memória após o update.
   */
  async update(input: UpdateSystemSettingsInput): Promise<SystemSettings> {
    const data: Record<string, unknown> = {};
    if ('evolutionBaseUrl' in input) data.evolutionBaseUrl = input.evolutionBaseUrl;
    if ('evolutionApiKey' in input) data.evolutionApiKey = input.evolutionApiKey;
    if ('evolutionWebhookUrl' in input) data.evolutionWebhookUrl = input.evolutionWebhookUrl;

    const settings = await prisma.systemSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });

    this.invalidateCache();

    logger.info('SystemSettings atualizado', {
      fields: Object.keys(data),
      hasEvolutionBaseUrl: Boolean(settings.evolutionBaseUrl),
      hasEvolutionApiKey: Boolean(settings.evolutionApiKey),
      hasEvolutionWebhookUrl: Boolean(settings.evolutionWebhookUrl),
    });

    return settings;
  }

  /**
   * Helper para obter as credenciais Evolution prontas para uso pelo adapter.
   * Retorna null se a configuração estiver incompleta (baseUrl ou apiKey ausentes).
   */
  async getEvolutionConfig(): Promise<EvolutionConfig | null> {
    const settings = await this.get();

    if (!settings.evolutionBaseUrl || !settings.evolutionApiKey) {
      return null;
    }

    return {
      baseUrl: settings.evolutionBaseUrl,
      apiKey: settings.evolutionApiKey,
      webhookUrl: settings.evolutionWebhookUrl ?? null,
    };
  }

  /**
   * Limpa o cache em memória. Útil em testes e após mutações externas.
   */
  invalidateCache(): void {
    this.cache.delete(SINGLETON_ID);
  }
}

export const systemSettingsService = new SystemSettingsService();
