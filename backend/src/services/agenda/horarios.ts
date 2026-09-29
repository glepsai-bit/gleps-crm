/**
 * T-039 — o cálculo de horários livres, PURO.
 *
 * O Google Calendar não sabe quando a profissional trabalha nem quanto dura um
 * botox: a API dele só devolve o que está ocupado. Esta função é o que o CRM
 * acrescenta — recebe as regras e a lista de ocupações e devolve os horários
 * que o agente pode oferecer. Sem banco, sem rede: é o que permite testar a
 * aritmética de fuso e de intervalo sem subir nada.
 *
 * Toda a conta é feita NO FUSO DA CONTA. "09:00 de quinta" é 09:00 em
 * São Paulo, não em UTC — e a diferença é exatamente o tipo de erro que só
 * aparece em novembro, quando o horário de verão de alguém muda.
 */

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';

/** Uma faixa de expediente: "09:00" a "12:00". */
export interface FaixaHoraria {
  inicio: string;
  fim: string;
}

/**
 * Expediente por dia da semana. Chave "0" = domingo … "6" = sábado. Dia
 * ausente ou vazio = não atende.
 */
export type HorariosSemanais = Record<string, FaixaHoraria[]>;

export interface Ocupacao {
  inicio: Date;
  fim: Date;
}

export interface Horario {
  inicio: Date;
  fim: Date;
}

export interface ParametrosDeCalculo {
  /** "Agora" — explícito pra ser testável. */
  agora: Date;
  timezone: string;
  horarios: HorariosSemanais;
  /** Duração do serviço, em minutos. */
  duracaoMinutos: number;
  /** Folga antes e depois de cada ocupação, em minutos. */
  intervaloMinutos: number;
  /** De quanto em quanto os horários são oferecidos (09:00, 09:30…). */
  passoMinutos: number;
  /** Não oferecer nada mais perto que isto de `agora`. */
  antecedenciaMinimaMinutos: number;
  /** Nem mais longe que isto. */
  janelaMaximaDias: number;
  /** Janela consultada. `ate` é exclusivo. Cortada pela janela máxima. */
  de: Date;
  ate: Date;
  ocupados: Ocupacao[];
}

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;

