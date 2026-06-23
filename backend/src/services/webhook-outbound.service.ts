import * as crypto from 'crypto';
import type { WebhookSubscription, WebhookDelivery } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type WebhookSubscriptionSafe = Omit<WebhookSubscription, 'secret'>;

export interface CreateSubscriptionInput {
  name: string;
  url: string;
  events: string[];
  active?: boolean;
}

export interface UpdateSubscriptionInput {
  name?: string;
  url?: string;
  events?: string[];
  active?: boolean;
}

export interface ListDeliveriesOptions {
  limit?: number;
  offset?: number;
}

export interface TestSubscriptionResult {
  ok: boolean;
  status: number;
  latencyMs: number;
}

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BATCH_SIZE = 50;

class WebhookOutboundService {
  // ============================================
  // Subscriptions CRUD
  // ============================================

  /**
   * List subscriptions for an account (never returns the HMAC secret).
   */
  async listSubscriptions(accountId: string): Promise<WebhookSubscriptionSafe[]> {
    const subs = await prisma.webhookSubscription.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        accountId: true,
        name: true,
        url: true,
        events: true,
        active: true,
        lastDeliveryAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return subs;
  }

  /**
   * Create a new subscription.
   * Generates a fresh HMAC secret (32 random bytes hex-encoded) and
   * returns it ONCE in the response. The plaintext secret is also persisted
   * so we can sign outbound deliveries later.
   */
  async createSubscription(
    accountId: string,
    input: CreateSubscriptionInput
  ): Promise<WebhookSubscription & { secret: string }> {
    const secret = crypto.randomBytes(32).toString('hex');

    const record = await prisma.webhookSubscription.create({
      data: {
        accountId,
        name: input.name,
        url: input.url,
        events: input.events,
        active: input.active ?? true,
        secret,
      },
    });

    return { ...record, secret };
  }

  /**
   * Partially update a subscription (scoped by accountId for safety).
   * Returns the updated record without the secret.
   */
  async updateSubscription(
    id: string,
    accountId: string,
    partial: UpdateSubscriptionInput
  ): Promise<WebhookSubscriptionSafe> {
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id, accountId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundError('Webhook subscription');
    }

    const updated = await prisma.webhookSubscription.update({
      where: { id },
      data: {
        ...(partial.name !== undefined && { name: partial.name }),
        ...(partial.url !== undefined && { url: partial.url }),
        ...(partial.events !== undefined && { events: partial.events }),
        ...(partial.active !== undefined && { active: partial.active }),
      },
      select: {
        id: true,
        accountId: true,
        name: true,
        url: true,
        events: true,
        active: true,
        lastDeliveryAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return updated;
  }

  /**
   * Delete a subscription (scoped by accountId).
   */
  async deleteSubscription(id: string, accountId: string): Promise<void> {
    const result = await prisma.webhookSubscription.deleteMany({
      where: { id, accountId },
    });

    if (result.count === 0) {
      throw new NotFoundError('Webhook subscription');
    }
  }

  // ============================================
  // Deliveries
  // ============================================

  /**
   * List deliveries for a subscription (scoped by accountId).
   */
  async listDeliveries(
    subscriptionId: string,
    accountId: string,
    options: ListDeliveriesOptions = {}
  ): Promise<WebhookDelivery[]> {
    const subscription = await prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, accountId },
      select: { id: true },
    });

