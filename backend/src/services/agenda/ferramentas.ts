/**
 * T-039 — as seis ferramentas de agenda que o agente ganha ao ligar a
 * habilidade. Não são MCP nem ferramenta crua do Google: cada uma carrega a
 * regra do negócio (consultar devolve só o que pode ser oferecido; agendar só
 * aceita o que veio de consultar; cancelar exige reunião existente), e a
 * descrição diz ao modelo QUANDO chamar — que é o que decide se ele chama.
 *
 * As frases "só depois de o lead confirmar" e "nunca invente horário" vêm do
 * prompt de produção que rodava no n8n, onde cada uma existia porque o modelo
 * já tinha errado exatamente aquilo.
 *
 * ETAPA G — a RESERVA PENDENTE pertence à CONVERSA, não à chamada. O piloto
 * perdia 13 de 15 agendamentos porque o modelo reservava num turno e, no
 * seguinte, não tinha mais a ref pra confirmar. Agora `agendar` sem id usa a
 * reserva da conversa, e o bloco AGORA do prompt lembra o modelo dela.
 */

import type { ChatToolDef } from '../ai/chat';
import { agendaService } from '../agenda.service';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { resolverDia, minutosDoDia, nomeDoPeriodo, type Periodo } from './horarios';
import { calendarioSombra } from './sombra';

export interface AgendaDoAgente {
  ativo: boolean;
  profissionalIds: string[];
  produtoIds: string[];
}

/** O que a execução das ferramentas precisa saber além dos argumentos. */
export interface ContextoDeAgenda {
  accountId: string;
  contactId: string | null;
  conversationId: string | null;
  /** Sombra/simulador: nada é gravado — nem no CRM, nem no Google. */
  shadow: boolean;
  /**
   * Sombra: a chave do calendário em memória (a conversa simulada). Sem ela,
   * em sombra, vale `conversationId`; sem nenhum dos dois a reserva fingida
   * não sobrevive ao turno.
   */
  chaveDeSombra?: string | null;
  /**
   * Efeitos colaterais que o FLUXO precisa enxergar (a reunião marcada vira a
   * saída `agendou` do bloco). Bolsa mutável: a ferramenta escreve, o run
   * devolve. Zero consulta a mais.
   */
  efeitos: Record<string, unknown>;
}

export const NOMES_DAS_FERRAMENTAS_DE_AGENDA = [
  'consultar_horarios',
  'reservar',
  'agendar',
  'minha_reuniao',
  'remarcar',
  'cancelar',
] as const;

const NOMES = new Set<string>(NOMES_DAS_FERRAMENTAS_DE_AGENDA);

export function ehFerramentaDeAgenda(nome: string): boolean {
  return NOMES.has(nome);
}

/** Lê o campo `agenda` do agente gravado, tolerante. `null` = desligada. */
export function lerAgendaDoAgente(raw: unknown): AgendaDoAgente | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.ativo !== true) return null;
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  return { ativo: true, profissionalIds: ids(o.profissionalIds), produtoIds: ids(o.produtoIds) };
}

/** Validação estrita do que a tela manda gravar. */
export function validarAgendaDoAgente(raw: unknown): { agenda: AgendaDoAgente | null; erros: string[] } {
  if (raw === null || raw === undefined) return { agenda: null, erros: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { agenda: null, erros: ['agenda precisa ser um objeto'] };
  }
  const o = raw as Record<string, unknown>;
  const erros: string[] = [];
  if (typeof o.ativo !== 'boolean') erros.push('agenda.ativo precisa ser true ou false');
  const ids = (v: unknown, nome: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) {
      erros.push(`agenda.${nome} precisa ser uma lista de ids`);
      return [];
    }
    return Array.from(new Set(v as string[]));
  };
  const profissionalIds = ids(o.profissionalIds, 'profissionalIds');
  const produtoIds = ids(o.produtoIds, 'produtoIds');
  if (o.ativo === true && profissionalIds.length === 0) {
    erros.push('Com a agenda ligada, marque ao menos um profissional');
  }
  if (o.ativo === true && produtoIds.length === 0) {
    erros.push('Com a agenda ligada, marque ao menos um serviço');
  }
  if (erros.length > 0) return { agenda: null, erros };
  return { agenda: { ativo: o.ativo as boolean, profissionalIds, produtoIds }, erros: [] };
}

