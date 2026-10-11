import { prisma } from '../config/database';
import { SaleStatus } from '@prisma/client';
import { NotFoundError, ValidationError } from '../utils/errors';
import { isValidUUID } from '../utils/helpers';
import { logger } from '../utils/logger';
import { eventService } from './event.service';
import { trackingService } from './tracking.service';
import { webhookOutboundService } from './webhook-outbound.service';

/**
 * Desde a etapa C2-V (10/10/2026) a venda só nasce pelo Kanban: o lead entra
 * na etapa Fechado (fechamento.gatilho) ou o usuário informa "Quanto fechou?"
 * (PATCH /contacts/:id/fechamento). Os métodos de gestão (lista, criação
 * manual, pagar, estornar, KPIs, auditoria) saíram junto com as telas de
 * Vendas/Financeiro. O histórico de um contato é lido por contactService.getSales
 * (GET /contacts/:id/sales); dashboard/chat-metrics/insights leem Sale direto.
 */

/** ETAPA B — marca da venda que nasceu do lead entrar na etapa de fechamento. */
export const ORIGEM_FECHAMENTO = 'fechamento';

export interface RegistrarFechamentoInput {
  accountId: string;
  contactId: string;
  /** Quanto fechou. Ausente/0 = fechou sem informar valor (venda pendente). */
  valor?: number | null;
  /** Serviço escolhido, se o usuário escolheu um. */
  productId?: string | null;
  /**
   * Quem moveu o lead. Pode ser um usuário, um sentinela (`flow:<id>`,
   * `api:<id>`) ou nada — a venda exige um responsável de verdade, então quem
   * não é usuário da conta cai no primeiro admin ativo dela.
   */
  responsavelId?: string | null;
  /** De onde veio o movimento (kanban, chat, flow, api...). Só vai pro evento. */
  source: string;
}

export interface ResultadoDoFechamento {
  sale: {
    id: string;
    contactId: string;
    valor: number;
    status: SaleStatus;
    paidAt: Date | null;
    createdAt: Date;
  };
  /** false = já havia venda pendente deste fechamento e nada foi criado. */
  criada: boolean;
}

class SaleService {
  /**
   * O que acontece depois que uma venda vira paga (registrarFechamento com
   * valor): webhook `sale.paid` e o evento 'Purchase' pro Tracking. Os dois
   * são best-effort — nunca lançam, nunca seguram o pagamento.
   */
  private aposPagamento(
    accountId: string,
    sale: { id: string; contactId: string; valor: unknown; paidAt: Date | null }
  ) {
    // PLANO-INTEGRACOES §3.3: sale.paid era FANTASMA (UI oferecia, nunca
    // disparava). Fire-and-forget: falha de webhook não quebra o pagamento.
    webhookOutboundService
      .emit(accountId, 'sale.paid', {
        id: sale.id,
        contactId: sale.contactId,
        valor: Number(sale.valor),
        paidAt: sale.paidAt,
      })
      .catch(() => undefined);

    // TRACKING-CTWA: venda paga de contato vindo de anúncio → 'Purchase'
    // com valor pra Meta (CAPI). Best-effort, nunca lança.
    if (sale.contactId) {
      void trackingService
        .resolveCtwaForContact(accountId, sale.contactId)
        .then((ctwa) => {
          if (!ctwa) return;
          return trackingService.recordConversionEvent({
            accountId,
            eventName: 'Purchase',
            ctwaClid: ctwa.ctwaClid,
            conversationId: ctwa.conversationId,
            contactId: sale.contactId,
            value: Number(sale.valor),
            currency: 'BRL',
            sourceType: 'sale',
            sourceId: sale.id,
          });
        })
        .catch(() => undefined);
    }
  }

