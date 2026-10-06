/**
 * ETAPA B — saleService.registrarFechamento.
 *
 * Sem valor → venda pendente (valor 0, nao_informado, origem 'fechamento'),
 * sem Purchase; pendente já existente → não cria outra. Com valor → completa
 * a pendente ou cria paga, e o Purchase sai uma vez. Responsável sentinela
 * (flow/api) cai no primeiro admin ativo da conta.
 *
 * Sem Postgres: prisma, tracking e webhook mockados.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => {
  const sale = { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() };
  const saleItem = { deleteMany: vi.fn(), updateMany: vi.fn() };
  const tx = { sale, saleItem };
  return {
    sale,
    saleItem,
    contact: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});

const trackingMock = vi.hoisted(() => ({
  resolveCtwaForContact: vi.fn(),
  recordConversionEvent: vi.fn(),
}));
const webhookMock = vi.hoisted(() => ({ emit: vi.fn() }));
const eventMock = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('./tracking.service', () => ({ trackingService: trackingMock }));
vi.mock('./webhook-outbound.service', () => ({ webhookOutboundService: webhookMock }));
vi.mock('./event.service', () => ({ eventService: eventMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { saleService, ORIGEM_FECHAMENTO } from './sale.service';

const ACC = 'acc-1';
const CONTATO = 'c0000000-0000-4000-8000-000000000001';
// UUIDs válidos de verdade: o service só aceita como responsável quem passa
// no isValidUUID (sentinela `flow:` cai no admin).
const USUARIO = '0e000000-0000-4000-8000-000000000001';
const ADMIN = '0a000000-0000-4000-8000-000000000001';

/** Espera o fire-and-forget do Purchase assentar. */
const assentar = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contact.findFirst.mockResolvedValue({ id: CONTATO });
  prismaMock.product.findFirst.mockResolvedValue(null);
  prismaMock.user.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.id === USUARIO) return { id: USUARIO };
    if (where.role === 'admin') return { id: ADMIN };
    return null;
  });
  prismaMock.sale.findFirst.mockResolvedValue(null);
  prismaMock.sale.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'sale-nova',
    createdAt: new Date('2026-10-06T12:00:00Z'),
    paidAt: null,
    ...data,
  }));
  prismaMock.sale.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    accountId: ACC,
    contactId: CONTATO,
    createdAt: new Date('2026-10-06T10:00:00Z'),
    ...data,
  }));
  prismaMock.saleItem.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.saleItem.updateMany.mockResolvedValue({ count: 0 });
  trackingMock.resolveCtwaForContact.mockResolvedValue({ ctwaClid: 'clid-1', conversationId: 'conv-1' });
  trackingMock.recordConversionEvent.mockResolvedValue(undefined);
  webhookMock.emit.mockResolvedValue(undefined);
  eventMock.create.mockResolvedValue(undefined);
});

describe('sem valor', () => {
  it('cria venda pendente: valor 0, nao_informado, origem fechamento, SEM Purchase', async () => {
    const r = await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      responsavelId: USUARIO,
      source: 'kanban',
    });

    expect(r).toMatchObject({ criada: true, sale: { id: 'sale-nova', valor: 0, status: 'pending' } });
    expect(prismaMock.sale.create.mock.calls[0][0].data).toMatchObject({
      accountId: ACC,
      contactId: CONTATO,
      valor: 0,
      status: 'pending',
      metodoPagamento: 'nao_informado',
      responsavelId: USUARIO,
      origem: ORIGEM_FECHAMENTO,
    });
    expect(prismaMock.sale.create.mock.calls[0][0].data.items).toBeUndefined();

    await assentar();
    expect(trackingMock.recordConversionEvent).not.toHaveBeenCalled();
    expect(webhookMock.emit).not.toHaveBeenCalled();
  });

  it('já existe pendente deste fechamento → não cria outra (lead saiu e voltou)', async () => {
    prismaMock.sale.findFirst.mockResolvedValue({
      id: 'sale-pendente',
      contactId: CONTATO,
      valor: 0,
      status: 'pending',
      paidAt: null,
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });

    const r = await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      responsavelId: USUARIO,
      source: 'kanban',
    });

    expect(r).toMatchObject({ criada: false, sale: { id: 'sale-pendente', status: 'pending' } });
    expect(prismaMock.sale.create).not.toHaveBeenCalled();
    expect(prismaMock.sale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: ACC, contactId: CONTATO, origem: ORIGEM_FECHAMENTO, status: 'pending' },
      })
    );
  });

  it('sentinela de fluxo não é usuário: a venda sai no nome do primeiro admin ativo', async () => {
    await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      responsavelId: 'flow:flow-1',
      source: 'flow:flow-1',
    });

    expect(prismaMock.sale.create.mock.calls[0][0].data.responsavelId).toBe(ADMIN);
    // Quem assina não é quem moveu → evento é do sistema.
    expect(eventMock.create.mock.calls[0][0]).toMatchObject({ eventType: 'sale.created', actorType: 'system' });
  });

  it('conta sem admin ativo: não grava e devolve null (sem explodir o movimento)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    const r = await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      source: 'kanban',
    });

    expect(r).toBeNull();
    expect(prismaMock.sale.create).not.toHaveBeenCalled();
  });
});