export interface CatalogoDoAgente {
  timezone: string;
  profissionais: { userId: string; nome: string }[];
  servicos: { id: string; nome: string; duracaoMinutos: number }[];
}

/**
 * As definições que vão ao provider, com os enums montados a partir do que o
 * agente pode marcar. Nomes, não ids: o modelo fala "Dra. Marina", e é o
 * catálogo que traduz de volta.
 */
export async function definicoesDasFerramentasDeAgenda(
  accountId: string,
  agenda: AgendaDoAgente
): Promise<{ tools: ChatToolDef[]; catalogo: CatalogoDoAgente }> {
  const c = await agendaService.catalogoDoAgente(accountId, agenda);
  const catalogo: CatalogoDoAgente = {
    timezone: c.timezone,
    profissionais: c.profissionais.map((p) => ({ userId: p.userId, nome: p.nome })),
    servicos: c.servicos,
  };
  // Sem profissional ou sem serviço ativo nas regras, a habilidade está ligada
  // mas não tem o que oferecer: as ferramentas não entram, e o agente não
  // promete o que não pode cumprir.
  if (catalogo.profissionais.length === 0 || catalogo.servicos.length === 0) {
    return { tools: [], catalogo };
  }

  const nomesDeServico = catalogo.servicos.map((s) => s.nome);
  const nomesDeProfissional = catalogo.profissionais.map((p) => p.nome);
  const listaDeServicos = catalogo.servicos.map((s) => `${s.nome} (${s.duracaoMinutos} min)`).join(', ');
  const listaDeProfissionais = nomesDeProfissional.join(', ');

  const tools: ChatToolDef[] = [
    {
      name: 'consultar_horarios',
      description:
        'Devolve os horários LIVRES que você pode oferecer para um serviço. Chame SEMPRE antes de ' +
        'sugerir qualquer horário — nunca invente nem calcule horário por conta própria. Passe o que o ' +
        'lead pediu: o dia ("amanhã", "terça", "2026-10-20"), o período (manhã/tarde/noite) e/ou o horário ' +
        'desejado ("15:00") — a resposta vem espalhada pelo que foi pedido. Sem pedido, vêm opções dos períodos ' +
        'que têm vaga (manhã, meio-dia, tarde, noite) dos próximos dias. Ofereça ao lead no máximo 3 dos horários devolvidos, sempre com dia da ' +
        'semana e data. Pode chamar de novo com parâmetros diferentes se o lead mudar o pedido. ' +
        `Serviços: ${listaDeServicos}. Profissionais: ${listaDeProfissionais}.`,
      parameters: {
        type: 'object',
        properties: {
          servico: { type: 'string', enum: nomesDeServico, description: 'O serviço que o lead quer.' },
          profissional: {
            type: 'string',
            enum: nomesDeProfissional,
            description: 'Só se o lead pediu alguém específico. Omitido = qualquer um.',
          },
          dia: {
            type: 'string',
            description:
              'O dia que o lead pediu: AAAA-MM-DD, "hoje", "amanhã", "depois de amanhã" ou o nome do dia ' +
              '("terça", "sexta" = a próxima). Omitido = os próximos dias.',
          },
          periodo: {
            type: 'string',
            enum: ['manha', 'tarde', 'noite', 'qualquer'],
            description: 'Período que o lead prefere. "qualquer" ou omitido = sem preferência.',
          },
          horario_desejado: {
            type: 'string',
            description: 'Se o lead pediu uma hora ("às 15h"), no formato HH:MM. Vêm os mais próximos.',
          },
          a_partir_de: {
            type: 'string',
            description: 'Data mínima AAAA-MM-DD se o lead disse "semana que vem", "a partir do dia 10" etc. Ignorado quando `dia` vem.',
          },
        },
        required: ['servico'],
      },
    },
    {
      name: 'reservar',
      description:
        'Segura um horário por alguns minutos enquanto o lead confirma. Chame assim que o lead ' +
        'ESCOLHER um dos horários devolvidos por consultar_horarios, antes de perguntar "confirmo?". ' +
        'Use o id exatamente como veio. A reserva fica guardada NESTA CONVERSA: na mensagem seguinte, ' +
        'quando o lead confirmar, basta chamar agendar sem id.',
      parameters: {
        type: 'object',
        properties: { horario_id: { type: 'string', description: 'O id do horário escolhido.' } },
        required: ['horario_id'],
      },
    },
    {
      name: 'agendar',
      description:
        'Marca a reunião DE VERDADE na agenda de quem atende. Só chame depois de o lead confirmar ' +
        'explicitamente (sim, confirmo, pode marcar). SEM id, marca a reserva pendente desta conversa ' +
        '(a que você fez com reservar — está no bloco AGORA). Com o id de um horário de ' +
        'consultar_horarios, reserva e marca numa chamada só — use quando o lead já disse "sim" ao ' +
        'horário oferecido. Se a resposta disser que o horário acabou de ser ocupado, consulte de novo e ' +
        'ofereça outros — não diga que marcou.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Opcional. Id do horário (de consultar_horarios) ou da reserva. Omitido = a reserva pendente desta conversa.',
          },
        },
      },
    },
    {
      name: 'minha_reuniao',
      description:
        'A próxima reunião marcada desta pessoa. Use quando o lead perguntar quando é, quiser ' +
        'remarcar ou cancelar, ou quando você precisar confirmar se já existe reunião antes de marcar outra.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'remarcar',
      description:
        'Move a reunião marcada desta pessoa para um horário devolvido por consultar_horarios. ' +
        'Confirme o novo horário com o lead antes de chamar.',
      parameters: {
        type: 'object',
        properties: { horario_id: { type: 'string', description: 'O id do novo horário.' } },
        required: ['horario_id'],
      },
    },
    {
      name: 'cancelar',
      description:
        'Cancela a reunião marcada desta pessoa. Só depois de o lead confirmar que quer cancelar. ' +
        'Não use para remarcar — para isso existe remarcar.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'Por que o lead cancelou, em poucas palavras, se disse.' } },
      },
    },
  ];

  return { tools, catalogo };
}

