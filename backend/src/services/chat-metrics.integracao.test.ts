/**
 * Dashboard 06/10 — teste de INTEGRAÇÃO dos blocos novos de chat-metrics,
 * contra o Postgres de verdade.
 *
 * O teste mockado prova a aritmética; este prova o SQL: que os EXISTS, o
 * GROUP BY por dia com AT TIME ZONE, o subselect da primeira conversa e o
 * AVG dos ciclos devolvem o que a regra diz, que nada vaza entre contas e
 * que os filtros de inbox chegam onde devem.
 */

import { describe, it, expect } from 'vitest';
import type { Prisma } from '@prisma/client';

import { prismaTest } from '../test/setup';
import { createTestAccount, createTestContact } from '../test/helpers';
import { chatMetricsService } from './chat-metrics.service';

const min = (n: number) => n * 60_000;
const hora = (n: number) => n * 60 * min(1);

/** Chave yyyy-mm-dd de `d` no fuso `tz` — o mesmo formatter de dailyVolume. */
const diaEm = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

describe('getMetrics — reuniões, transferidas, origem, fechamento e período anterior', () => {
  it('calcula cada bloco pela regra, ignora a outra conta e aplica o filtro de inbox só nas conversas', async () => {
    const { account, user } = await createTestAccount();
    const agora = new Date();
    // Período: as últimas 24h (até 1 min à frente, pra "agora" caber).
    const fromDate = new Date(agora.getTime() - hora(24));
    const toDate = new Date(agora.getTime() + min(1));
    // Dentro do período anterior (24h antes de fromDate).
    const antes = new Date(agora.getTime() - hora(36));

    const inbox = await prismaTest.inbox.create({ data: { accountId: account.id, name: 'WA' } });
    const inbox2 = await prismaTest.inbox.create({ data: { accountId: account.id, name: 'Insta' } });

    // Contatos novos: c1 (anúncio), c2 (orgânico), c3 (sem conversa), c4
    // (1ª conversa orgânica, 2ª de anúncio → orgânico). c0 é do período anterior.
    const [c1, c2, c3, c4] = await Promise.all(
      ['c1', 'c2', 'c3', 'c4'].map((nome) => createTestContact(account.id, { nome }))
    );
    const c0 = await prismaTest.contact.create({ data: { accountId: account.id, nome: 'c0', createdAt: antes } });

    const conversa = (data: Prisma.ConversationUncheckedCreateInput) =>
      prismaTest.conversation.create({ data });
    const mensagem = (conversationId: string, senderType: string, createdAt: Date, isPrivate = false) =>
      prismaTest.message.create({ data: { conversationId, senderType, content: senderType, createdAt, isPrivate } });

    // conv1 (c1): anúncio, respondida, IA falou e humano assumiu → transferida.
    const conv1 = await conversa({ accountId: account.id, inboxId: inbox.id, contactId: c1.id, status: 'open', sourceType: 'ctwa', createdAt: new Date(agora.getTime() - hora(2)), firstResponseAt: new Date(agora.getTime() - hora(2) + min(3)) });
    await mensagem(conv1.id, 'customer', new Date(agora.getTime() - hora(2)));
    await mensagem(conv1.id, 'ai_bot', new Date(agora.getTime() - hora(2) + min(3)));
    await mensagem(conv1.id, 'agent', new Date(agora.getTime() - hora(2) + min(10)));
    // conv2 (c2): orgânica, só a IA falou → na base, não transferida.
    const conv2 = await conversa({ accountId: account.id, inboxId: inbox.id, contactId: c2.id, status: 'open', sourceType: 'organic', createdAt: new Date(agora.getTime() - hora(3)) });
    await mensagem(conv2.id, 'customer', new Date(agora.getTime() - hora(3)));
    await mensagem(conv2.id, 'ai_bot', new Date(agora.getTime() - hora(3) + min(1)));
    // conv4a (c4, inbox2): orgânica, IA falou, humano só deixou NOTA PRIVADA → não transferida.
    const conv4a = await conversa({ accountId: account.id, inboxId: inbox2.id, contactId: c4.id, status: 'open', sourceType: 'organic', createdAt: new Date(agora.getTime() - hora(5)) });
    await mensagem(conv4a.id, 'ai_bot', new Date(agora.getTime() - hora(5)));
    await mensagem(conv4a.id, 'agent', new Date(agora.getTime() - hora(5) + min(2)), true);
    // conv4b (c4): segunda conversa, de anúncio — não muda a origem do contato.
    await conversa({ accountId: account.id, inboxId: inbox.id, contactId: c4.id, status: 'open', sourceType: 'ctwa', createdAt: new Date(agora.getTime() - hora(1)) });
    // conv5 (c2): só humano falou → fora da base de transferidas.
    const conv5 = await conversa({ accountId: account.id, inboxId: inbox.id, contactId: c2.id, status: 'open', createdAt: new Date(agora.getTime() - min(30)) });
    await mensagem(conv5.id, 'agent', new Date(agora.getTime() - min(29)));
    // convPrev (c0): do período anterior, resolvida; ciclo com 10 min de 1ª resposta e 60 de resolução.
    const convPrev = await conversa({ accountId: account.id, inboxId: inbox.id, contactId: c0.id, status: 'resolved', createdAt: antes, resolvedAt: new Date(antes.getTime() + hora(1)), resolvedBy: 'human' });
    await prismaTest.conversationCycle.create({
      data: { conversationId: convPrev.id, accountId: account.id, openedAt: antes, firstResponseAt: new Date(antes.getTime() + min(10)), resolvedAt: new Date(antes.getTime() + hora(1)), resolvedBy: 'human' },
    });

    // Reuniões: ev1 pelo agente (scheduled), ev2 pela equipe (completed);
    // cancelled e held ficam fora; evPrev é do período anterior.
    const evento = (data: Omit<Prisma.CalendarEventUncheckedCreateInput, 'accountId' | 'title' | 'startTime' | 'endTime'>) =>
      prismaTest.calendarEvent.create({
        data: { accountId: account.id, title: 'Reunião', startTime: new Date(agora.getTime() + hora(24)), endTime: new Date(agora.getTime() + hora(25)), ...data },
      });
    await evento({ status: 'scheduled', conversationId: conv1.id, contactId: c1.id, createdAt: agora });
    await evento({ status: 'completed', contactId: c2.id, createdAt: agora });
    await evento({ status: 'cancelled', contactId: c4.id, createdAt: agora });
    await evento({ status: 'held', contactId: c3.id, createdAt: agora, holdExpiresAt: new Date(agora.getTime() + min(5)) });
    await evento({ status: 'scheduled', contactId: c0.id, createdAt: antes });

    // Vendas: c1 paga (R$ 300, do fechamento), c2 pendente do fechamento
    // (sem valor), c3 pendente lançada à mão (origem null → não conta).
    const venda = (contactId: string, data: Partial<Prisma.SaleUncheckedCreateInput>) =>
      prismaTest.sale.create({
        data: { accountId: account.id, contactId, responsavelId: user.id, metodoPagamento: 'nao_informado', valor: 0, status: 'pending', createdAt: agora, ...data },
      });
    await venda(c1.id, { valor: 300, status: 'paid', paidAt: agora, origem: 'fechamento' });
    await venda(c2.id, { origem: 'fechamento' });
    await venda(c3.id, { origem: null });

    // Outra conta, com tudo igual: nada disso pode aparecer.
    const outra = await createTestAccount();
    const inboxOutra = await prismaTest.inbox.create({ data: { accountId: outra.account.id, name: 'WA' } });
    const cOutra = await createTestContact(outra.account.id, { nome: 'intruso' });
    const convOutra = await conversa({ accountId: outra.account.id, inboxId: inboxOutra.id, contactId: cOutra.id, status: 'open', sourceType: 'ctwa', createdAt: agora, firstResponseAt: agora });
    await mensagem(convOutra.id, 'ai_bot', agora);
    await mensagem(convOutra.id, 'agent', agora);
    await prismaTest.calendarEvent.create({
      data: { accountId: outra.account.id, title: 'x', startTime: agora, endTime: agora, status: 'scheduled', conversationId: convOutra.id, contactId: cOutra.id, createdAt: agora },
    });
    await prismaTest.sale.create({
      data: { accountId: outra.account.id, contactId: cOutra.id, responsavelId: outra.user.id, metodoPagamento: 'pix', valor: 999, status: 'paid', paidAt: agora, origem: 'fechamento', createdAt: agora },
    });

    const m = await chatMetricsService.getMetrics(account.id, { fromDate, toDate });

    expect(m.reunioes).toEqual({
      total: 2,
      peloAgente: 1,
      porDia: [{ date: agora.toISOString().slice(0, 10), total: 2 }],
    });
    expect(m.transferidasParaHumano).toEqual({ total: 1, pct: 33.3 });
    expect(m.origem).toEqual({ anuncio: 1, organico: 3 });
    expect(m.fechamento).toEqual({
      conversoes: 0,
      novosContatos: 4,
      taxaConversao: 0,
      receita: 300,
      vendasComValor: 1,
      perdas: 0,
      atendidos: 1,
      comReuniao: 2,
      ticketMedio: 300,
      semValor: 1,
    });
    expect(m.anterior).toEqual({
      totalConversations: 1,
      resolvedConversations: 1,
      avgFirstResponseMin: 10,
      avgResolutionMin: 60,
      reunioes: 1,
    });

    // Filtro de inbox: transferidas e anterior obedecem; reuniões, origem e
    // fechamento não (são números de agenda/contato).
    const f = await chatMetricsService.getMetrics(account.id, { fromDate, toDate, inboxId: inbox2.id });
    expect(f.transferidasParaHumano).toEqual({ total: 0, pct: 0 });
    expect(f.anterior).toMatchObject({ totalConversations: 0, resolvedConversations: 0, avgFirstResponseMin: null, avgResolutionMin: null, reunioes: 1 });
    expect(f.reunioes).toEqual(m.reunioes);
    expect(f.origem).toEqual(m.origem);
    expect(f.fechamento).toEqual(m.fechamento);

    // Fuso: o dia de `porDia` acompanha dailyVolume (Postgres e Intl concordam).
    const tz = 'Pacific/Kiritimati'; // UTC+14 — quase sempre um dia à frente do UTC
    const sp = await chatMetricsService.getMetrics(account.id, { fromDate, toDate, tz });
    expect(sp.reunioes.porDia).toEqual([{ date: diaEm(agora, tz), total: 2 }]);
    expect(sp.dailyVolume.map((d) => d.date)).toContain(diaEm(agora, tz));
  });
});

