/**
 * ETAPA B — o gatilho do fechamento.
 *
 * Um contato entra numa etapa por dois caminhos: o Kanban/API
 * (contact.service.applyTag) e a label de conversa que espelha etapa
 * (conversation.service.addLabel — é por aí que o agente de IA move o lead).
 * Os dois chegam aqui, e daqui só sai uma coisa: a venda do fechamento.
 *
 * Nunca lança. A etapa já foi aplicada quando isto roda; se a venda falhar,
 * o lead continua em "Fechado" e o PATCH /contacts/:id/fechamento cria a
 * venda paga quando o usuário informar o valor — o Kanban se cura sozinho.
 * Travar o movimento por causa de um erro de venda seria pior.
 */
import { saleService } from './sale.service';
import { logger } from '../utils/logger';

export interface EntradaNaEtapa {
  accountId: string;
  contactId: string;
  tag: { id: string; name: string; papel: string | null };
  /** Quem moveu: id de usuário, sentinela (`flow:<id>`) ou nada. */
  responsavelId?: string | null;
  source: string;
}

export async function aoEntrarNaEtapa(entrada: EntradaNaEtapa): Promise<void> {
  if (entrada.tag.papel !== 'fechamento') return;

  try {
    await saleService.registrarFechamento({
      accountId: entrada.accountId,
      contactId: entrada.contactId,
      responsavelId: entrada.responsavelId,
      source: entrada.source,
    });
  } catch (err) {
    logger.error('[fechamento] lead entrou em etapa de fechamento mas a venda não foi registrada', {
      accountId: entrada.accountId,
      contactId: entrada.contactId,
      tagId: entrada.tag.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