    if (!subscription) {
      throw new NotFoundError('Webhook subscription');
    }

    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return deliveries;
  }

  /**
   * Fire a synchronous test request to validate the destination URL.
   * Does NOT persist a WebhookDelivery — purely a diagnostic ping.
   */
  async testSubscription(id: string, accountId: string): Promise<TestSubscriptionResult> {
    const subscription = await prisma.webhookSubscription.findFirst({
      where: { id, accountId },
    });

    if (!subscription) {
      throw new NotFoundError('Webhook subscription');
    }

    const body = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      accountId,
    };

    const serialized = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(serialized)
      .digest('hex');

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-event': 'webhook.test',
        },
        body: serialized,
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;
      return {
        ok: response.ok,
        status: response.status,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      logger.warn('[webhook-outbound] test failed', {
        subscriptionId: id,
        url: subscription.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        status: 0,
        latencyMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================
  // Emit + Delivery pipeline
  // ============================================

  /**
   * Enqueue an event for every active subscription on the account that
   * listens to `eventType`. Each delivery row is created with status='pending'
   * and dispatched in the background (fire-and-forget).
   */
  async emit(
    accountId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: {
        accountId,
        active: true,
        events: { has: eventType },
      },
      select: { id: true },
    });

    if (subscriptions.length === 0) {
      return;
    }

    const deliveries = await Promise.all(
      subscriptions.map(sub =>
        prisma.webhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            eventType,
            payload: payload as object,
            status: 'pending',
            attemptCount: 0,
          },
          select: { id: true },
        })
      )
    );

    for (const delivery of deliveries) {
      // Fire-and-forget — do not await
      this.processDelivery(delivery.id).catch(err => {
        logger.error('[webhook-outbound] processDelivery failed', err, {
          deliveryId: delivery.id,
          eventType,
          accountId,
        });
      });
    }
  }

  /**
   * Deliver a single webhook attempt and update bookkeeping.
   * Handles success, retry scheduling (exponential backoff) and DLQ.
   */
  async processDelivery(deliveryId: string): Promise<void> {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { subscription: true },
    });

    if (!delivery) {
      logger.warn('[webhook-outbound] delivery not found', { deliveryId });
      return;
    }

    const { subscription } = delivery;
    if (!subscription) {
      logger.warn('[webhook-outbound] subscription missing for delivery', { deliveryId });
      return;
    }

    const attemptNumber = delivery.attemptCount + 1;
    const deliveredAt = new Date().toISOString();
    const body = {
      event: delivery.eventType,
      accountId: subscription.accountId,
      data: delivery.payload,
      deliveredAt,
      deliveryId: delivery.id,
    };

    const serialized = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(serialized)
      .digest('hex');

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let errorMessage: string | null = null;

    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-event': delivery.eventType,
        },
        body: serialized,
        signal: controller.signal,
      });

      httpStatus = response.status;
      try {
        const bodyText = await response.text().catch(() => '[binary or invalid encoding]');
        if (typeof bodyText !== 'string') {
          responseBody = '[binary or invalid encoding]';
        } else {
          responseBody = bodyText.length > 4000 ? bodyText.slice(0, 4000) : bodyText;
        }
      } catch {
        responseBody = null;
      }
      success = response.ok;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      responseBody = errorMessage;
      success = false;
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;

    if (success) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'success',
          httpStatus,
          responseBody,
          latencyMs,
          attemptCount: attemptNumber,
          completedAt: new Date(),
          nextRetryAt: null,
        },
      });

      await prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { lastDeliveryAt: new Date() },
      });
      return;
    }

    // Failure path — decide between retry and DLQ.
    if (attemptNumber >= MAX_ATTEMPTS) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'dlq',
          httpStatus,
          responseBody,
          latencyMs,
          attemptCount: attemptNumber,
          completedAt: new Date(),
          nextRetryAt: null,
        },
      });

      logger.error('[webhook-outbound] delivery moved to DLQ', undefined, {
        deliveryId,
        subscriptionId: subscription.id,
        eventType: delivery.eventType,
        attemptCount: attemptNumber,
        httpStatus,
      });
      return;
    }

    // Exponential backoff: next = now + 2^attemptCount(before increment) * 60s
    const backoffSeconds = Math.pow(2, delivery.attemptCount) * 60;
    const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000);

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        httpStatus,
        responseBody,
        latencyMs,
        attemptCount: attemptNumber,
        nextRetryAt,
      },
    });

    logger.warn('[webhook-outbound] delivery failed, scheduled retry', {
      deliveryId,
      subscriptionId: subscription.id,
      eventType: delivery.eventType,
      attemptCount: attemptNumber,
      httpStatus,
      nextRetryAt: nextRetryAt.toISOString(),
    });
  }

  /**
   * Cron-driven retry sweep. Picks up to RETRY_BATCH_SIZE failed deliveries
   * whose nextRetryAt has passed and re-dispatches them in the background.
   *
   * Multi-replica safe: usa pre-claim via updateMany para mover as deliveries
   * elegiveis de 'failed' para 'retrying' atomicamente, evitando que duas
   * replicas do cron processem a mesma entrega em paralelo (race condition).
   */
  async processRetryQueue(): Promise<{ processed: number }> {
    const now = new Date();

    // 1. Selecionar candidatos (somente IDs) respeitando RETRY_BATCH_SIZE.
    const candidates = await prisma.webhookDelivery.findMany({
      where: {
        status: 'failed',
        nextRetryAt: { lte: now },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: RETRY_BATCH_SIZE,
      select: { id: true },
    });

    if (candidates.length === 0) {
      return { processed: 0 };
    }

    const candidateIds = candidates.map(c => c.id);

    // 2. Pre-claim atomico: marca somente as que ainda estao 'failed' como
    // 'retrying'. updateMany retorna apenas as linhas efetivamente alteradas,
    // o que garante mutual exclusion entre replicas concorrentes.
    const claimed = await prisma.webhookDelivery.updateMany({
      where: {
        id: { in: candidateIds },
        status: 'failed',
        nextRetryAt: { lte: now },
      },
      data: { status: 'retrying' },
    });

    if (claimed.count === 0) {
      return { processed: 0 };
    }

    // 3. Buscar as deliveries que conseguimos reservar (estao 'retrying' e
    // pertencem ao conjunto que tentamos claimar nesta execucao).
    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        id: { in: candidateIds },
        status: 'retrying',
      },
      select: { id: true },
    });

    // 4. Disparar processDelivery — ele atualiza status para success/failed/dlq.
    for (const delivery of deliveries) {
      this.processDelivery(delivery.id).catch(err => {
        logger.error('[webhook-outbound] retry processDelivery failed', err, {
          deliveryId: delivery.id,
        });
      });
    }

    return { processed: deliveries.length };
  }
}

export const webhookOutboundService = new WebhookOutboundService();
