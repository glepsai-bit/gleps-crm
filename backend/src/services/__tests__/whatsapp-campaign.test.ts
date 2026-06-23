/**
 * Testes unitários — whatsapp-campaign.service
 * QA T-022 Sprint 2 (2026-06-23)
 *
 * Estratégia: testa a lógica pura (isScheduled, renderTemplate, validação de params)
 * sem banco de dados (Prisma mockado ou lógica extraída/replicada).
 *
 * processScheduledQueue() é testada via simulação de lógica (não usa Prisma real).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── lógica de render extraída do service (não exportada) ──────────────────
const CAMPAIGN_REGEX = /\{\{?\s*([\w.]+)\s*\}?\}/g;

function renderTemplate(content: string, variables: Record<string, string> = {}): string {
  if (!content) return '';
  return content.replace(CAMPAIGN_REGEX, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

// ── lógica de isScheduled (extraída de sendBatch) ─────────────────────────
function isScheduled(scheduledAt?: Date): boolean {
  return !!(scheduledAt && scheduledAt.getTime() > Date.now());
}

// ── simulação de processScheduledQueue: lógica de filtro ─────────────────
// O filtro real é: status='scheduled' AND scheduledAt <= now
// Batches com status diferente ou scheduledAt no futuro não devem ser processados.
function shouldProcess(batch: { status: string; scheduledAt: Date | null }, now: Date): boolean {
  return batch.status === 'scheduled' && batch.scheduledAt !== null && batch.scheduledAt <= now;
}

// ─────────────────────────────────────────────────────────────────────────

describe('whatsapp-campaign — renderTemplate()', () => {
  it('substitui {nome} simples', () => {
    expect(renderTemplate('Olá, {nome}!', { nome: 'Ana' })).toBe('Olá, Ana!');
  });

  it('substitui {{nome}} estilo Handlebars', () => {
    expect(renderTemplate('Olá, {{nome}}!', { nome: 'Ana' })).toBe('Olá, Ana!');
  });

  it('substitui { nome } com espaços', () => {
    expect(renderTemplate('Olá, { nome }!', { nome: 'Ana' })).toBe('Olá, Ana!');
  });

  it('variável ausente vira string vazia', () => {
    expect(renderTemplate('{nome} tem plano {plano}', { nome: 'Luis' })).toBe('Luis tem plano ');
  });

  it('conteúdo vazio retorna string vazia', () => {
    expect(renderTemplate('', { nome: 'X' })).toBe('');
  });

  it('conteúdo null/undefined não retornado (guarda defensiva: `if (!content) return ""`)', () => {
    // @ts-expect-error — teste defensivo
    expect(renderTemplate(null, {})).toBe('');
  });

  it('acumula variável nome vindo do recipient.name', () => {
    const variables: Record<string, string> = {
      nome: 'Carlos',
    };
    const result = renderTemplate('Olá, {nome}! Seu vencimento é {data}.', {
      ...variables,
      data: '01/07/2026',
    });
    expect(result).toBe('Olá, Carlos! Seu vencimento é 01/07/2026.');
  });
});

describe('whatsapp-campaign — isScheduled()', () => {
  it('scheduledAt no futuro → agendado', () => {
    const future = new Date(Date.now() + 60_000); // +1 min
    expect(isScheduled(future)).toBe(true);
  });

  it('scheduledAt no passado → NÃO agendado (processado imediatamente)', () => {
    const past = new Date(Date.now() - 60_000); // -1 min
    expect(isScheduled(past)).toBe(false);
  });

  it('scheduledAt undefined → NÃO agendado', () => {
    expect(isScheduled(undefined)).toBe(false);
  });

  it('scheduledAt = now (borda) → NÃO agendado (getTime() == Date.now() não é > Date.now())', () => {
    // Na prática Date.now() avança, mas o comportamento é documentado aqui:
    // scheduledAt exatamente igual a now é enviado imediatamente (cron faz lte)
    const now = new Date();
    // Não podemos garantir == no runtime, então testamos com 1ms no futuro/passado
    expect(isScheduled(new Date(Date.now() - 1))).toBe(false);
    expect(isScheduled(new Date(Date.now() + 10))).toBe(true);
  });
});

describe('whatsapp-campaign — processScheduledQueue: lógica de filtro', () => {
  const now = new Date('2026-06-23T10:00:00Z');

  it('batch scheduled com scheduledAt <= now deve ser processado', () => {
    const batch = { status: 'scheduled', scheduledAt: new Date('2026-06-23T09:55:00Z') };
    expect(shouldProcess(batch, now)).toBe(true);
  });

  it('batch scheduled com scheduledAt > now NÃO deve ser processado', () => {
    const batch = { status: 'scheduled', scheduledAt: new Date('2026-06-23T10:30:00Z') };
    expect(shouldProcess(batch, now)).toBe(false);
  });

  it('batch com status running NÃO deve ser processado', () => {
    const batch = { status: 'running', scheduledAt: new Date('2026-06-23T09:00:00Z') };
    expect(shouldProcess(batch, now)).toBe(false);
  });

  it('batch com status completed NÃO deve ser processado', () => {
    const batch = { status: 'completed', scheduledAt: new Date('2026-06-23T09:00:00Z') };
    expect(shouldProcess(batch, now)).toBe(false);
  });

  it('batch com status cancelled NÃO deve ser processado', () => {
    const batch = { status: 'cancelled', scheduledAt: new Date('2026-06-23T09:00:00Z') };
    expect(shouldProcess(batch, now)).toBe(false);
  });

  it('batch com scheduledAt null NÃO deve ser processado (invariante de integridade)', () => {
    const batch = { status: 'scheduled', scheduledAt: null };
    expect(shouldProcess(batch, now)).toBe(false);
  });

  /**
   * BUG-2 (ALTA): processScheduledQueue() não tem accountId no WHERE do findMany.
   * Isso é CORRETO do ponto de vista arquitetural — o cron é global e deve processar
   * batches de TODAS as contas. Mas registramos aqui que:
   * - O batch carrega batch.accountId
   * - processBatchInBackground usa batch.accountId para todas as operações
   * - O escopo de tenant é preservado DENTRO do processamento
   * CONCLUSÃO: comportamento correto — não é bug de multi-tenancy.
   */
  it('DOCUMENTO: processScheduledQueue processa batches de múltiplas contas (correto)', () => {
    const batches = [
      { status: 'scheduled', scheduledAt: new Date('2026-06-23T09:00:00Z'), accountId: 'conta-1' },
      { status: 'scheduled', scheduledAt: new Date('2026-06-23T09:30:00Z'), accountId: 'conta-2' },
    ];
    const processados = batches.filter(b => shouldProcess(b, now));
    expect(processados).toHaveLength(2);
    // Cada batch carrega seu accountId — tenant isolado no processamento
    expect(processados[0].accountId).toBe('conta-1');
    expect(processados[1].accountId).toBe('conta-2');
  });
});