  /**
   * Quem assina a venda. Sale.responsavelId é FK pra User, então um sentinela
   * de fluxo/API ou um usuário de outra conta não serve — cai no primeiro
   * admin ativo da conta. Sem admin ativo não há como gravar a venda.
   */
  private async resolverResponsavel(
    accountId: string,
    candidato?: string | null
  ): Promise<{ id: string; ehQuemMoveu: boolean } | null> {
    if (candidato && isValidUUID(candidato)) {
      const usuario = await prisma.user.findFirst({
        where: { id: candidato, accountId },
        select: { id: true },
      });
      if (usuario) return { id: usuario.id, ehQuemMoveu: true };
    }
    const admin = await prisma.user.findFirst({
      where: { accountId, role: 'admin', status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return admin ? { id: admin.id, ehQuemMoveu: false } : null;
  }

  /**
   * ETAPA B — o lead entrou na etapa de fechamento (ou o usuário informou o
   * valor depois). É o único caminho pelo qual o Kanban/agente registra venda.
   *
   * Regras:
   * - sem valor: cria Sale pending (valor 0, origem 'fechamento'), sem evento
   *   de Purchase. Se já há uma pendente deste fechamento, não cria outra —
   *   o lead que sai e volta da etapa não duplica venda.
   * - com valor: completa a pendente (valor, paid, paidAt) ou cria uma já
   *   paga se não houver; dispara webhook + Purchase (valor + moeda).
   * - item só quando há produto: SaleItem exige product_id (FK), então o
   *   fechamento sem serviço escolhido fica só no Sale.valor.
   *
   * É service de núcleo, não rota de módulo: não depende de chave ligada.
   */
  async registrarFechamento(input: RegistrarFechamentoInput): Promise<ResultadoDoFechamento | null> {
    const { accountId, contactId } = input;

    const contact = await prisma.contact.findFirst({
      where: { id: contactId, accountId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundError('Contato');

    const valorInformado = Number(input.valor ?? 0);
    if (!Number.isFinite(valorInformado) || valorInformado < 0) {
      throw new ValidationError('Valor do fechamento inválido');
    }
    const valor = valorInformado > 0 ? Math.round(valorInformado * 100) / 100 : 0;

    let productId: string | null = null;
    if (input.productId) {
      const product = await prisma.product.findFirst({
        where: { id: input.productId, accountId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('Produto');
      productId = product.id;
    }

    const responsavel = await this.resolverResponsavel(accountId, input.responsavelId);
    if (!responsavel) {
      logger.warn('[sale] fechamento sem responsável possível — conta sem admin ativo', {
        accountId,
        contactId,
      });
      return null;
    }
    const ator = responsavel.ehQuemMoveu
      ? { actorType: 'user' as const, actorId: responsavel.id }
      : { actorType: 'system' as const };

    const pendente = await prisma.sale.findFirst({
      where: { accountId, contactId, origem: ORIGEM_FECHAMENTO, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, contactId: true, valor: true, status: true, paidAt: true, createdAt: true },
    });

    const itemDoProduto = (unitario: number) =>
      productId
        ? { create: [{ productId, quantidade: 1, valorUnitario: unitario, valorTotal: unitario }] }
        : undefined;

    // ---- sem valor: pendente, idempotente ----
    if (valor === 0) {
      if (pendente) {
        return { sale: { ...pendente, valor: Number(pendente.valor) }, criada: false };
      }
      const sale = await prisma.sale.create({
        data: {
          accountId,
          contactId,
          valor: 0,
          status: 'pending',
          metodoPagamento: 'nao_informado',
          responsavelId: responsavel.id,
          origem: ORIGEM_FECHAMENTO,
          items: itemDoProduto(0),
        },
      });
      await eventService.create({
        eventType: 'sale.created',
        accountId,
        ...ator,
        entityType: 'sale',
        entityId: sale.id,
        payload: { contactId, valor: 0, origem: ORIGEM_FECHAMENTO, source: input.source, pendente: true },
      });
      return { sale: { ...sale, valor: 0 }, criada: true };
    }

    // ---- com valor: completa a pendente ou cria paga ----
    const agora = new Date();
    let sale;
    if (pendente) {
      sale = await prisma.$transaction(async (tx) => {
        // O serviço escolhido agora vence o que foi guardado na pendente.
        if (productId) await tx.saleItem.deleteMany({ where: { saleId: pendente.id } });
        else await tx.saleItem.updateMany({
          where: { saleId: pendente.id },
          data: { valorUnitario: valor, valorTotal: valor },
        });
        return tx.sale.update({
          where: { id: pendente.id },
          data: { valor, status: 'paid', paidAt: agora, items: itemDoProduto(valor) },
        });
      });
    } else {
      sale = await prisma.sale.create({
        data: {
          accountId,
          contactId,
          valor,
          status: 'paid',
          paidAt: agora,
          metodoPagamento: 'nao_informado',
          responsavelId: responsavel.id,
          origem: ORIGEM_FECHAMENTO,
          items: itemDoProduto(valor),
        },
      });
      await eventService.create({
        eventType: 'sale.created',
        accountId,
        ...ator,
        entityType: 'sale',
        entityId: sale.id,
        payload: { contactId, valor, origem: ORIGEM_FECHAMENTO, source: input.source },
      });
    }

    await eventService.create({
      eventType: 'sale.paid',
      accountId,
      ...ator,
      entityType: 'sale',
      entityId: sale.id,
      payload: { valor, origem: ORIGEM_FECHAMENTO, source: input.source },
    });

    this.aposPagamento(accountId, sale);

    return { sale: { ...sale, valor: Number(sale.valor) }, criada: !pendente };
  }

  /**
   * ETAPA E — o lead foi pra Perdido: a venda pendente do fechamento (valor 0,
   * esperando alguém informar quanto fechou) vira `cancelled`. Só a pendente;
   * venda paga é história e fica. Sem Purchase, sem webhook de pago — só o
   * evento `sale.cancelled` (best-effort). Devolve quantas cancelou.
   */
  async cancelarFechamentoPendente(input: {
    accountId: string;
    contactId: string;
    responsavelId?: string | null;
    source: string;
  }): Promise<{ canceladas: number }> {
    const { accountId, contactId } = input;
    const pendentes = await prisma.sale.findMany({
      where: { accountId, contactId, origem: ORIGEM_FECHAMENTO, status: 'pending' },
      select: { id: true },
    });
    if (pendentes.length === 0) return { canceladas: 0 };

    const ids = pendentes.map((p) => p.id);
    const r = await prisma.sale.updateMany({
      where: { id: { in: ids }, accountId, status: 'pending' },
      data: { status: 'cancelled' },
    });

    const ator =
      input.responsavelId && isValidUUID(input.responsavelId)
        ? { actorType: 'user' as const, actorId: input.responsavelId }
        : { actorType: 'system' as const };
    for (const id of ids) {
      try {
        await eventService.create({
          eventType: 'sale.cancelled',
          accountId,
          ...ator,
          entityType: 'sale',
          entityId: id,
          payload: { contactId, origem: ORIGEM_FECHAMENTO, source: input.source, motivo: 'perda' },
        });
      } catch (err) {
        logger.warn('[sale] evento sale.cancelled não registrado', {
          accountId,
          saleId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[sale] fechamento pendente cancelado — lead foi pra Perdido', {
      accountId,
      contactId,
      canceladas: r.count,
      source: input.source,
    });
    return { canceladas: r.count };
  }
}

export const saleService = new SaleService();
