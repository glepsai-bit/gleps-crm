/**
 * AREA T5 — finance service (getKPIs)
 *
 * Cobre:
 * - recurringRate <= 100 (cap)
 * - extraFilters.responsavelId aplica WHERE em todas as agregacoes
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { prismaTest } from '../test/setup';
import { financeService } from './finance.service';

/**
 * Helper local: cria account + admin user direto via prismaTest,
 * sem chamar authService.login (evita o problema de visibilidade
 * cross-client visto em sequencias de testes).
 */
async function createAccountWithUser(name = 'Finance Test') {
  const account = await prismaTest.account.create({ data: { nome: name } });
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin',
      email: `fin-${randomUUID()}@t.com`,
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      permissions: [],
    },
  });
  return { account, user };
}

describe('financeService.getKPIs', () => {
  it('recurringRate eh <= 100 mesmo se todas vendas pagas forem recorrentes', async () => {
    const { account, user } = await createAccountWithUser();

    const contact = await prismaTest.contact.create({
      data: { accountId: account.id, nome: 'Cliente A' },
    });

    // Cria 3 vendas paid + recorrentes (rate ideal = 100%)
    await prismaTest.sale.createMany({
      data: [
        {
          accountId: account.id,
          contactId: contact.id,
          valor: '100.00',
          status: 'paid',
          metodoPagamento: 'pix',
          responsavelId: user.id,
          isRecurring: true,
        },
        {
          accountId: account.id,
          contactId: contact.id,
          valor: '50.00',
          status: 'paid',
          metodoPagamento: 'pix',
          responsavelId: user.id,
          isRecurring: true,
        },
        {
          accountId: account.id,
          contactId: contact.id,
          valor: '30.00',
          status: 'paid',
          metodoPagamento: 'credito',
          responsavelId: user.id,
          isRecurring: true,
        },
      ],
    });

    const kpis = await financeService.getKPIs(account.id, {});
    expect(kpis.paidSales).toBe(3);
    expect(kpis.recurringSales).toBe(3);
    expect(kpis.recurringRate).toBeLessThanOrEqual(100);
    expect(kpis.recurringRate).toBe(100);
  });

  it('recurringRate zero quando ha vendas pagas mas nenhuma recorrente', async () => {
    const { account, user } = await createAccountWithUser();
    const contact = await prismaTest.contact.create({
      data: { accountId: account.id, nome: 'Cliente B' },
    });

    await prismaTest.sale.create({
      data: {
        accountId: account.id,
        contactId: contact.id,
        valor: '99.00',
        status: 'paid',
        metodoPagamento: 'pix',
        responsavelId: user.id,
        isRecurring: false,
      },
    });

    const kpis = await financeService.getKPIs(account.id, {});
    expect(kpis.recurringRate).toBe(0);
    expect(kpis.recurringRate).toBeLessThanOrEqual(100);
  });

  it('extraFilters.responsavelId filtra vendas do responsavel informado', async () => {
    const { account, user: userA } = await createAccountWithUser();

    // Cria um segundo usuario na mesma conta como outro responsavel
    const userB = await prismaTest.user.create({
      data: {
        accountId: account.id,
        nome: 'Responsavel B',
        email: `respb-${Date.now()}@test.com`,
        passwordHash: 'x',
        role: 'agent',
        status: 'active',
        permissions: ['vendas'],
      },
    });

    const contact = await prismaTest.contact.create({
      data: { accountId: account.id, nome: 'Cliente C' },
    });

    // userA: 2 vendas paid, valor 100 + 200
    await prismaTest.sale.createMany({
      data: [
        {
          accountId: account.id,
          contactId: contact.id,
          valor: '100.00',
          status: 'paid',
          metodoPagamento: 'pix',
          responsavelId: userA.id,
          isRecurring: false,
        },
        {
          accountId: account.id,
          contactId: contact.id,
          valor: '200.00',
          status: 'paid',
          metodoPagamento: 'pix',
          responsavelId: userA.id,
          isRecurring: true,
        },
      ],
    });

    // userB: 1 venda paid, valor 999
    await prismaTest.sale.create({
      data: {
        accountId: account.id,
        contactId: contact.id,
        valor: '999.00',
        status: 'paid',
        metodoPagamento: 'pix',
        responsavelId: userB.id,
        isRecurring: false,
      },
    });

    // Sem filtro: pega as 3
    const semFiltro = await financeService.getKPIs(account.id, {});
    expect(semFiltro.paidSales).toBe(3);
    expect(semFiltro.totalRevenue).toBe(1299);

    // Com filtro userA: pega so as 2 (300)
    const comFiltroA = await financeService.getKPIs(
      account.id,
      {},
      { responsavelId: userA.id }
    );
    expect(comFiltroA.paidSales).toBe(2);
    expect(comFiltroA.totalRevenue).toBe(300);
    expect(comFiltroA.recurringSales).toBe(1);
    expect(comFiltroA.recurringRate).toBe(50);

    // Com filtro userB: pega so 1 (999)
    const comFiltroB = await financeService.getKPIs(
      account.id,
      {},
      { responsavelId: userB.id }
    );
    expect(comFiltroB.paidSales).toBe(1);
    expect(comFiltroB.totalRevenue).toBe(999);
  });
});