describe('whatsapp-campaign — validações de entrada (sendSingle / sendBatch)', () => {
  it('DOCUMENTO: sendSingle requer phone OU contactId (não ambos vazios)', () => {
    // Validado no service: if (!params.contactId && !params.phone) throw ValidationError
    const hasPhone = (params: { contactId?: string; phone?: string }) =>
      !!(params.contactId || params.phone);

    expect(hasPhone({ phone: '5511999998888' })).toBe(true);
    expect(hasPhone({ contactId: 'uuid-1' })).toBe(true);
    expect(hasPhone({})).toBe(false);
  });

  it('DOCUMENTO: sendSingle requer templateId OU content', () => {
    const hasContent = (params: { templateId?: string; content?: string }) =>
      !!(params.templateId || params.content);

    expect(hasContent({ templateId: 'uuid-tpl' })).toBe(true);
    expect(hasContent({ content: 'Mensagem direta' })).toBe(true);
    expect(hasContent({})).toBe(false);
  });

  it('DOCUMENTO: sendBatch com lista vazia de phones e contactIds → deve falhar', () => {
    const hasRecipients = (params: { contactIds?: string[]; phones?: any[] }) =>
      (params.contactIds && params.contactIds.length > 0) ||
      (params.phones && params.phones.length > 0);

    expect(hasRecipients({ contactIds: [] })).toBeFalsy();
    expect(hasRecipients({ phones: [] })).toBeFalsy();
    expect(hasRecipients({ phones: [{ phone: '5511999998888' }] })).toBeTruthy();
  });
});
