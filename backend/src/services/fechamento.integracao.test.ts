/**
 * ETAPA B — teste de INTEGRAÇÃO do fechamento, contra o Postgres de verdade.
 *
 * Os testes mockados provam a lógica; este prova o banco: que tags.papel e
 * sales.origem existem (migration 0069), que o gatilho de contact.applyTag e
 * de conversation.addLabel chegam na mesma venda, que a venda pendente não
 * duplica quando o lead sai e volta, que o PATCH completa a venda e dispara o
 * Purchase, e que a lista do Kanban e o dashboard leem tudo isso.
 *
 * Só o mundo externo é mockado: o envio no WhatsApp (conversation.service
 * puxa o evolution) e o despacho do Purchase pra Meta.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'mock' })),
    sendMedia: vi.fn(async () => ({ messageId: 'mock' })),
    sendAudio: vi.fn(async () => ({ messageId: 'mock' })),
  },
}));

import { prismaTest } from '../test/setup';
import { createTestAccount, createTestContact } from '../test/helpers';
import { contactService } from './contact.service';
import { conversationService } from './conversation.service';
import { saleService, ORIGEM_FECHAMENTO } from './sale.service';
import { tagService, funnelService } from './tag.service';
import { chatMetricsService } from './chat-metrics.service';
import { trackingService } from './tracking.service';

/**
 * Funil com uma etapa livre e as duas fixas, como a migration deixa um funil
 * antigo e como um funil novo nasce.
 */
async function funilComFixas(accountId: string) {
  const funnel = await prismaTest.funnel.create({
    data: { accountId, name: 'Funil', slug: 'funil', isDefault: true },
  });
  const criar = (name: string, slug: string, ordem: number, papel: string | null) =>
    prismaTest.tag.create({
      data: { accountId, funnelId: funnel.id, name, slug, type: 'stage', ordem, papel },
    });
  const novo = await criar('Novo', 'novo', 0, null);
  const fechado = await criar('Fechado', 'fechado', 1, 'fechamento');
  const perdido = await criar('Perdido', 'perdido', 2, 'perda');
  return { funnel, novo, fechado, perdido };
}

const vendasDoFechamento = (contactId: string) =>
  prismaTest.sale.findMany({
    where: { contactId, origem: ORIGEM_FECHAMENTO },
    orderBy: { createdAt: 'asc' },
    include: { items: true },
  });

// Webhook e Purchase são fire-and-forget: deixa assentar antes do TRUNCATE
// do próximo caso, senão o erro aparece no teste errado.
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 300));
});

