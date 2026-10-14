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
export function instanteNoFuso(dataCivil: string, minutos: number, tz: string): Date {
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(minutos % 60).padStart(2, '0');
  return fromZonedTime(`${dataCivil}T${hh}:${mm}:00`, tz);
}

/** "2026-10-02" + n dias, em data civil — sem passar por fuso (não há hora envolvida). */
export function somarDiasCivis(dataCivil: string, dias: number): string {
  const [y, m, d] = dataCivil.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + dias));
  return utc.toISOString().slice(0, 10);
}

/** [início, fim) de um dia civil no fuso — o fim é o início do dia seguinte. */
export function janelaDoDiaCivil(dataCivil: string, tz: string): { inicio: Date; fim: Date } {
  return {
    inicio: instanteNoFuso(dataCivil, 0, tz),
    fim: instanteNoFuso(somarDiasCivis(dataCivil, 1), 0, tz),
  };
}

const DIAS_DA_SEMANA: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
};

/**
 * O dia que o lead pediu → data civil no fuso da conta. Aceita ISO
 * ("2026-10-14"), "dd/mm", "hoje", "amanhã", "depois de amanhã" e nome de dia
 * ("terça", "terça-feira", "sexta"). Nome de dia é o PRÓXIMO: "terça" numa
 * terça é a da semana que vem — pra hoje existe "hoje". Lixo → null.
 */
export function resolverDia(texto: string, agora: Date, tz: string): string | null {
  const t = String(texto ?? '')
    .trim()
    .toLowerCase()
    .replace(/-feira$/, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const hoje = formatInTimeZone(agora, tz, 'yyyy-MM-dd');

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    // "2026-02-31" vira 3 de março (ou data inválida): se não sobreviveu, não era data.
    const d = instanteNoFuso(t, 0, tz);
    if (Number.isNaN(d.getTime())) return null;
    return formatInTimeZone(d, tz, 'yyyy-MM-dd') === t ? t : null;
  }
  const ddmm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(t);
  if (ddmm) {
    const ano = ddmm[3] ? Number(ddmm[3]) : Number(hoje.slice(0, 4));
    const data = `${ano}-${ddmm[2].padStart(2, '0')}-${ddmm[1].padStart(2, '0')}`;
    const valida = resolverDia(data, agora, tz);
    if (!valida) return null;
    // Sem ano e já passou: é do ano que vem.
    return !ddmm[3] && valida < hoje ? resolverDia(`${ano + 1}${data.slice(4)}`, agora, tz) : valida;
  }
  if (t === 'hoje') return hoje;
  if (t === 'amanha' || t === 'amanhã') return somarDiasCivis(hoje, 1);
  if (t === 'depois de amanha' || t === 'depois de amanhã') return somarDiasCivis(hoje, 2);

  const alvo = DIAS_DA_SEMANA[t];
  if (alvo === undefined) return null;
  const hojeDia = Number(formatInTimeZone(agora, tz, 'i')) % 7;
  const delta = ((alvo - hojeDia + 7) % 7) || 7;
  return somarDiasCivis(hoje, delta);
}

export type Periodo = 'manha' | 'meio_dia' | 'tarde' | 'noite';

const NOMES_DOS_PERIODOS: Record<Periodo, string> = { manha: 'manhã', meio_dia: 'meio-dia', tarde: 'tarde', noite: 'noite' };

/** Como o agente fala do período: "manhã", "tarde"… */
export function nomeDoPeriodo(p: Periodo): string {
  return NOMES_DOS_PERIODOS[p];
}

/**
 * Até `n` itens ESPALHADOS pela lista: o primeiro, o último e o que couber
 * no meio em passos iguais. "09:00, 09:30, 10:00" não ajuda quem só pode no
 * fim da tarde — "09:00, 13:00, 17:30" dá a ideia do dia inteiro.
 */
export function espacados<T>(lista: T[], n: number): T[] {
  if (n <= 0) return [];
  if (lista.length <= n) return lista;
  if (n === 1) return [lista[0]];
  const saida: T[] = [];
  const vistos = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (lista.length - 1)) / (n - 1));
    if (vistos.has(idx)) continue;
    vistos.add(idx);
    saida.push(lista[idx]);
  }
  return saida;
}

