/**
 * ETAPA G — o calendário EM MEMÓRIA da sombra.
 *
 * Em sombra (simulador do provisionamento, fluxo em shadow) nada pode ir pro
 * banco nem pro Google. Mas o agente precisa de uma reserva que SOBREVIVA ao
 * turno: "reservei terça às 15h" numa mensagem e "confirmo" na seguinte só
 * funciona se alguém lembrar o que foi reservado. Antes, a reserva fingida
 * morria com a resposta e o `agendar` do turno seguinte não tinha o que
 * confirmar — era o 13/15 do piloto, em versão simulada.
 *
 * Cada CONVERSA tem o seu calendário (a chave): duas conversas simuladas
 * no mesmo horário não se bloqueiam, porque o conflito entre elas é
 * invenção da simulação, não do mundo. Os horários CONSULTADOS continuam
 * reais — o que é fingido é só a reserva e a marcação.
 *
 * Nada aqui é persistente: TTL de duas horas e limpeza preguiçosa. Vazar
 * memória por 30 conversas de simulação não é risco; por 30 mil, seria.
 */

export interface HorarioDaSombra {
  /** O id do horário (de consultar_horarios) que originou a reserva. */
  horarioId: string;
  profissionalId: string;
  produtoId: string;
  inicio: Date;
  fim: Date;
  rotulo: string;
  profissional: string;
  servico: string;
}

export interface ReservaDaSombra extends HorarioDaSombra {
  expiraEm: Date;
}

interface EstadoDaConversa {
  pendente: ReservaDaSombra | null;
  marcada: HorarioDaSombra | null;
  tocadoEm: number;
}

const TTL_MS = 2 * 60 * 60_000;
/** A partir daqui a limpeza preguiçosa roda a cada acesso. */
const LIMIAR_DE_LIMPEZA = 500;

class CalendarioSombra {
  private readonly porChave = new Map<string, EstadoDaConversa>();

  private estado(chave: string): EstadoDaConversa {
    this.limparVencidos();
    let e = this.porChave.get(chave);
    if (!e) {
      e = { pendente: null, marcada: null, tocadoEm: Date.now() };
      this.porChave.set(chave, e);
    }
    e.tocadoEm = Date.now();
    return e;
  }

  /** Uma reserva por conversa: a nova substitui a anterior (o lead mudou de ideia). */
  reservar(chave: string, reserva: ReservaDaSombra): void {
    this.estado(chave).pendente = reserva;
  }

  pendente(chave: string): ReservaDaSombra | null {
    return this.estado(chave).pendente;
  }

  /** A reserva vira reunião. Sem reserva pendente, a reunião entra direto (agendar por horário). */
  confirmar(chave: string, reuniao: HorarioDaSombra): void {
    const e = this.estado(chave);
    e.pendente = null;
    e.marcada = reuniao;
  }

  marcada(chave: string): HorarioDaSombra | null {
    return this.estado(chave).marcada;
  }

  cancelar(chave: string): void {
    this.estado(chave).marcada = null;
  }

  /** Fim da conversa simulada: nada dela precisa ficar. */
  limpar(chave: string): void {
    this.porChave.delete(chave);
  }

  /** Só pra teste. */
  __limparTudo(): void {
    this.porChave.clear();
  }

  private limparVencidos(): void {
    if (this.porChave.size < LIMIAR_DE_LIMPEZA) return;
    const limite = Date.now() - TTL_MS;
    for (const [k, e] of this.porChave) {
      if (e.tocadoEm < limite) this.porChave.delete(k);
    }
  }
}

export const calendarioSombra = new CalendarioSombra();