describe('getLiveAttendance — esperandoHaMais5Min', () => {
  it('conta, entre as em aberto, quem está com o cliente esperando há mais de 5 min', async () => {
    const { account, user } = await createTestAccount();
    const agora = Date.now();
    const haMin = (n: number) => new Date(agora - min(n));
    const inbox = await prismaTest.inbox.create({ data: { accountId: account.id, name: 'WA' } });
    const contato = await createTestContact(account.id);

    const conversa = (data: Partial<Prisma.ConversationUncheckedCreateInput>) =>
      prismaTest.conversation.create({ data: { accountId: account.id, inboxId: inbox.id, contactId: contato.id, status: 'open', ...data } });
    const mensagem = (conversationId: string, senderType: string, createdAt: Date, isPrivate = false) =>
      prismaTest.message.create({ data: { conversationId, senderType, content: senderType, createdAt, isPrivate } });

    // a: cliente esperando há 10 min → conta.
    const a = await conversa({ createdAt: haMin(20) });
    await mensagem(a.id, 'customer', haMin(10));
    // b: cliente falou há 1 min → não.
    const b = await conversa({ createdAt: haMin(20) });
    await mensagem(b.id, 'customer', haMin(1));
    // c: ninguém falou, aberta há 6 min → conta.
    const c = await conversa({ createdAt: haMin(6) });
    // d: cliente falou há 10 min, mas a última NÃO-privada é da IA → balde IA, não conta.
    const d = await conversa({ createdAt: haMin(20) });
    await mensagem(d.id, 'customer', haMin(10));
    await mensagem(d.id, 'ai_bot', haMin(9));
    // e: cliente falou há 10 min e depois só veio nota privada → continua esperando → conta.
    const e = await conversa({ createdAt: haMin(20) });
    await mensagem(e.id, 'customer', haMin(10));
    await mensagem(e.id, 'agent', haMin(8), true);
    // f: com assignee → humano, não conta.
    const f = await conversa({ createdAt: haMin(60), assigneeId: user.id });
    await mensagem(f.id, 'customer', haMin(30));
    // g: resolvida → nem entra no snapshot.
    const g = await conversa({ createdAt: haMin(60), status: 'resolved' });
    await mensagem(g.id, 'customer', haMin(30));

    const r = await chatMetricsService.getLiveAttendance(account.id);

    expect(r.total).toBe(6);
    expect(r.emAberto.conversationIds.sort()).toEqual([a.id, b.id, c.id, e.id].sort());
    expect(r.ia.conversationIds).toEqual([d.id]);
    expect(r.humano.conversationIds).toEqual([f.id]);
    expect(r.esperandoHaMais5Min).toBe(3);
  });
});