/**
 * Executa uma ferramenta de agenda e devolve o texto que o modelo lê. Toda
 * saída é uma frase que dá pra repassar ao lead — inclusive as recusas: "esse
 * horário acabou de ser ocupado" é o que o modelo precisa dizer.
 */
export async function executarFerramentaDeAgenda(
  nome: string,
  args: Record<string, unknown>,
  ctx: ContextoDeAgenda,
  agenda: AgendaDoAgente,
  catalogo: CatalogoDoAgente
): Promise<string> {
  const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const chaveDeSombra = ctx.shadow ? (ctx.chaveDeSombra ?? ctx.conversationId) : null;

  switch (nome) {
    case 'consultar_horarios': {
      const servico = catalogo.servicos.find((s) => s.nome.toLowerCase() === texto(args.servico).toLowerCase());
      if (!servico) {
        return `Serviço não reconhecido. Os serviços que você pode marcar: ${catalogo.servicos.map((s) => s.nome).join(', ')}.`;
      }
      const nomeProf = texto(args.profissional);
      const prof = nomeProf
        ? catalogo.profissionais.find((p) => p.nome.toLowerCase() === nomeProf.toLowerCase())
        : null;
      if (nomeProf && !prof) {
        return `Profissional não reconhecido. Quem atende: ${catalogo.profissionais.map((p) => p.nome).join(', ')}.`;
      }
      const periodo = lerPeriodo(texto(args.periodo));
      const diaTexto = texto(args.dia);
      const dia = diaTexto ? resolverDia(diaTexto, new Date(), catalogo.timezone) : null;
      if (diaTexto && !dia) {
        return `Não entendi o dia "${diaTexto}". Passe AAAA-MM-DD, "hoje", "amanhã" ou o nome do dia (ex.: terça).`;
      }
      const horarioDesejado = lerHorario(texto(args.horario_desejado));
      if (texto(args.horario_desejado) && !horarioDesejado) {
        return `Não entendi o horário "${texto(args.horario_desejado)}". Passe no formato HH:MM (ex.: 15:00).`;
      }
      const de = dia ? null : dataMinima(texto(args.a_partir_de), catalogo.timezone);

      const { horarios, avisos } = await agendaService.consultarHorarios({
        accountId: ctx.accountId,
        agenda,
        produtoId: servico.id,
        profissionalId: prof?.userId ?? null,
        periodo,
        dia,
        horarioDesejado,
        de,
      });

      const pedido = [
        dia ? `dia ${dia}` : null,
        periodo ? nomeDoPeriodo(periodo) : null,
        horarioDesejado ? `perto das ${horarioDesejado}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      const linhas: string[] = [];
      if (horarios.length === 0) {
        linhas.push(
          periodo
            ? `Nenhum horário livre à ${nomeDoPeriodo(periodo)}${dia ? ` em ${dia}` : ' nos próximos dias'}. Pergunte se outro período ou dia serve e consulte de novo.`
            : `Nenhum horário livre${dia ? ` em ${dia}` : ' nos próximos dias'} para este serviço.${dia ? ' Pergunte se outro dia serve e consulte de novo.' : ''}`
        );
      } else {
        linhas.push(
          `Horários livres para ${servico.nome} (${servico.duracaoMinutos} min)${pedido ? ` — pedido: ${pedido}` : ''}. ` +
            'Ofereça até 3. Se o lead escolher um, chame reservar com o id; se ele já disser "sim" a um deles, chame agendar com o id direto:'
        );
        for (const h of horarios) linhas.push(`- id ${h.id} | ${h.rotulo} | com ${h.profissional}`);
      }
      for (const a of avisos) linhas.push(`Aviso: ${a}.`);
      return linhas.join('\n');
    }

    case 'reservar': {
      const r = await agendaService.reservar({
        accountId: ctx.accountId,
        agenda,
        horarioId: texto(args.horario_id),
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
        shadow: ctx.shadow,
        chaveDeSombra,
      });
      if (!r.ok) return `Não reservei: ${r.motivo}. Consulte os horários de novo e ofereça outro.`;
      const minutos = Math.max(1, Math.round((r.expiraEm.getTime() - Date.now()) / 60_000));
      return (
        `Reservado por ${minutos} min: ${r.rotulo} com ${r.profissional} (${r.servico}). ` +
        'Pergunte ao lead se confirma. A reserva fica guardada nesta conversa: quando ele confirmar, chame agendar (sem id).' +
        (r.simulado ? ' [simulação: nada foi gravado]' : '')
      );
    }

    case 'agendar': {
      const r = await agendaService.agendar({
        accountId: ctx.accountId,
        agenda,
        ref: texto(args.id) || null,
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
        shadow: ctx.shadow,
        chaveDeSombra,
      });
      if (!r.ok) return `NÃO marquei: ${r.motivo}. Não diga ao lead que está marcado. Consulte os horários e ofereça outro.`;
      ctx.efeitos.agendou = r.reuniao;
      return (
        `Marcado: ${r.reuniao.rotulo} com ${r.reuniao.profissional} — ${r.reuniao.servico}. ` +
        'Confirme ao lead exatamente este dia e horário e avise que ele receberá um lembrete.' +
        (r.avisos.length ? ` Aviso interno: ${r.avisos.join('; ')}.` : '') +
        (r.reuniao.simulado ? ' [simulação: nada foi gravado no Google]' : '')
      );
    }

    case 'minha_reuniao': {
      // Em sombra a reunião "marcada" vive no calendário em memória.
      const daSombra = chaveDeSombra ? calendarioSombra.marcada(chaveDeSombra) : null;
      if (daSombra) return `Reunião marcada: ${daSombra.rotulo} com ${daSombra.profissional} — ${daSombra.servico}. [simulação]`;
      const r = await agendaService.minhaReuniao(ctx.accountId, ctx.contactId, new Date(), !ctx.shadow);
      if (!r) return 'Esta pessoa não tem reunião marcada.';
      return `Reunião marcada: ${r.rotulo} com ${r.profissional} — ${r.servico}.`;
    }

    case 'remarcar': {
      const daSombra = chaveDeSombra ? calendarioSombra.marcada(chaveDeSombra) : null;
      if (daSombra) {
        // Remarcar em sombra = marcar o novo horário fingido no lugar do antigo.
        const r = await agendaService.agendar({
          accountId: ctx.accountId,
          agenda,
          ref: texto(args.horario_id) || null,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          shadow: true,
          chaveDeSombra,
        });
        if (!r.ok) return `NÃO remarquei: ${r.motivo}. Não diga ao lead que mudou.`;
        ctx.efeitos.remarcou = r.reuniao;
        return `Remarcado: de ${daSombra.rotulo} para ${r.reuniao.rotulo} com ${r.reuniao.profissional}. Confirme o novo horário ao lead. [simulação: nada foi gravado]`;
      }
      const r = await agendaService.remarcar({
        accountId: ctx.accountId,
        agenda,
        horarioId: texto(args.horario_id),
        contactId: ctx.contactId,
        shadow: ctx.shadow,
      });
      if (!r.ok) return `NÃO remarquei: ${r.motivo}. Não diga ao lead que mudou.`;
      ctx.efeitos.remarcou = r.reuniao;
      return (
        `Remarcado: de ${r.anterior} para ${r.reuniao.rotulo} com ${r.reuniao.profissional}. Confirme o novo horário ao lead.` +
        (r.reuniao.simulado ? ' [simulação: nada foi gravado]' : '')
      );
    }

    case 'cancelar': {
      const daSombra = chaveDeSombra ? calendarioSombra.marcada(chaveDeSombra) : null;
      if (daSombra) {
        calendarioSombra.cancelar(chaveDeSombra!);
        ctx.efeitos.cancelou = { rotulo: daSombra.rotulo, profissional: daSombra.profissional };
        return `Cancelado: ${daSombra.rotulo} com ${daSombra.profissional}. Confirme ao lead e ofereça remarcar se fizer sentido. [simulação]`;
      }
      const r = await agendaService.cancelar({
        accountId: ctx.accountId,
        contactId: ctx.contactId,
        motivo: texto(args.motivo) || null,
        shadow: ctx.shadow,
      });
      if (!r.ok) return `NÃO cancelei: ${r.motivo}.`;
      ctx.efeitos.cancelou = { rotulo: r.rotulo, profissional: r.profissional };
      return `Cancelado: ${r.rotulo} com ${r.profissional}. Confirme ao lead e ofereça remarcar se fizer sentido.` + (r.simulado ? ' [simulação]' : '');
    }

    default:
      return `Ferramenta "${nome}" não está disponível.`;
  }
}

/** "manha" | "tarde" | "noite" → período; "qualquer", vazio ou lixo → null. */
function lerPeriodo(v: string): Periodo | null {
  const t = v.toLowerCase().replace('ã', 'a');
  if (t === 'manha' || t === 'tarde' || t === 'noite') return t;
  return null;
}

/** "15:00", "15h", "15h30", "15" → "15:00"/"15:30"; lixo → null. */
function lerHorario(v: string): string | null {
  if (!v) return null;
  const t = v.toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?$/.exec(t);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2] ?? '0');
  if (hh > 23 || mm > 59) return null;
  const hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return minutosDoDia(hhmm) === null ? null : hhmm;
}

/** "2026-10-10" no fuso da conta → o instante em que aquele dia começa. Inválido → null. */
function dataMinima(aaaaMmDd: string, tz: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(aaaaMmDd)) return null;
  const d = fromZonedTime(`${aaaaMmDd}T00:00:00`, tz);
  if (Number.isNaN(d.getTime())) return null;
  // "2026-02-31" vira 3 de março: se a data não sobreviveu, não era data.
  return formatInTimeZone(d, tz, 'yyyy-MM-dd') === aaaaMmDd ? d : null;
}