describe('gatilho pelo Kanban (contact.applyTag)', () => {
  it('entrar em Fechado cria UMA venda pendente; sair e voltar não duplica; etapa comum não cria', async () => {
    const { account, user } = await createTestAccount();
    const { novo, fechado } = await funilComFixas(account.id);
    const contact = await createTestContact(account.id);

    await contactService.applyTag(contact.id, account.id, novo.id, 'kanban', user.id);
    expect(await vendasDoFechamento(contact.id)).toHaveLength(0);

    await contactService.applyTag(contact.id, account.id, fechado.id, 'kanban', user.id);
    const [venda] = await vendasDoFechamento(contact.id);
    expect(venda).toMatchObject({
      accountId: account.id,
      status: 'pending',
      metodoPagamento: 'nao_informado',
      responsavelId: user.id,
      origem: ORIGEM_FECHAMENTO,
      paidAt: null,
    });
    expect(Number(venda.valor)).toBe(0);
    expect(venda.items).toHaveLength(0);

    // Sai, volta: continua uma só.
    await contactService.applyTag(contact.id, account.id, novo.id, 'kanban', user.id);
    await contactService.applyTag(contact.id, account.id, fechado.id, 'kanban', user.id);
    // Reaplicar a mesma etapa (idempotente) também não é entrar de novo.
    await contactService.applyTag(contact.id, account.id, fechado.id, 'kanban', user.id);
    expect(await vendasDoFechamento(contact.id)).toHaveLength(1);
  });

  it('a lista do Kanban devolve fechamento { valor: null } pendente e { valor } depois do PATCH; Purchase sai uma vez', async () => {
    const { account, user } = await createTestAccount();
    const { fechado } = await funilComFixas(account.id);
    const contact = await createTestContact(account.id);
    const servico = await prismaTest.product.create({
      data: { accountId: account.id, nome: 'Consulta', valorPadrao: 0, duracaoMinutos: 30 },
    });
    // Conversa vinda de anúncio: é o que faz o Purchase ter pra onde ir.
    const inbox = await prismaTest.inbox.create({
      data: { accountId: account.id, name: 'WA', channelType: 'whatsapp', evolutionInstance: `i-${Date.now()}` },
    });
    await prismaTest.conversation.create({
      data: { accountId: account.id, inboxId: inbox.id, contactId: contact.id, status: 'open', ctwaClid: 'clid-teste' },
    });
    const purchase = vi.spyOn(trackingService, 'recordConversionEvent').mockResolvedValue(undefined);

    await contactService.applyTag(contact.id, account.id, fechado.id, 'kanban', user.id);

    const antes = await contactService.list({ accountId: account.id }, { page: 1, limit: 50, offset: 0 });
    expect(antes.data[0].fechamento).toEqual({ valor: null, em: expect.any(String) });
    expect(antes.data[0].tags[0]).toMatchObject({ id: fechado.id, papel: 'fechamento' });
    await new Promise((r) => setTimeout(r, 100));
    expect(purchase).not.toHaveBeenCalled();

    // O que o PATCH /contacts/:id/fechamento faz.
    const r = await saleService.registrarFechamento({
      accountId: account.id,
      contactId: contact.id,
      valor: 350,
      productId: servico.id,
      responsavelId: user.id,
      source: 'kanban',
    });
    expect(r).toMatchObject({ criada: false, sale: { valor: 350, status: 'paid' } });

    const vendas = await vendasDoFechamento(contact.id);
    expect(vendas).toHaveLength(1);
    expect(vendas[0].status).toBe('paid');
    expect(vendas[0].paidAt).toBeInstanceOf(Date);
    expect(Number(vendas[0].valor)).toBe(350);
    expect(vendas[0].items).toHaveLength(1);
    expect(vendas[0].items[0]).toMatchObject({ productId: servico.id, quantidade: 1 });
    expect(Number(vendas[0].items[0].valorTotal)).toBe(350);

    const depois = await contactService.list({ accountId: account.id }, { page: 1, limit: 50, offset: 0 });
    expect(depois.data[0].fechamento).toEqual({ valor: 350, em: vendas[0].createdAt.toISOString() });
    expect((await contactService.getById(contact.id, account.id)).fechamento?.valor).toBe(350);

    await new Promise((r) => setTimeout(r, 200));
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(purchase.mock.calls[0][0]).toMatchObject({
      accountId: account.id,
      eventName: 'Purchase',
      contactId: contact.id,
      ctwaClid: 'clid-teste',
      value: 350,
      currency: 'BRL',
      sourceId: vendas[0].id,
    });

    // Venda aparece no histórico do contato.
    const historico = await contactService.getSales(contact.id, account.id, { page: 1, limit: 10, offset: 0 });
    expect(historico.data).toHaveLength(1);
  });
});

describe('gatilho pelo agente/chat (conversation.addLabel)', () => {
  it('o fluxo (ator sentinela flow:<id>) move o lead e a venda pendente sai no nome do admin', async () => {
    const { account, user } = await createTestAccount();
    const { novo, fechado } = await funilComFixas(account.id);
    const contact = await createTestContact(account.id);
    const inbox = await prismaTest.inbox.create({
      data: { accountId: account.id, name: 'WA', channelType: 'whatsapp', evolutionInstance: `i-${Date.now()}` },
    });
    const conv = await prismaTest.conversation.create({
      data: { accountId: account.id, inboxId: inbox.id, contactId: contact.id, status: 'open' },
    });
    await prismaTest.leadTag.create({
      data: { contactId: contact.id, tagId: novo.id, appliedByType: 'system', source: 'system' },
    });

    await conversationService.addLabel(conv.id, account.id, fechado.id, 'flow:fluxo-1');

    // A etapa foi espelhada (uma só) e o sentinela não virou "usuário".
    const leadTags = await prismaTest.leadTag.findMany({ where: { contactId: contact.id } });
    expect(leadTags).toHaveLength(1);
    expect(leadTags[0]).toMatchObject({ tagId: fechado.id, appliedByType: 'system', appliedById: null });

    const vendas = await vendasDoFechamento(contact.id);
    expect(vendas).toHaveLength(1);
    expect(vendas[0]).toMatchObject({ status: 'pending', responsavelId: user.id, origem: ORIGEM_FECHAMENTO });

    // O mesmo gatilho: mover pelo Kanban depois não cria outra.
    await contactService.applyTag(contact.id, account.id, novo.id, 'kanban', user.id);
    await contactService.applyTag(contact.id, account.id, fechado.id, 'kanban', user.id);
    expect(await vendasDoFechamento(contact.id)).toHaveLength(1);
  });
});

