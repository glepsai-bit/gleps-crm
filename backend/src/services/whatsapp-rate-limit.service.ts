import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  waitMs?: number;
}

interface RateLimitConfig {
  /** Janela minima entre msgs pro mesmo numero (ms) */
  perPhoneMinIntervalMs: number;
  /** Maximo de msgs pro mesmo numero em 1h */
  perPhoneMaxPerHour: number;
  /** Maximo total de msgs por account em 1h */
  perAccountMaxPerHour: number;
}

/**
 * Limites default. Eventualmente devem virar configuraveis via env / por conta.
 * TODO(env): expor RATE_LIMIT_PER_PHONE_INTERVAL_MS, RATE_LIMIT_PER_PHONE_HOUR,
 *            RATE_LIMIT_PER_ACCOUNT_HOUR e ler de env.
 */
const DEFAULT_CONFIG: RateLimitConfig = {
  perPhoneMinIntervalMs: 10 * 1000, // 1 msg / 10s
  perPhoneMaxPerHour: 30,
  perAccountMaxPerHour: 1000,
};

const ONE_HOUR_MS = 60 * 60 * 1000;

// ============================================
// Service
// ============================================

/**
 * Rate limiter in-memory pra envio de WhatsApp.
 *
 * Mantem timestamps de envios por (accountId, phone) e por accountId
 * pra checar 3 limites: intervalo minimo por numero, teto/hora por numero
 * e teto/hora por conta.
 *
 * TODO(redis): migrar pra Redis (sorted sets ou stream) caso o serviço
 * passe a rodar em multiplas replicas — neste modelo cada processo tem
 * sua propria contagem, o que sub-conta limites se escalarmos horizontal.
 */
export class WhatsappRateLimitService {
  private readonly config: RateLimitConfig = DEFAULT_CONFIG;

  /** Timestamps de envio por chave `accountId:phone`. */
  private readonly perPhone = new Map<string, number[]>();

  /** Timestamps de envio agregados por accountId. */
  private readonly perAccount = new Map<string, number[]>();

  // --------------------------------------------
  // Public API
  // --------------------------------------------

  /**
   * Verifica se o envio pra `phone` na `accountId` esta liberado.
   * NAO registra o envio — chame `record()` apos sucesso.
   */
  async check(accountId: string, phone: string): Promise<RateLimitCheckResult> {
    if (!accountId || !phone) {
      return { allowed: false, reason: 'missing_account_or_phone' };
    }

    const now = Date.now();
    const phoneKey = this.buildPhoneKey(accountId, phone);

    const phoneTimestamps = this.pruneAndGet(this.perPhone, phoneKey, now);
    const accountTimestamps = this.pruneAndGet(this.perAccount, accountId, now);

    // 1) intervalo minimo por numero
    if (phoneTimestamps.length > 0) {
      const last = phoneTimestamps[phoneTimestamps.length - 1];
      const elapsed = now - last;
      if (elapsed < this.config.perPhoneMinIntervalMs) {
        const waitMs = this.config.perPhoneMinIntervalMs - elapsed;
        return {
          allowed: false,
          reason: 'per_phone_min_interval',
          waitMs,
        };
      }
    }

    // 2) teto por numero / hora
    if (phoneTimestamps.length >= this.config.perPhoneMaxPerHour) {
      const oldest = phoneTimestamps[0];
      const waitMs = Math.max(0, ONE_HOUR_MS - (now - oldest));
      return {
        allowed: false,
        reason: 'per_phone_hourly_limit',
        waitMs,
      };
    }

    // 3) teto por conta / hora
    if (accountTimestamps.length >= this.config.perAccountMaxPerHour) {
      const oldest = accountTimestamps[0];
      const waitMs = Math.max(0, ONE_HOUR_MS - (now - oldest));
      return {
        allowed: false,
        reason: 'per_account_hourly_limit',
        waitMs,
      };
    }

    return { allowed: true };
  }

