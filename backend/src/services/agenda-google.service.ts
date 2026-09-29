/**
 * T-039 — cliente fino do Google Calendar API v3.
 *
 * O Google é a agenda: o evento vive lá, e o que for editado lá vence. Este
 * módulo só traduz "o que o CRM quer" em chamadas HTTP e "o que o Google
 * respondeu" em erros que o resto do sistema entende (reconectar, esperar,
 * desistir). Quem calcula horário, reserva e marca é o agenda.service — aqui
 * não tem regra de negócio.
 *
 * Sem SDK de propósito: são cinco chamadas, e o SDK oficial traz dezenas de
 * megabytes pra fazer isso. `fetch` nativo com timeout basta.
 *
 * Sempre `calendarId = 'primary'` — é o que o token guarda hoje.
 */
import { prisma } from '../config/database';
import { AppError } from '../utils/errors';
import { calendarService, escopoPermiteEscrita } from './calendar.service';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID = 'primary';
/** O Google responde em ~300ms; 15s é "já deu, considera fora do ar". */
const TIMEOUT_MS = 15_000;
/** Máximo que a API aceita por página. */
const PAGINA_MAX = '250';

export interface OcupacaoGoogle {
  googleEventId: string;
  inicio: Date;
  fim: Date;
  titulo: string | null;
}

export interface EstadoGoogle {
  conectado: boolean;
  email: string | null;
  podeEscrever: boolean;
  precisaReconectar: boolean;
  motivo: string | null;
}

/** O pedaço do recurso Event (v3) que a gente lê. */
interface EventoGoogleApi {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  /** `transparent` = "disponível" no Google: não ocupa horário. */
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

interface ListaEventosApi {
  items?: EventoGoogleApi[];
  nextPageToken?: string;
  /** Fuso do calendário — é o que vale pra evento de dia inteiro. */
  timeZone?: string;
}

/** Formato de erro da API do Google (os dois que ela usa). */
interface ErroGoogleApi {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    details?: Array<{ reason?: string }>;
  };
}

interface RespostaGoogle<T> {
  status: number;
  corpo: T | null;
}

type MetodoHttp = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Motivos de 403 que são "espera e tenta de novo", não "sem permissão". */
const MOTIVOS_403_TEMPORARIOS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

const erroSemPermissao = () =>
  new AppError(
    'O Google recusou o acesso à agenda — reconecte o Google Calendar pra dar permissão de escrita',
    409,
    'GOOGLE_SEM_PERMISSAO'
  );

const erroIndisponivel = () =>
  new AppError('Google Calendar indisponível agora', 503, 'GOOGLE_INDISPONIVEL');

// --- fuso horário -----------------------------------------------------------

const formatadores = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Formatador do fuso, cacheado. `null` quando o Google mandou um fuso que o
 * Node não conhece — aí a conta cai em UTC em vez de derrubar a listagem.
 */
function formatadorDoFuso(timeZone: string): Intl.DateTimeFormat | null {
  if (formatadores.has(timeZone)) return formatadores.get(timeZone)!;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    fmt = null;
  }
  formatadores.set(timeZone, fmt);
  return fmt;
}

/** Deslocamento (ms) do fuso em relação ao UTC naquele instante. */
function deslocamentoDoFuso(instanteMs: number, timeZone: string): number {
  const fmt = formatadorDoFuso(timeZone);
  if (!fmt) return 0;
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(new Date(instanteMs))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  const comoSeFosseUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return comoSeFosseUtc - instanteMs;
}

/**
 * Instante UTC da meia-noite de `dia` (YYYY-MM-DD) no fuso dado. É a conta
 * que transforma o `start.date` de um evento de dia inteiro em "ocupado das
 * 00:00 daquele lugar". A segunda passada corrige o dia em que o relógio
 * pula (horário de verão) — na primeira o deslocamento ainda é o de véspera.
 */
export function meiaNoiteNoFuso(dia: string, timeZone: string): Date {
  const [ano, mes, d] = dia.split('-').map(Number);
  const utc = Date.UTC(ano, mes - 1, d);
  const primeira = utc - deslocamentoDoFuso(utc, timeZone);
  const segunda = utc - deslocamentoDoFuso(primeira, timeZone);
  return new Date(segunda);
}

/**
 * [inicio, fim) do evento. Com hora: direto do `dateTime`. Dia inteiro: do
 * `date`, ocupando o dia todo no fuso do evento (ou do calendário, ou UTC).
 * O `end.date` do Google é exclusivo — "1 a 2" é o dia 1 inteiro, e a
 * meia-noite do dia 2 é exatamente as 24:00 do dia 1.
 */
