/**
 * WH-004: Rotaciona o `evolution_webhook_secret` da conta + re-aplica nas
 * inboxes Evolution ativas.
 *
 * O secret legado da fitpark-principal (`test-secret-min-32-chars-please-rotate-prod`)
 * é uma string literal previsível: qualquer pessoa que tenha visto o repo
 * consegue forjar webhooks. Este script:
 *   1. Gera 32 bytes randômicos via crypto.randomBytes (hex).
 *   2. Atualiza Account.evolutionWebhookSecret.
 *   3. Para cada Inbox WhatsApp ativa com `evolutionInstance`, chama
 *      `evolutionService.setWebhook` para que a Evolution comece a enviar
 *      o novo bearer em `x-crm-webhook-token` (e o controller passe a
 *      validar HMAC contra o novo secret).
 *
 * Uso:
 *   ACCOUNT_ID=00000000-0000-0000-0000-000000000001 npx tsx scripts/rotate-evolution-webhook-secret.ts
 */
import * as crypto from 'crypto';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { evolutionService, DEFAULT_WEBHOOK_EVENTS } from '../src/services/evolution.service';
import { logger } from '../src/utils/logger';

const KNOWN_INSECURE = new Set<string>([
  'test-secret-min-32-chars-please-rotate-prod',
  '',
]);

function deriveWebhookUrl(accountId: string): string {
  const rawBase = env.WEBHOOK_BASE_URL || env.API_URL || '';
  const base = rawBase.replace(/\/$/, '');
  return `${base}/api/evolution/webhook/${accountId}`;
}

async function main() {
  const accountId = process.env.ACCOUNT_ID;
  if (!accountId) {
    console.error('ACCOUNT_ID env é obrigatório');
    process.exit(1);
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, evolutionWebhookSecret: true },
  });
  if (!account) {
    console.error(`Conta ${accountId} não encontrada`);
    process.exit(1);
  }

  const current = account.evolutionWebhookSecret ?? '';
  const isInsecure = KNOWN_INSECURE.has(current);
  console.log(`[rotate] accountId=${accountId} currentSecret=${current ? `len=${current.length}` : 'EMPTY'} insecure=${isInsecure}`);

  const newSecret = crypto.randomBytes(32).toString('hex');
  await prisma.account.update({
    where: { id: accountId },
    data: { evolutionWebhookSecret: newSecret },
  });
  console.log(`[rotate] DB atualizado com novo secret len=${newSecret.length}`);

  const inboxes = await prisma.inbox.findMany({
    where: {
      accountId,
      channelType: 'whatsapp',
      active: true,
      NOT: { evolutionInstance: null },
    },
    select: { id: true, name: true, evolutionInstance: true },
  });
  console.log(`[rotate] ${inboxes.length} inbox(es) WhatsApp ativas com Evolution instance`);

  const webhookUrl = deriveWebhookUrl(accountId);

  for (const inbox of inboxes) {
    const instance = inbox.evolutionInstance!;
    try {
      const r = await evolutionService.setWebhook(accountId, instance, {
        url: webhookUrl,
        events: DEFAULT_WEBHOOK_EVENTS,
        authToken: newSecret,
      });
      console.log(`[rotate] setWebhook ok=${r.ok} inbox=${inbox.name} instance=${instance}`);
    } catch (err: any) {
      console.error(`[rotate] setWebhook FALHOU inbox=${inbox.name} instance=${instance}: ${err?.message || err}`);
      logger.error('[rotate-evolution-webhook-secret] setWebhook falhou', err, {
        accountId,
        instance,
      });
    }
  }

  await prisma.$disconnect();
  console.log('[rotate] concluído');
}

main().catch((err) => {
  console.error('[rotate] erro fatal', err);
  process.exit(1);
});
