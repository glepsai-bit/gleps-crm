/**
 * push.service.ts — Web Push Notifications (VAPID)
 *
 * Envia notificacoes Web Push aos browsers inscritos do agente. Usado
 * pelo message.service.create() quando mensagem inbound chega numa conversa
 * atribuida — o navegador do agente recebe uma notificacao mesmo com a aba
 * fechada.
 *
 * Fluxo:
 *   1. Frontend registra service worker '/sw-push.js'.
 *   2. Frontend pede permissao Notification, depois subscribe() com VAPID
 *      publicKey (GET /api/push/vapid-public).
 *   3. Frontend envia { endpoint, keys } via POST /api/push/subscribe.
 *   4. Backend salva PushSubscription; quando ha mensagem nova pra esse user,
 *      chama sendToUser(userId, payload).
 *   5. Se a subscription retornar 404/410 (usuario deu unsubscribe pelo browser),
 *      removemos a linha automaticamente pra nao ficar tentando de novo.
 *
 * VAPID keys carregadas de env.VAPID_PUBLIC_KEY / env.VAPID_PRIVATE_KEY /
 * env.VAPID_SUBJECT. Se ausentes, sendToUser vira no-op silencioso (com
 * logger.debug uma vez no init).
 */

import webPush from 'web-push';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface PushPayload {
  title: string;
  body: string;
  /** URL do frontend a abrir quando o usuario clica na notificacao. */
  url?: string;
  /**
   * Tag do Notification API — permite substituir notificacao anterior
   * (ex.: multiplas mensagens da mesma conversa colapsam em uma so).
   */
  tag?: string;
  /** Icone opcional (usado no SW; default = favicon do app). */
  icon?: string;
  /** Payload extra opaco (persistido em Notification.data para o SW). */
  data?: Record<string, unknown>;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string | null;
}

// ============================================
// Init (VAPID)
// ============================================

let vapidReady = false;

function ensureVapid(): boolean {
  if (vapidReady) return true;
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  const subj = env.VAPID_SUBJECT?.trim();
  if (!pub || !priv || !subj) {
    return false;
  }
  try {
    webPush.setVapidDetails(subj, pub, priv);
    vapidReady = true;
    logger.info('[push] VAPID configurado com sucesso');
    return true;
  } catch (err) {
    logger.warn('[push] falha ao configurar VAPID — push notifications desabilitadas', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ============================================
// Service
// ============================================

class PushService {
  /**
   * Retorna a public key VAPID pro frontend chamar
   * pushManager.subscribe({ applicationServerKey }). null quando nao configurada.
   */
  getPublicKey(): string | null {
    const pub = env.VAPID_PUBLIC_KEY?.trim();
    return pub && pub.length > 0 ? pub : null;
  }

  /** Indica se o servico esta ativo (VAPID configurado). */
  isEnabled(): boolean {
    return ensureVapid();
  }

  /**
   * Registra (ou atualiza) uma subscription para o usuario. Idempotente:
   * mesmo endpoint reinscrito so atualiza keys + userAgent + lastNotifiedAt
   * reset. Se o endpoint ja pertence a outro user (raro — trocou de sessao
   * no mesmo browser), reassocia pro user atual.
   */
  async subscribe(userId: string, input: SubscriptionInput): Promise<{ id: string }> {
    if (!input?.endpoint || !input?.keys?.p256dh || !input?.keys?.auth) {
      throw new Error('endpoint e keys.p256dh/auth sao obrigatorios');
    }
    const row = await prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId,
        endpoint: input.endpoint,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /**
   * Remove uma subscription pelo endpoint. Idempotente — se ja nao existir
   * retorna { removed: 0 }.
   */
  async unsubscribe(endpoint: string): Promise<{ removed: number }> {
    if (!endpoint) return { removed: 0 };
    const result = await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return { removed: result.count };
  }

  /**
   * Envia payload a TODAS as subscriptions do usuario. Fire-and-forget:
   * exceptions viram logger.warn, cada endpoint eh independente. Subscriptions
   * com endpoint expirado (404/410) sao removidas automaticamente.
   *
   * NAO faz throw. Retorna contadores pra observabilidade.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload
  ): Promise<{ sent: number; failed: number; removed: number }> {
    if (!ensureVapid()) {
      logger.debug('[push] sendToUser skip — VAPID nao configurada', { userId });
      return { sent: 0, failed: 0, removed: 0 };
    }
    if (!userId) return { sent: 0, failed: 0, removed: 0 };

    const subs = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, keys: true },
    });

    if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? null,
      tag: payload.tag ?? null,
      icon: payload.icon ?? null,
      data: payload.data ?? null,
    });

    let sent = 0;
    let failed = 0;
    let removed = 0;

    await Promise.all(
      subs.map(async sub => {
        // keys eh Json — tipagem generica, mas sabemos o shape porque foi
        // validado no subscribe(). Caso legado corrompido, marca falha.
        const keys = sub.keys as unknown as { p256dh?: string; auth?: string } | null;
        if (!keys?.p256dh || !keys?.auth) {
          failed += 1;
          return;
        }
        try {
          await webPush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: keys.p256dh, auth: keys.auth },
            },
            body,
            { TTL: 60 * 60 * 24 } // 24h — server pode manter no queue ate o browser voltar
          );
          sent += 1;
        } catch (err: unknown) {
          const status =
            typeof err === 'object' && err !== null && 'statusCode' in err
              ? Number((err as { statusCode?: number }).statusCode)
              : undefined;
          // 404 / 410: subscription expirada ou revogada. Limpa.
          if (status === 404 || status === 410) {
            try {
              await prisma.pushSubscription.delete({ where: { id: sub.id } });
              removed += 1;
            } catch {
              /* ja removido em corrida — ignora */
            }
            return;
          }
          failed += 1;
          logger.warn('[push] falha ao enviar notificacao', {
            userId,
            endpoint: sub.endpoint,
            statusCode: status,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );

    if (sent > 0) {
      // Best-effort: atualiza lastNotifiedAt so em quem realmente recebeu.
      // Fire-and-forget pra nao segurar o retorno do sender.
      void prisma.pushSubscription
        .updateMany({
          where: { userId, endpoint: { in: subs.map(s => s.endpoint) } },
          data: { lastNotifiedAt: new Date() },
        })
        .catch(() => {
          /* nao critico */
        });
    }

    return { sent, failed, removed };
  }
}

export const pushService = new PushService();