function intervaloDoEvento(
  ev: EventoGoogleApi,
  fusoAgenda?: string
): { inicio: Date; fim: Date } | null {
  if (ev.start?.dateTime && ev.end?.dateTime) {
    const inicio = new Date(ev.start.dateTime);
    const fim = new Date(ev.end.dateTime);
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) return null;
    return { inicio, fim };
  }
  if (ev.start?.date && ev.end?.date) {
    const fuso = ev.start.timeZone || fusoAgenda || 'UTC';
    return { inicio: meiaNoiteNoFuso(ev.start.date, fuso), fim: meiaNoiteNoFuso(ev.end.date, fuso) };
  }
  return null;
}

// --- serviço ---------------------------------------------------------------

class AgendaGoogleService {
  /**
   * Situação da conexão, lendo só o banco — é chamado a cada cálculo de
   * horário e não pode custar uma ida ao Google.
   */
  async estado(userId: string): Promise<EstadoGoogle> {
    const token = await prisma.googleCalendarToken.findUnique({
      where: { userId },
      select: { connectedEmail: true, scope: true, reauthRequiredAt: true, reauthReason: true },
    });
    if (!token) {
      return { conectado: false, email: null, podeEscrever: false, precisaReconectar: false, motivo: null };
    }
    return {
      conectado: true,
      email: token.connectedEmail ?? null,
      podeEscrever: escopoPermiteEscrita(token.scope),
      precisaReconectar: Boolean(token.reauthRequiredAt),
      motivo: token.reauthReason ?? null,
    };
  }

  /**
   * Tudo que ocupa horário do profissional no Google entre `de` e `ate`.
   * Evento cancelado e evento "disponível" (transparent) ficam de fora —
   * o Google os devolve, mas não seguram agenda.
   */
  async listarOcupados(accountId: string, userId: string, de: Date, ate: Date): Promise<OcupacaoGoogle[]> {
    const ocupados: OcupacaoGoogle[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        timeMin: de.toISOString(),
        timeMax: ate.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: PAGINA_MAX,
      });
      if (pageToken) params.set('pageToken', pageToken);

      const { corpo } = await this.chamar<ListaEventosApi>(
        accountId,
        userId,
        'GET',
        `/calendars/${CALENDAR_ID}/events?${params.toString()}`
      );

