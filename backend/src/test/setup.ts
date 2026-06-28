import { PrismaClient } from '@prisma/client';
import { beforeEach, afterAll } from 'vitest';

/**
 * Prisma client dedicado ao DB de teste (gleps_crm_test).
 * Usado pelos testes para arrange/assert direto no DB.
 */
export const prismaTest = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

/**
 * Limpa todas as tabelas relevantes ANTES de cada teste.
 * Ordem reversa de FK (filhas primeiro). TRUNCATE CASCADE garante
 * limpeza correta mesmo se ordem nao estiver perfeita.
 */
const TABLES_TO_TRUNCATE = [
  'tag_history',
  'lead_tags',
  'dispatch_logs',
  'dispatch_batches',
  'messages',
  'conversations',
  'sale_items',
  'sales',
  'calendar_attendees',
  'calendar_events',
  'email_sends',
  'email_enrollments',
  'email_steps',
  'email_rules',
  'email_audience_contacts',
  'email_audiences',
  'email_cadences',
  'email_campaigns',
  'email_templates',
  'email_inbox_messages',
  'contacts',
  'tags',
  'funnels',
  'api_keys',
  'refresh_tokens',
  'webhook_deliveries',
  'webhook_subscriptions',
  'whatsapp_consents',
  'whatsapp_templates',
  'sla_policies',
  'inboxes',
  'teams',
  'canned_responses',
  'custom_attributes',
  'users',
  'accounts',
];

beforeEach(async () => {
  // Usa TRUNCATE CASCADE para limpar respeitando FKs.
  // Erros individuais (tabela inexistente em algum branch) sao ignorados.
  for (const table of TABLES_TO_TRUNCATE) {
    try {
      await prismaTest.$executeRawUnsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
    } catch {
      /* tabela pode nao existir no schema atual — ignora */
    }
  }
});

afterAll(async () => {
  await prismaTest.$disconnect();
});
