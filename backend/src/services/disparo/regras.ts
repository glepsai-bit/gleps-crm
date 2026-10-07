/**
 * ETAPA D — regras puras do motor de disparos. Sem banco, sem rede: é o que
 * dá pra testar com relógio fixo. O service e o worker só orquestram.
 *
 * - renderizarMensagem: variantes alternadas + {{nome}} {{primeiro_nome}} {{empresa}} (e {nome} legado)
 * - distribuirPorNumero: rodízio ponderado pela capacidade restante do dia
 * - calcularHorarios: ritmo 20–60 s, janela 08h–20h no fuso da conta, cota por dia
 * - classificarErroEvolution: INFRA (não é culpa do número) × NUMERO (conta falha)
 */
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { primeiroNome } from '../../utils/telefone';

export const JANELA_INICIO_HORA = 8;
export const JANELA_FIM_HORA = 20;
export const INTERVALO_MIN_S = 20;
export const INTERVALO_MAX_S = 60;
/** Intervalo médio: é o que a UI usa pra estimar "termina por volta das". */
export const INTERVALO_MEDIO_S = 40;
export const FALHAS_SEGUIDAS_PARA_PAUSAR = 5;
/** Número que nunca aqueceu pode disparar pouco (contrato). */
export const LIMITE_NAO_AQUECIDO = 50;
export const FUSO_PADRAO = 'America/Sao_Paulo';

// ============================================
// Render
// ============================================

export interface VariaveisDoEnvio {
  nome?: string | null;
  primeiro_nome?: string | null;
  empresa?: string | null;
}

/** Monta as variáveis a partir do que a lista sabe do contato. */
export function variaveisDoContato(nome: string | null | undefined, empresa?: string | null): VariaveisDoEnvio {
  const n = (nome ?? '').trim();
  return {
    nome: n,
    primeiro_nome: primeiroNome(n),
    empresa: (empresa ?? '').trim(),
  };
}

/**
 * Substitui {{nome}} {{primeiro_nome}} {{empresa}} e o `{nome}` legado do
 * motor antigo. Variável sem valor vira vazio (não fica o placeholder na
 * mensagem do cliente). Espaço duplo que sobrar de "Olá {{nome}}, " vazio
 * é colapsado.
 */
export function renderizarTexto(texto: string, variaveis: VariaveisDoEnvio | null | undefined): string {
  const v = variaveis ?? {};
  const valores: Record<string, string> = {
    nome: (v.nome ?? '').toString(),
    primeiro_nome: (v.primeiro_nome ?? primeiroNome(v.nome)).toString(),
    empresa: (v.empresa ?? '').toString(),
  };
  const saida = texto
    .replace(/\{\{\s*(nome|primeiro_nome|empresa)\s*\}\}/gi, (_m, chave: string) => valores[chave.toLowerCase()] ?? '')
    .replace(/\{\s*(nome|primeiro_nome|empresa)\s*\}/gi, (_m, chave: string) => valores[chave.toLowerCase()] ?? '');
  return saida.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?;:])/g, '$1').trim();
}