  /**
   * Atomic check+record (TOCTOU-safe within process).
   * Prefira tryAcquire ao invés de check+record separados.
   * NOTA: ainda in-memory; sem sincronização entre réplicas. TODO Redis.
   */
  tryAcquire(accountId: string, phone: string): RateLimitCheckResult {
    if (!accountId || !phone) {
      return { allowed: false, reason: 'missing_account_or_phone' };
    }

    const now = Date.now();
    const phoneKey = this.buildPhoneKey(accountId, phone);

    const phoneTimestamps = this.pruneAndGet(this.perPhone, phoneKey, now);
    const accountTimestamps = this.pruneAndGet(this.perAccount, accountId, now);

    // 1) intervalo minimo por numero
    if (phoneTimestamps.length > 0) {
      const last = phoneTimestamps[phoneTimestamps.length - 1];
      const elapsed = now - last;
      if (elapsed < this.config.perPhoneMinIntervalMs) {
        const waitMs = this.config.perPhoneMinIntervalMs - elapsed;
        return {
          allowed: false,
          reason: 'per_phone_min_interval',
          waitMs,
        };
      }
    }

    // 2) teto por numero / hora
    if (phoneTimestamps.length >= this.config.perPhoneMaxPerHour) {
      const oldest = phoneTimestamps[0];
      const waitMs = Math.max(0, ONE_HOUR_MS - (now - oldest));
      return {
        allowed: false,
        reason: 'per_phone_hourly_limit',
        waitMs,
      };
    }

    // 3) teto por conta / hora
    if (accountTimestamps.length >= this.config.perAccountMaxPerHour) {
      const oldest = accountTimestamps[0];
      const waitMs = Math.max(0, ONE_HOUR_MS - (now - oldest));
      return {
        allowed: false,
        reason: 'per_account_hourly_limit',
        waitMs,
      };
    }

    // check passou — registra imediatamente, sem await/yield no meio
    this.appendTimestamp(this.perPhone, phoneKey, now);
    this.appendTimestamp(this.perAccount, accountId, now);

    return { allowed: true };
  }

  /**
   * Registra um envio bem-sucedido. Chamar apos `check()` retornar `allowed: true`
   * e o dispatch real ter sido feito (ou enfileirado).
   */
  record(accountId: string, phone: string): void {
    if (!accountId || !phone) return;

    const now = Date.now();
    const phoneKey = this.buildPhoneKey(accountId, phone);

    this.appendTimestamp(this.perPhone, phoneKey, now);
    this.appendTimestamp(this.perAccount, accountId, now);
  }

  /**
   * Remove timestamps mais antigos que 1h pra evitar leak de memoria.
   * Tambem dropa entradas vazias.
   *
   * Deve ser chamado periodicamente (cron / setInterval).
   */
  cleanupOld(): void {
    const now = Date.now();
    const cutoff = now - ONE_HOUR_MS;
    let removedKeys = 0;

    for (const map of [this.perPhone, this.perAccount]) {
      for (const [key, timestamps] of map.entries()) {
        const kept = timestamps.filter((ts) => ts > cutoff);
        if (kept.length === 0) {
          map.delete(key);
          removedKeys++;
        } else if (kept.length !== timestamps.length) {
          map.set(key, kept);
        }
      }
    }

    if (removedKeys > 0) {
      logger.debug('whatsapp rate-limit cleanup', {
        removedKeys,
        phoneEntries: this.perPhone.size,
        accountEntries: this.perAccount.size,
      });
    }
  }

  // --------------------------------------------
  // Internals
  // --------------------------------------------

  private buildPhoneKey(accountId: string, phone: string): string {
    return `${accountId}:${phone}`;
  }

  /**
   * Retorna a lista de timestamps validos (< 1h) pra `key`, ja podando
   * entradas antigas in-place. Se a lista nao existe, devolve [] sem criar.
   */
  private pruneAndGet(map: Map<string, number[]>, key: string, now: number): number[] {
    const cutoff = now - ONE_HOUR_MS;
    const existing = map.get(key);
    if (!existing || existing.length === 0) return [];

    const pruned = existing.filter((ts) => ts > cutoff);
    if (pruned.length === 0) {
      map.delete(key);
      return [];
    }
    if (pruned.length !== existing.length) {
      map.set(key, pruned);
    }
    return pruned;
  }

  private appendTimestamp(map: Map<string, number[]>, key: string, ts: number): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(ts);
    } else {
      map.set(key, [ts]);
    }
  }
}

// ============================================
// Singleton
// ============================================

export const whatsappRateLimitService = new WhatsappRateLimitService();