      for (const ev of corpo?.items ?? []) {
        if (!ev.id) continue;
        if (ev.status === 'cancelled') continue;
        if (ev.transparency === 'transparent') continue;
        const intervalo = intervaloDoEvento(ev, corpo?.timeZone);
        if (!intervalo) continue;
        ocupados.push({
          googleEventId: ev.id,
          inicio: intervalo.inicio,
          fim: intervalo.fim,
          titulo: ev.summary ?? null,
        });
      }
      pageToken = corpo?.nextPageToken;
    } while (pageToken);

    return ocupados;
  }

  /**
   * Cria o evento no Google. `timeZone` vai junto porque o Google usa ele
   * pra exibir e pra recorrência — sem ele o evento aparece em UTC na
   * agenda da profissional.
   */
  async criarEvento(
    accountId: string,
    userId: string,
    ev: { titulo: string; descricao?: string; inicio: Date; fim: Date; timezone: string }
  ): Promise<{ googleEventId: string; htmlLink: string | null }> {
    const { status, corpo } = await this.chamar<EventoGoogleApi>(
      accountId,
      userId,
      'POST',
      `/calendars/${CALENDAR_ID}/events`,
      {
        summary: ev.titulo,
        description: ev.descricao,
        start: { dateTime: ev.inicio.toISOString(), timeZone: ev.timezone },
        end: { dateTime: ev.fim.toISOString(), timeZone: ev.timezone },
      }
    );
    if (!corpo?.id) {
      // 404 em POST no primary não acontece; se acontecer, é o Google mudou.
      throw new AppError(`Google Calendar não devolveu o evento criado (HTTP ${status})`, 502, 'GOOGLE_ERRO');
    }
    return { googleEventId: corpo.id, htmlLink: corpo.htmlLink ?? null };
  }

  /** Remarca: só start/end mudam, o resto do evento fica como está no Google. */
  async atualizarEvento(
    accountId: string,
    userId: string,
    googleEventId: string,
    ev: { inicio: Date; fim: Date; timezone: string }
  ): Promise<void> {
    const { status } = await this.chamar<EventoGoogleApi>(
      accountId,
      userId,
      'PATCH',
      `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(googleEventId)}`,
      {
        start: { dateTime: ev.inicio.toISOString(), timeZone: ev.timezone },
        end: { dateTime: ev.fim.toISOString(), timeZone: ev.timezone },
      }
    );
    if (status === 404 || status === 410) {
      // Apagaram na agenda do Google. Remarcar o que não existe não é
      // "engolir": quem chamou precisa criar de novo ou avisar o lead.
      throw new AppError('Evento não existe mais no Google Calendar', 404, 'GOOGLE_EVENTO_NAO_ENCONTRADO');
    }
  }

  /** Cancela. Já não existir (404/410) é o resultado desejado, não erro. */
  async cancelarEvento(accountId: string, userId: string, googleEventId: string): Promise<void> {
    await this.chamar<never>(
      accountId,
      userId,
      'DELETE',
      `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(googleEventId)}`
    );
  }

  /**
   * Como o evento está no Google agora — é assim que "editado lá, vence"
   * chega ao CRM. `null` quando sumiu de vez; `cancelled` quando foi
   * apagado mas o Google ainda guarda o rastro.
   */
  async obterEvento(
    accountId: string,
    userId: string,
    googleEventId: string
  ): Promise<{ inicio: Date; fim: Date; status: 'confirmed' | 'tentative' | 'cancelled' } | null> {
    const { status, corpo } = await this.chamar<EventoGoogleApi>(
      accountId,
      userId,
      'GET',
      `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(googleEventId)}`
    );
    if (status === 404 || status === 410 || !corpo) return null;

    const intervalo = intervaloDoEvento(corpo);
    // Sem horário não há o que comparar — pro CRM é como se não existisse.
    if (!intervalo) return null;

    const situacao =
      corpo.status === 'cancelled' ? 'cancelled' : corpo.status === 'tentative' ? 'tentative' : 'confirmed';
    return { inicio: intervalo.inicio, fim: intervalo.fim, status: situacao };
  }

  // --- HTTP ----------------------------------------------------------------

  /**
   * Uma chamada autenticada, com a tradução de erro num lugar só.
   *
   * 401 na primeira tentativa não é erro ainda: o banco dizia que o token
   * valia, o Google discorda (revogado no meio da hora). Renova à força e
   * tenta uma vez; se o 401 insistir, aí é permissão. 404/410 voltam pro
   * chamador decidir — pra cancelar é sucesso, pra remarcar é problema.
   */
  private async chamar<T>(
    accountId: string,
    userId: string,
    metodo: MetodoHttp,
    caminho: string,
    corpoEnvio?: unknown,
    tentativa = 0
  ): Promise<RespostaGoogle<T>> {
    const accessToken = await calendarService.accessTokenValido(accountId, userId, {
      forcarRenovacao: tentativa > 0,
    });
    const resposta = await this.http<T>(metodo, caminho, accessToken, corpoEnvio);

    if (resposta.status === 401 && tentativa === 0) {
      return this.chamar<T>(accountId, userId, metodo, caminho, corpoEnvio, 1);
    }

    const { status } = resposta;
    if (status >= 200 && status < 300) return resposta;
    if (status === 404 || status === 410) return { status, corpo: null };
    if (status === 401) throw erroSemPermissao();
    if (status === 429 || status >= 500) throw erroIndisponivel();

    const erro = (resposta.corpo as ErroGoogleApi | null)?.error;
    const motivo = erro?.errors?.[0]?.reason || erro?.details?.[0]?.reason || erro?.status || '';
    if (status === 403) {
      if (MOTIVOS_403_TEMPORARIOS.has(motivo)) throw erroIndisponivel();
      throw erroSemPermissao();
    }

    throw new AppError(
      `Google Calendar recusou a chamada (HTTP ${status}${erro?.message ? `: ${erro.message}` : ''})`,
      502,
      'GOOGLE_ERRO'
    );
  }

  /** fetch com timeout. Rede fora e timeout viram o mesmo 503 — pro chamador tanto faz. */
  private async http<T>(
    metodo: MetodoHttp,
    caminho: string,
    accessToken: string,
    corpoEnvio?: unknown
  ): Promise<RespostaGoogle<T>> {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);

    let resposta: Response;
    try {
      resposta = await fetch(`${BASE_URL}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(corpoEnvio !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: corpoEnvio !== undefined ? JSON.stringify(corpoEnvio) : undefined,
        signal: controle.signal,
      });
    } catch {
      throw erroIndisponivel();
    } finally {
      clearTimeout(timer);
    }

    // DELETE responde 204 sem corpo; erro às vezes vem em HTML. Nunca deixar
    // um JSON.parse derrubar a tradução do status.
    const texto = await resposta.text().catch(() => '');
    let corpo: T | null = null;
    if (texto) {
      try {
        corpo = JSON.parse(texto) as T;
      } catch {
        corpo = null;
      }
    }
    return { status: resposta.status, corpo };
  }
}

export const agendaGoogleService = new AgendaGoogleService();