/** "09:30" → 570. Texto inválido → null. */
export function minutosDoDia(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Data civil (aaaa-mm-dd) e dia da semana de um instante, no fuso pedido. */
function diaCivil(instante: Date, tz: string): { data: string; diaDaSemana: number } {
  const data = formatInTimeZone(instante, tz, 'yyyy-MM-dd');
  // 'i' é ISO (1 = segunda … 7 = domingo); o expediente usa 0 = domingo.
  const iso = Number(formatInTimeZone(instante, tz, 'i'));
  return { data, diaDaSemana: iso % 7 };
}

/** O instante em que uma hora civil ("2026-10-02" + 570 minutos) acontece no fuso. */
function instanteNoFuso(dataCivil: string, minutos: number, tz: string): Date {
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(minutos % 60).padStart(2, '0');
  return fromZonedTime(`${dataCivil}T${hh}:${mm}:00`, tz);
}

/**
 * Os horários livres de UM profissional.
 *
 * Passo a passo: anda dia a dia pela janela; em cada dia, cada faixa do
 * expediente é fatiada de `passoMinutos` em `passoMinutos`; um candidato
 * [inicio, inicio + duração] entra se cabe na faixa, respeita a antecedência,
 * fica dentro da janela máxima e não encosta em ocupação (a folga `intervalo`
 * é aplicada dos dois lados da ocupação, não do candidato — é a profissional
 * que precisa respirar entre dois atendimentos).
 */
export function calcularHorarios(p: ParametrosDeCalculo): Horario[] {
  const duracaoMs = Math.max(5, p.duracaoMinutos) * MINUTO;
  const passoMs = Math.max(5, p.passoMinutos) * MINUTO;
  const folgaMs = Math.max(0, p.intervaloMinutos) * MINUTO;

  const naoAntesDe = new Date(p.agora.getTime() + Math.max(0, p.antecedenciaMinimaMinutos) * MINUTO);
  const naoDepoisDe = new Date(p.agora.getTime() + Math.max(1, p.janelaMaximaDias) * DIA);
  const inicioJanela = new Date(Math.max(p.de.getTime(), naoAntesDe.getTime()));
  const fimJanela = new Date(Math.min(p.ate.getTime(), naoDepoisDe.getTime()));
  if (inicioJanela >= fimJanela) return [];

  // Ocupações já com a folga aplicada, pra comparar uma vez só por candidato.
  const bloqueios = p.ocupados
    .filter((o) => o.fim > o.inicio)
    .map((o) => ({ inicio: o.inicio.getTime() - folgaMs, fim: o.fim.getTime() + folgaMs }));

  const resultado: Horario[] = [];

  // Anda pelos DIAS CIVIS do fuso, não por blocos de 24h em UTC: um dia com
  // mudança de horário de verão tem 23 ou 25 horas, e o expediente é civil.
  let cursor = new Date(inicioJanela.getTime() - DIA);
  const limite = new Date(fimJanela.getTime() + DIA);
  const diasVistos = new Set<string>();

  while (cursor < limite) {
    const { data, diaDaSemana } = diaCivil(cursor, p.timezone);
    cursor = new Date(cursor.getTime() + DIA);
    if (diasVistos.has(data)) continue;
    diasVistos.add(data);

    const faixas = p.horarios[String(diaDaSemana)] ?? [];
    for (const faixa of faixas) {
      const ini = minutosDoDia(faixa.inicio);
      const fim = minutosDoDia(faixa.fim);
      if (ini === null || fim === null || fim <= ini) continue;

      const faixaInicio = instanteNoFuso(data, ini, p.timezone).getTime();
      const faixaFim = instanteNoFuso(data, fim, p.timezone).getTime();

      for (let t = faixaInicio; t + duracaoMs <= faixaFim; t += passoMs) {
        const candidatoFim = t + duracaoMs;
        if (t < inicioJanela.getTime()) continue;
        if (candidatoFim > fimJanela.getTime()) break;
        const bate = bloqueios.some((b) => t < b.fim && candidatoFim > b.inicio);
        if (bate) continue;
        resultado.push({ inicio: new Date(t), fim: new Date(candidatoFim) });
      }
    }
  }

  resultado.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  return resultado;
}

/**
 * Um horário específico cabe nas regras? Mesma conta de `calcularHorarios`,
 * mas para UM candidato — é o que `agendar` usa pra recusar um id que o modelo
 * inventou ou um horário que já passou da antecedência.
 */
export function horarioValido(p: Omit<ParametrosDeCalculo, 'de' | 'ate'>, inicio: Date): boolean {
  const duracaoMs = Math.max(5, p.duracaoMinutos) * MINUTO;
  const candidatos = calcularHorarios({
    ...p,
    de: new Date(inicio.getTime() - MINUTO),
    ate: new Date(inicio.getTime() + duracaoMs + MINUTO),
  });
  return candidatos.some((c) => c.inicio.getTime() === inicio.getTime());
}

/** Período do dia de um instante, no fuso: manhã (< 12h), tarde (< 18h), noite. */
export function periodoDoDia(instante: Date, tz: string): 'manha' | 'tarde' | 'noite' {
  const hora = Number(formatInTimeZone(instante, tz, 'H'));
  if (hora < 12) return 'manha';
  if (hora < 18) return 'tarde';
  return 'noite';
}

/** "quinta-feira, 02/10 às 14:00" — como o agente e o lembrete falam do horário. */
export function rotuloDoHorario(instante: Date, tz: string): string {
  return formatInTimeZone(instante, tz, "EEEE, dd/MM 'às' HH:mm", { locale: ptBR });
}

/** "02/10" e "14:00" separados — pras variáveis do fluxo ({{agenda.data}}, {{agenda.hora}}). */
export function partesDoHorario(instante: Date, tz: string): { data: string; hora: string; diaDaSemana: string } {
  return {
    data: formatInTimeZone(instante, tz, 'dd/MM', { locale: ptBR }),
    hora: formatInTimeZone(instante, tz, 'HH:mm'),
    diaDaSemana: formatInTimeZone(instante, tz, 'EEEE', { locale: ptBR }),
  };
}

/**
 * "sexta-feira, 03/10/2026, 15:42 (America/Sao_Paulo)" — o bloco AGORA do
 * prompt. O agente não sabia que dia era hoje: "amanhã", "essa semana" e
 * "sexta" não tinham referência nenhuma.
 */
export function agoraPorExtenso(agora: Date, tz: string): string {
  return formatInTimeZone(agora, tz, "EEEE, dd/MM/yyyy, HH:mm", { locale: ptBR }) + ` (${tz})`;
}

/**
 * Valida o expediente vindo da tela. Devolve a versão limpa ou a lista de
 * erros — nunca grava faixa "25:99" pra descobrir na hora de calcular.
 */
export function validarHorarios(raw: unknown): { horarios: HorariosSemanais; erros: string[] } {
  const erros: string[] = [];
  const horarios: HorariosSemanais = {};
  if (raw === null || raw === undefined) return { horarios, erros };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { horarios, erros: ['Horários precisam ser um objeto por dia da semana'] };
  }
  const nomes = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  for (const [dia, faixas] of Object.entries(raw as Record<string, unknown>)) {
    const d = Number(dia);
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      erros.push(`Dia da semana inválido: ${dia}`);
      continue;
    }
    if (!Array.isArray(faixas)) {
      erros.push(`${nomes[d]}: as faixas precisam ser uma lista`);
      continue;
    }
    const limpas: FaixaHoraria[] = [];
    for (const f of faixas) {
      const inicio = typeof (f as FaixaHoraria)?.inicio === 'string' ? (f as FaixaHoraria).inicio.trim() : '';
      const fim = typeof (f as FaixaHoraria)?.fim === 'string' ? (f as FaixaHoraria).fim.trim() : '';
      const a = minutosDoDia(inicio);
      const b = minutosDoDia(fim);
      if (a === null || b === null) {
        erros.push(`${nomes[d]}: horário precisa ser HH:MM`);
        continue;
      }
      if (b <= a) {
        erros.push(`${nomes[d]}: o fim (${fim}) precisa vir depois do início (${inicio})`);
        continue;
      }
      limpas.push({ inicio, fim });
    }
    limpas.sort((x, y) => (minutosDoDia(x.inicio) ?? 0) - (minutosDoDia(y.inicio) ?? 0));
    for (let i = 1; i < limpas.length; i++) {
      if ((minutosDoDia(limpas[i].inicio) ?? 0) < (minutosDoDia(limpas[i - 1].fim) ?? 0)) {
        erros.push(`${nomes[d]}: as faixas se sobrepõem`);
        break;
      }
    }
    if (limpas.length > 0) horarios[String(d)] = limpas;
  }
  return { horarios, erros };
}