export interface OpcoesDeSelecao {
  tz: string;
  /** Teto total. */
  limite: number;
  /** Só este período do dia. Ausente = todos. */
  periodo?: Periodo | null;
  /** Em minutos do dia ("15:00" = 900): os mais próximos vencem, por dia. */
  horarioDesejadoMinutos?: number | null;
  /** Quantos por dia. Padrão 3. */
  porDia?: number;
  /**
   * Modo "sem pedido": N por período em cada dia (ex.: { manha: 2, tarde: 2 }); período sem vaga não
   * rende nada. Se `porDia` vier junto, o dia é aparado a esse tamanho ESPALHANDO (não cortando o
   * fim) — quando manhã, meio-dia e tarde têm vaga, o dia ainda mostra o começo e o fim.
   */
  quotaPorPeriodo?: Partial<Record<Periodo, number>> | null;
  /** Quantos dias distintos no máximo. Ausente = o limite manda. */
  diasMaximos?: number | null;
}

/**
 * Seleciona o que OFERECER dentre todos os horários livres.
 *
 * Por dia, nunca os primeiros da grade: espalhados pelo período (ou os mais
 * próximos do horário pedido). Entre dias, em rodadas — um de cada dia antes
 * do segundo de qualquer dia — pra quem só pode na sexta ver a sexta. Saída
 * em ordem cronológica.
 */
export function selecionarHorarios<T extends { inicio: Date }>(horarios: T[], o: OpcoesDeSelecao): T[] {
  const limite = Math.max(0, o.limite);
  if (limite === 0 || horarios.length === 0) return [];
  const porDia = Math.max(1, o.porDia ?? 3);

  const minutosDe = (h: T) => Number(formatInTimeZone(h.inicio, o.tz, 'H')) * 60 + Number(formatInTimeZone(h.inicio, o.tz, 'm'));

  // Agrupa por dia civil, em ordem.
  const dias = new Map<string, T[]>();
  for (const h of [...horarios].sort((a, b) => a.inicio.getTime() - b.inicio.getTime())) {
    if (o.periodo && periodoDoDia(h.inicio, o.tz) !== o.periodo) continue;
    const dia = formatInTimeZone(h.inicio, o.tz, 'yyyy-MM-dd');
    if (!dias.has(dia)) dias.set(dia, []);
    dias.get(dia)!.push(h);
  }

  // O que cada dia tem a oferecer, já na ordem em que entra nas rodadas.
  const filas: T[][] = [];
  for (const lista of dias.values()) {
    let escolhidos: T[];
    if (o.horarioDesejadoMinutos !== null && o.horarioDesejadoMinutos !== undefined) {
      const alvo = o.horarioDesejadoMinutos;
      escolhidos = [...lista]
        .sort((a, b) => Math.abs(minutosDe(a) - alvo) - Math.abs(minutosDe(b) - alvo) || a.inicio.getTime() - b.inicio.getTime())
        .slice(0, porDia);
    } else if (o.quotaPorPeriodo) {
      escolhidos = [];
      for (const [periodo, n] of Object.entries(o.quotaPorPeriodo) as [Periodo, number][]) {
        escolhidos.push(...espacados(lista.filter((h) => periodoDoDia(h.inicio, o.tz) === periodo), n));
      }
      escolhidos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
      if (o.porDia !== undefined) escolhidos = espacados(escolhidos, porDia);
    } else {
      escolhidos = espacados(lista, porDia);
    }
    if (escolhidos.length > 0) filas.push(escolhidos);
    if (o.diasMaximos && filas.length >= o.diasMaximos) break;
  }

  // Rodadas entre os dias.
  const resultado: T[] = [];
  for (let rodada = 0; resultado.length < limite; rodada++) {
    let pegou = false;
    for (const fila of filas) {
      if (resultado.length >= limite) break;
      const h = fila[rodada];
      if (h) {
        resultado.push(h);
        pegou = true;
      }
    }
    if (!pegou) break;
  }
  return resultado.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
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

/**
 * Período do dia de um instante, no fuso: manhã (< 12h), meio-dia (12h–13h),
 * tarde (13h–18h), noite. O meio-dia é período próprio de propósito: "de
 * tarde" pra um lead é depois do almoço — oferecer 12:00 a quem pediu tarde
 * é o tipo de resposta que faz a pessoa achar que o agente não entendeu.
 */
export function periodoDoDia(instante: Date, tz: string): Periodo {
  const hora = Number(formatInTimeZone(instante, tz, 'H'));
  if (hora < 12) return 'manha';
  if (hora < 13) return 'meio_dia';
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