/** [texto, ...variantes] sem vazios — o pool que o rodízio de variantes usa. */
export function poolDeVariantes(texto: string, variantes: unknown): string[] {
  const extras = Array.isArray(variantes)
    ? (variantes as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  return [texto, ...extras];
}

/** Texto final do envio N: variante N % total, com as variáveis do contato. */
export function renderizarMensagem(
  texto: string,
  variantes: unknown,
  variante: number,
  variaveis: VariaveisDoEnvio | null | undefined
): string {
  const pool = poolDeVariantes(texto, variantes);
  const base = pool[((variante % pool.length) + pool.length) % pool.length];
  return renderizarTexto(base, variaveis);
}

/** As variáveis {{x}} que um texto usa (pra conferir que a IA manteve). */
export function variaveisUsadas(texto: string): Set<string> {
  const achadas = new Set<string>();
  for (const m of texto.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) achadas.add(m[1].toLowerCase());
  return achadas;
}

// ============================================
// Rodízio entre números
// ============================================

export interface CapacidadeDoNumero {
  inboxId: string;
  status: 'pronto' | 'aquecendo' | 'pausado' | 'nao_aquecido';
  dia: number;
  limiteDiario: number;
  restantesHoje: number;
}

/**
 * Rodízio ponderado (smooth weighted round-robin): o envio k vai pro número
 * que está mais "atrasado" em relação ao seu peso. Peso = restantesHoje; se
 * todos zero, pesos iguais. `presos` prende um contato a um número (quem já
 * conversou por aquele número continua nele) e conta na cota dele.
 *
 * Devolve o inboxId de cada posição, na ordem dos destinatários.
 */
export function distribuirPorNumero(
  quantidade: number,
  capacidades: CapacidadeDoNumero[],
  presos: Array<string | null | undefined> = []
): string[] {
  if (capacidades.length === 0) throw new Error('distribuirPorNumero: sem números');
  const todosZero = capacidades.every((c) => (c.restantesHoje ?? 0) <= 0);
  const pesos = new Map<string, number>();
  for (const c of capacidades) pesos.set(c.inboxId, todosZero ? 1 : Math.max(c.restantesHoje, 0));
  // Número com peso 0 no meio de outros com peso não recebe nada hoje — mas
  // continua elegível caso TODOS estejam zerados (já tratado acima).
  const atribuidos = new Map<string, number>();
  for (const c of capacidades) atribuidos.set(c.inboxId, 0);

  const resultado: string[] = new Array(quantidade);
  for (let k = 0; k < quantidade; k++) {
    const preso = presos[k];
    if (preso && pesos.has(preso)) {
      resultado[k] = preso;
      atribuidos.set(preso, (atribuidos.get(preso) ?? 0) + 1);
      continue;
    }
    let escolhido: string | null = null;
    let melhor = Number.POSITIVE_INFINITY;
    for (const c of capacidades) {
      const peso = pesos.get(c.inboxId) ?? 0;
      if (peso <= 0) continue;
      const razao = ((atribuidos.get(c.inboxId) ?? 0) + 1) / peso;
      if (razao < melhor) {
        melhor = razao;
        escolhido = c.inboxId;
      }
    }
    if (!escolhido) escolhido = capacidades[0].inboxId;
    resultado[k] = escolhido;
    atribuidos.set(escolhido, (atribuidos.get(escolhido) ?? 0) + 1);
  }
  return resultado;
}

// ============================================
// Janela e horários
// ============================================

function zonado(data: Date, fuso: string): Date {
  try {
    return toZonedTime(data, fuso);
  } catch {
    return toZonedTime(data, FUSO_PADRAO);
  }
}

function deZonado(local: Date, fuso: string): Date {
  try {
    return fromZonedTime(local, fuso);
  } catch {
    return fromZonedTime(local, FUSO_PADRAO);
  }
}

/** "YYYY-MM-DD" no fuso da conta — a chave de "dia" pra cota diária. */
export function diaLocal(data: Date, fuso: string): string {
  const z = zonado(data, fuso);
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, '0');
  const d = String(z.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dentroDaJanela(data: Date, fuso: string): boolean {
  const h = zonado(data, fuso).getHours();
  return h >= JANELA_INICIO_HORA && h < JANELA_FIM_HORA;
}

/**
 * Próximo instante dentro da janela a partir de `data` (inclusive):
 * - já dentro → a própria data;
 * - antes das 08h → 08h de hoje;
 * - 20h ou depois → 08h de amanhã.
 */
export function proximaAbertura(data: Date, fuso: string): Date {
  if (dentroDaJanela(data, fuso)) return data;
  const z = zonado(data, fuso);
  const alvo = new Date(z.getTime());
  if (z.getHours() >= JANELA_FIM_HORA) alvo.setDate(alvo.getDate() + 1);
  alvo.setHours(JANELA_INICIO_HORA, 0, 0, 0);
  return deZonado(alvo, fuso);
}

/** 08h do dia seguinte ao de `data`, no fuso. */
export function aberturaDoDiaSeguinte(data: Date, fuso: string): Date {
  const z = zonado(data, fuso);
  const alvo = new Date(z.getTime());
  alvo.setDate(alvo.getDate() + 1);
  alvo.setHours(JANELA_INICIO_HORA, 0, 0, 0);
  return deZonado(alvo, fuso);
}

export interface CotaDoNumero {
  inboxId: string;
  /** Quantos ainda cabem HOJE (restantesHoje do aquecimento). */
  restantesHoje: number;
  /** Quantos cabem por dia a partir de amanhã (limiteDiario; 0 → LIMITE_NAO_AQUECIDO). */
  limiteDiario: number;
}

export interface OpcoesDeHorario {
  /** Gerador de aleatório em [0,1) — injetável nos testes. */
  aleatorio?: () => number;
  /** Jitter em segundos. Padrão 20–60. */
  minS?: number;
  maxS?: number;
}

/**
 * Calcula `nao_antes_de` de cada envio. Entrada: a ordem dos envios com o
 * número de cada um. Cada número tem o seu cursor, que começa em `inicio`:
 * cada envio soma um jitter uniforme (20–60 s); fora da janela 08h–20h vai
 * pras 08h seguintes; estourou a cota do dia → 08h do dia seguinte, e a
 * cota passa a ser a diária. `inicio` fora da janela já começa na abertura.
 *
 * Dois números andam em paralelo (cursores independentes) — é o rodízio.
 */
export function calcularHorarios(
  inicio: Date,
  fuso: string,
  inboxPorEnvio: string[],
  cotas: CotaDoNumero[],
  opcoes: OpcoesDeHorario = {}
): Date[] {
  const aleatorio = opcoes.aleatorio ?? Math.random;
  const minS = opcoes.minS ?? INTERVALO_MIN_S;
  const maxS = opcoes.maxS ?? INTERVALO_MAX_S;
  const fusoOk = fuso || FUSO_PADRAO;

  interface Cursor {
    quando: Date;
    dia: string;
    usadosNoDia: number;
    cotaDoDia: number;
    cotaDiaria: number;
    primeiro: boolean;
  }
  const cursores = new Map<string, Cursor>();
  const partida = proximaAbertura(inicio, fusoOk);
  for (const c of cotas) {
    const cotaDiaria = c.limiteDiario > 0 ? c.limiteDiario : LIMITE_NAO_AQUECIDO;
    const hojeEhDiaDaPartida = diaLocal(partida, fusoOk) === diaLocal(inicio, fusoOk);
    cursores.set(c.inboxId, {
      quando: partida,
      dia: diaLocal(partida, fusoOk),
      usadosNoDia: 0,
      // A cota de "hoje" só vale se a partida ainda é hoje; se já pulou pra
      // amanhã (criado às 21h), vale a diária.
      cotaDoDia: hojeEhDiaDaPartida ? Math.max(c.restantesHoje, 0) : cotaDiaria,
      cotaDiaria,
      primeiro: true,
    });
  }

  const resultado: Date[] = new Array(inboxPorEnvio.length);
  for (let k = 0; k < inboxPorEnvio.length; k++) {
    const inboxId = inboxPorEnvio[k];
    let cur = cursores.get(inboxId);
    if (!cur) {
      cur = {
        quando: partida,
        dia: diaLocal(partida, fusoOk),
        usadosNoDia: 0,
        cotaDoDia: LIMITE_NAO_AQUECIDO,
        cotaDiaria: LIMITE_NAO_AQUECIDO,
        primeiro: true,
      };
      cursores.set(inboxId, cur);
    }

    // O primeiro envio de cada número sai na partida (sem esperar o jitter).
    if (!cur.primeiro) {
      const jitterS = minS + Math.floor(aleatorio() * (maxS - minS + 1));
      cur.quando = new Date(cur.quando.getTime() + jitterS * 1000);
    }
    cur.primeiro = false;

    // Janela: 20h+ ou antes das 08h → próxima abertura.
    const dentro = dentroDaJanela(cur.quando, fusoOk);
    if (!dentro) {
      cur.quando = proximaAbertura(cur.quando, fusoOk);
    }
    // Virou o dia (pela janela ou naturalmente): zera o contador.
    const diaAtual = diaLocal(cur.quando, fusoOk);
    if (diaAtual !== cur.dia) {
      cur.dia = diaAtual;
      cur.usadosNoDia = 0;
      cur.cotaDoDia = cur.cotaDiaria;
    }
    // Cota do dia estourada → 08h do dia seguinte (quantas vezes precisar —
    // uma cota diária de 0 nunca acontece aqui porque LIMITE_NAO_AQUECIDO
    // entra no lugar).
    while (cur.usadosNoDia >= cur.cotaDoDia) {
      cur.quando = aberturaDoDiaSeguinte(cur.quando, fusoOk);
      cur.dia = diaLocal(cur.quando, fusoOk);
      cur.usadosNoDia = 0;
      cur.cotaDoDia = cur.cotaDiaria;
    }

    cur.usadosNoDia += 1;
    resultado[k] = cur.quando;
  }
  return resultado;
}

/**
 * Estimativa de dias pra N contatos com estes números: hoje cabe a soma dos
 * restantes; cada dia seguinte, a soma das diárias.
 */
export function estimarDias(contatos: number, cotas: CotaDoNumero[]): number {
  if (contatos <= 0) return 0;
  const hoje = cotas.reduce((s, c) => s + Math.max(c.restantesHoje, 0), 0);
  const porDia = cotas.reduce((s, c) => s + (c.limiteDiario > 0 ? c.limiteDiario : LIMITE_NAO_AQUECIDO), 0);
  if (contatos <= hoje) return 1;
  if (porDia <= 0) return Number.POSITIVE_INFINITY;
  return 1 + Math.ceil((contatos - hoje) / porDia);
}

// ============================================
// Erros da Evolution
// ============================================

export type TipoDeErro = 'infra' | 'numero';

/**
 * INFRA: a Evolution/rede/instância falhou — não é culpa do número e não
 * conta falha; o envio volta pra fila em +5 min.
 * NUMERO: o destino não existe no WhatsApp / foi rejeitado — conta falha
 * seguida no número (5 pausam só ele).
 *
 * O evolution.service esconde o corpo da resposta (BUG-024) e só expõe
 * "Evolution API retornou status NNN" ou "Falha na comunicação com Evolution
 * API: ..."; por isso a classificação olha o status e as palavras conhecidas.
 */
export function classificarErroEvolution(err: unknown): TipoDeErro {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!msg) return 'infra';

  if (/not on whatsapp|exists["']?\s*:\s*false|invalid jid|blocked|\bban(ned)?\b|número inválido|numero invalido/.test(msg)) {
    return 'numero';
  }
  if (/falha na comunica|timeout|timed out|econnrefused|econnreset|enotfound|fetch failed|aborted|socket hang up|network/.test(msg)) {
    return 'infra';
  }
  if (/instância desconectada|instancia desconectada|not connected|desconectad|unauthorized|forbidden/.test(msg)) {
    return 'infra';
  }
  const status = /status\s+(\d{3})/.exec(msg);
  if (status) {
    const codigo = Number(status[1]);
    if (codigo >= 500 || codigo === 401 || codigo === 403 || codigo === 429) return 'infra';
    if (codigo >= 400) return 'numero';
  }
  return 'infra';
}