describe('dashboard — conversão, receita e perdas', () => {
  it('conta contatos distintos que entraram em fechamento/perda e soma as vendas pagas do período', async () => {
    const { account, user } = await createTestAccount();
    const { novo, fechado, perdido } = await funilComFixas(account.id);
    const [a, b, c, d] = await Promise.all([
      createTestContact(account.id, { nome: 'A' }),
      createTestContact(account.id, { nome: 'B' }),
      createTestContact(account.id, { nome: 'C' }),
      createTestContact(account.id, { nome: 'D' }),
    ]);

    // A fecha com valor; B fecha, sai e volta (um fechamento só); C perde; D fica.
    await contactService.applyTag(a.id, account.id, fechado.id, 'kanban', user.id);
    await saleService.registrarFechamento({ accountId: account.id, contactId: a.id, valor: 1000, responsavelId: user.id, source: 'kanban' });
    await contactService.applyTag(b.id, account.id, fechado.id, 'kanban', user.id);
    await contactService.applyTag(b.id, account.id, novo.id, 'kanban', user.id);
    await contactService.applyTag(b.id, account.id, fechado.id, 'kanban', user.id);
    await contactService.applyTag(c.id, account.id, perdido.id, 'kanban', user.id);
    await contactService.applyTag(d.id, account.id, novo.id, 'kanban', user.id);

    const agora = new Date();
    const m = await chatMetricsService.getFechamentoMetrics(
      account.id,
      new Date(agora.getTime() - 60_000),
      new Date(agora.getTime() + 60_000)
    );

    expect(m).toEqual({
      conversoes: 2,
      novosContatos: 4,
      taxaConversao: 50,
      receita: 1000,
      vendasComValor: 1,
      perdas: 1,
      // Dashboard 06/10: ninguém tem conversa nem reunião; B fechou sem valor.
      atendidos: 0,
      comReuniao: 0,
      ticketMedio: 1000,
      semValor: 1,
    });

    // Fora do período: nada, e a taxa fica sem base.
    const vazio = await chatMetricsService.getFechamentoMetrics(
      account.id,
      new Date('2020-01-01'),
      new Date('2020-01-02')
    );
    expect(vazio).toEqual({
      conversoes: 0,
      novosContatos: 0,
      taxaConversao: null,
      receita: 0,
      vendasComValor: 0,
      perdas: 0,
      atendidos: 0,
      comReuniao: 0,
      ticketMedio: null,
      semValor: 0,
    });
  });
});

describe('etapas fixas no banco', () => {
  it('apagar Fechado é recusado (409) e funil novo nasce com as duas no fim', async () => {
    const { account, user } = await createTestAccount();
    const { fechado } = await funilComFixas(account.id);

    await expect(tagService.delete(fechado.id, account.id, user.id, { force: true })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await prismaTest.tag.findUnique({ where: { id: fechado.id } })).not.toBeNull();

    const funil = await funnelService.create(account.id, 'Segundo', user.id);
    const etapas = await prismaTest.tag.findMany({ where: { funnelId: funil.id }, orderBy: { ordem: 'asc' } });
    expect(etapas.map((t) => [t.name, t.slug, t.papel, t.color, t.ordem])).toEqual([
      ['Fechado', 'fechado-segundo', 'fechamento', '#F0A532', 0],
      ['Perdido', 'perdido-segundo', 'perda', '#E5484D', 1],
    ]);

    // Etapa nova no segundo funil entra antes das fixas.
    const nova = await tagService.create({ accountId: account.id, funnelId: funil.id, name: 'Proposta', type: 'stage' }, user.id);
    const depois = await prismaTest.tag.findMany({ where: { funnelId: funil.id }, orderBy: { ordem: 'asc' } });
    expect(depois.map((t) => t.id)).toEqual([nova.id, etapas[0].id, etapas[1].id]);
  });
});
