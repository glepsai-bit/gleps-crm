/**
 * T-019 — Webhook n8n por-conta.
 *
 * Validacoes:
 *  a) account.n8nWebhookUrl=null  -> NAO dispara webhook (fetch nao eh chamado)
 *  b) account.n8nWebhookUrl="..." -> dispara webhook UMA vez no URL informado
 *  c) account.n8nWebhookSecret    -> request leva header X-Webhook-Signature
 *
 * Estrategia: substitui o global `fetch` por stub durante o test, conta as
 * invocacoes e inspeciona url/headers/body. Sem dependencia de Prisma ou HTTP
 * real (alinhado ao node --import tsx --test ja usado nos outros suites).
 *
 * NOTE: emitOutcomeChanged foi REMOVIDO em T-019, portanto sem suite de
 * outcome — markOutcome agora so grava no banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { n8nWebhookService, type AppointmentWithRels } from '../services/n8n-webhook.service';

type FetchCall = { url: string; init: RequestInit };

function stubFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeAppointment(): AppointmentWithRels {
  // Cast: nao precisamos preencher TODOS os campos do CalendarEvent — o
  // service so le accountId/id/contact/account/status/datas. Mantemos o
  // minimo necessario.
  return {
    id: 'appt-1',
    accountId: 'acc-1',
    contactId: 'contact-1',
    title: 'Consulta',
    startTime: new Date('2026-06-18T10:00:00Z'),
    endTime: new Date('2026-06-18T11:00:00Z'),
    status: 'completed',
    attendanceStatus: 'ATTENDED',
    attendanceMarkedAt: new Date('2026-06-18T11:05:00Z'),
    outcome: 'PENDING',
    outcomeValue: null,
    outcomeNotes: null,
    outcomeMarkedAt: null,
    contact: {
      id: 'contact-1',
      nome: 'Joao Teste',
      telefone: '+5511999999999',
      email: 'joao@example.com',
    } as any,
    account: {
      id: 'acc-1',
      nome: 'Conta Demo',
      n8nWebhookUrl: null,
      n8nWebhookSecret: null,
    } as any,
  } as any as AppointmentWithRels;
}

test('T-019: account.n8nWebhookUrl=null -> NAO dispara webhook', async () => {
  const { calls, restore } = stubFetch();
  try {
    const appointment = makeAppointment();
    const account = { id: 'acc-1', nome: 'Conta Demo', n8nWebhookUrl: null, n8nWebhookSecret: null };

    const result = await n8nWebhookService.emitAttendanceChanged(appointment, account as any, {
      userId: 'user-1',
      name: 'Tester',
    });

    assert.equal(calls.length, 0, 'fetch NAO pode ser chamado quando URL eh null');
    assert.equal(result.delivered, false);
    assert.match(result.reason ?? '', /n8n_webhook_url/);
  } finally {
    restore();
  }
});

test('T-019: account.n8nWebhookUrl preenchido -> dispara webhook UMA vez no URL informado', async () => {
  const { calls, restore } = stubFetch();
  try {
    const appointment = makeAppointment();
    const url = 'https://n8n.example.com/webhook/attendance';
    const account = { id: 'acc-1', nome: 'Conta Demo', n8nWebhookUrl: url, n8nWebhookSecret: null };

    const result = await n8nWebhookService.emitAttendanceChanged(appointment, account as any, {
      userId: 'user-1',
      name: 'Tester',
    });

    assert.equal(calls.length, 1, 'fetch deve ser chamado exatamente uma vez');
    assert.equal(calls[0].url, url, 'URL chamada deve ser a do account.n8nWebhookUrl');
    assert.equal(result.delivered, true);

    const init = calls[0].init;
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(!('X-Webhook-Signature' in headers), 'sem secret -> sem header HMAC');

    const body = JSON.parse(String(init.body));
    assert.equal(body.event, 'appointment.attendance');
    assert.equal(body.accountId, 'acc-1');
    assert.equal(body.appointmentId, 'appt-1');
  } finally {
    restore();
  }
});

test('T-019: account.n8nWebhookSecret preenchido -> adiciona header X-Webhook-Signature', async () => {
  const { calls, restore } = stubFetch();
  try {
    const appointment = makeAppointment();
    const url = 'https://n8n.example.com/webhook/attendance';
    const secret = 'shhh-super-secreto';
    const account = { id: 'acc-1', nome: 'Conta Demo', n8nWebhookUrl: url, n8nWebhookSecret: secret };

    const result = await n8nWebhookService.emitAttendanceChanged(appointment, account as any);

    assert.equal(calls.length, 1);
    assert.equal(result.delivered, true);

    const init = calls[0].init;
    const headers = init.headers as Record<string, string>;
    assert.ok(headers['X-Webhook-Signature'], 'com secret deve ter header X-Webhook-Signature');

    const expected = 'sha256=' + createHmac('sha256', secret).update(String(init.body)).digest('hex');
    assert.equal(headers['X-Webhook-Signature'], expected, 'HMAC deve ser sha256(secret, body)');
  } finally {
    restore();
  }
});

test('T-019: emitOutcomeChanged nao existe mais no service', () => {
  // Salvaguarda contra regressao — garante que o evento removido em T-019
  // nao volte por acidente.
  assert.equal(
    (n8nWebhookService as any).emitOutcomeChanged,
    undefined,
    'emitOutcomeChanged foi removido em T-019; markOutcome so grava no banco',
  );
});