describe('com valor', () => {
  it('sem pendente: cria venda PAGA e dispara Purchase com valor e moeda, uma vez', async () => {
    const r = await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      valor: 1500.5,
      responsavelId: USUARIO,
      source: 'kanban',
    });

    expect(r).toMatchObject({ criada: true, sale: { valor: 1500.5, status: 'paid' } });
    const data = prismaMock.sale.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ valor: 1500.5, status: 'paid', metodoPagamento: 'nao_informado', origem: ORIGEM_FECHAMENTO });
    expect(data.paidAt).toBeInstanceOf(Date);

    await assentar();
    expect(trackingMock.recordConversionEvent).toHaveBeenCalledTimes(1);
    expect(trackingMock.recordConversionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACC,
        eventName: 'Purchase',
        contactId: CONTATO,
        value: 1500.5,
        currency: 'BRL',
        sourceType: 'sale',
        sourceId: 'sale-nova',
      })
    );
    expect(webhookMock.emit).toHaveBeenCalledWith(ACC, 'sale.paid', expect.objectContaining({ id: 'sale-nova', valor: 1500.5 }));
  });

  it('com pendente: completa a pendente (valor, paid, paidAt) em vez de criar outra', async () => {
    prismaMock.sale.findFirst.mockResolvedValue({
      id: 'sale-pendente',
      contactId: CONTATO,
      valor: 0,
      status: 'pending',
      paidAt: null,
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });

    const r = await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      valor: 300,
      responsavelId: USUARIO,
      source: 'kanban',
    });

    expect(r).toMatchObject({ criada: false, sale: { id: 'sale-pendente', valor: 300, status: 'paid' } });
    expect(prismaMock.sale.create).not.toHaveBeenCalled();
    const upd = prismaMock.sale.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'sale-pendente' });
    expect(upd.data).toMatchObject({ valor: 300, status: 'paid' });
    expect(upd.data.paidAt).toBeInstanceOf(Date);

    await assentar();
    expect(trackingMock.recordConversionEvent).toHaveBeenCalledTimes(1);
    expect(trackingMock.recordConversionEvent.mock.calls[0][0]).toMatchObject({ sourceId: 'sale-pendente', value: 300 });
  });

  it('com serviço: item do produto leva o valor; produto de outra conta → 404', async () => {
    prismaMock.product.findFirst.mockResolvedValueOnce({ id: 'prod-1' });

    await saleService.registrarFechamento({
      accountId: ACC,
      contactId: CONTATO,
      valor: 200,
      productId: 'prod-1',
      responsavelId: USUARIO,
      source: 'kanban',
    });
    expect(prismaMock.sale.create.mock.calls[0][0].data.items).toEqual({
      create: [{ productId: 'prod-1', quantidade: 1, valorUnitario: 200, valorTotal: 200 }],
    });

    prismaMock.product.findFirst.mockResolvedValueOnce(null);
    await expect(
      saleService.registrarFechamento({
        accountId: ACC,
        contactId: CONTATO,
        valor: 200,
        productId: 'prod-de-outra-conta',
        responsavelId: USUARIO,
        source: 'kanban',
      })
    ).rejects.toMatchObject({ statusCode: 404, message: 'Produto não encontrado' });
  });

  it('contato de outra conta → 404, nada gravado', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);

    await expect(
      saleService.registrarFechamento({ accountId: ACC, contactId: CONTATO, valor: 10, source: 'kanban' })
    ).rejects.toMatchObject({ statusCode: 404, message: 'Contato não encontrado' });
    expect(prismaMock.sale.create).not.toHaveBeenCalled();
  });
});
