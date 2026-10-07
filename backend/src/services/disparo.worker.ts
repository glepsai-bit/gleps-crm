/**
 * ETAPA D — worker da fila de disparos.
 *
 * A cada 15 s: pega um lote de envios vencidos (`nao_antes_de <= now`) de
 * disparos em 'enviando', com `FOR UPDATE SKIP LOCKED` — duas réplicas nunca
 * pegam a mesma linha — e manda um por um pela Evolution. O ritmo (20–60 s)
 * NÃO é feito aqui: já veio calculado em `nao_antes_de` na criação; o worker
 * só respeita a hora.
 *
 * Falhas:
 * - INFRA (Evolution fora, instância desconectada, 5xx, timeout): não é
 *   culpa do número. O envio volta pra fila em +5 min, e os outros envios
 *   daquele número nesta rodada também — não adianta insistir agora.
 * - NÚMERO (destino não existe no WhatsApp, 4xx): conta falha seguida
 *   daquele número no disparo. Na 5ª, os pendentes do número vão pros
 *   outros números do disparo; se não há outro, o disparo pausa.
 *
 * Ligação (LEAD liga em server.ts): `iniciarWorkerDeDisparos()` no boot.
 */
import { Prisma, type Disparo, type DisparoEnvio } from '@prisma/client';
import { prisma } from '../config/database';
import { aquecimentoService } from './aquecimento.service';
import { conversaSaidaService } from './conversa-saida.service';
import { disparoAnexoService, type AnexoDeDisparo } from './disparo-anexo.service';
import { disparoService } from './disparo.service';
import { classificarErroEvolution, FALHAS_SEGUIDAS_PARA_PAUSAR, renderizarMensagem, type VariaveisDoEnvio } from './disparo/regras';
import { evolutionService } from './evolution.service';
import { logger } from '../utils/logger';

export const INTERVALO_DO_WORKER_MS = 15_000;
const TAMANHO_DO_LOTE = 20;
const REAGENDAR_INFRA_MS = 5 * 60 * 1000;
const CACHE_DA_INBOX_MS = 60 * 1000;
const ANEXO_ESPERA_MIN_MS = 3000;
const ANEXO_ESPERA_MAX_MS = 8000;

export interface ResultadoDaRodada {
  /** true quando outra réplica estava com o cadeado. */
  bloqueada: boolean;
  claimados: number;
  enviados: number;
  falhas: number;
  reagendados: number;
  concluidos: number;
}

interface InboxInfo {
  nome: string;
  instance: string | null;
  conectada: boolean;
  em: number;
}

const cacheDeInbox = new Map<string, InboxInfo>();
let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Injetável nos testes: espera entre o texto e o anexo. */
let esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function __definirEspera(fn: (ms: number) => Promise<void>): void {
  esperar = fn;
}
export function __limparCacheDeInbox(): void {
  cacheDeInbox.clear();
}

// ============================================
// Ciclo de vida
// ============================================

export function iniciarWorkerDeDisparos(intervaloMs = INTERVALO_DO_WORKER_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (rodando) return;
    rodando = true;
    rodadaDeDisparos()
      .then((r) => {
        if (r.enviados > 0 || r.falhas > 0 || r.reagendados > 0) {
          logger.info(
            `📣 Disparos: ${r.enviados} enviados, ${r.falhas} falhas, ${r.reagendados} reagendados, ${r.concluidos} concluídos`
          );
        }
      })
      .catch((err) => logger.error('[disparo-worker] rodada falhou', err))
      .finally(() => {
        rodando = false;
      });
  }, intervaloMs);
  timer.unref?.();
  logger.info(`📣 Worker de disparos iniciado (intervalo: ${intervaloMs / 1000}s)`);
}

export function pararWorkerDeDisparos(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ============================================
// Rodada
// ============================================

/**
 * Uma rodada completa. Exportada pra ser chamada direto nos testes.
 */
export async function rodadaDeDisparos(): Promise<ResultadoDaRodada> {
  const resultado: ResultadoDaRodada = { bloqueada: false, claimados: 0, enviados: 0, falhas: 0, reagendados: 0, concluidos: 0 };

  const lote = await reivindicarLote();
  if (lote === null) {
    resultado.bloqueada = true;
    return resultado;
  }
  if (lote.envios.length === 0) return resultado;
  resultado.claimados = lote.envios.length;

  // Os disparos vêm do MESMO snapshot do claim (lidos dentro da transação):
  // o status 'enviando' que autorizou o claim é o que vale aqui. Ler de novo
  // fora da transação já devolveu 'agendado' velho em outra conexão do pool.
  const disparos = new Map<string, Disparo>(lote.disparos.map((d) => [d.id, d]));
  const infraForaNestaRodada = new Set<string>();
  const tocados = new Set<string>();

  for (const envio of lote.envios) {
    tocados.add(envio.disparoId);
    const d = disparos.get(envio.disparoId);
    if (!d) {
      // Disparo sumiu (apagado em cascata): nada a fazer com o envio.
      continue;
    }

    // Pausou/cancelou DURANTE a rodada (a rodada pode levar minutos com
    // anexos): devolve o envio pro estado certo. Só esses dois estados
    // importam — qualquer outro é o que o claim já viu.
    const statusAgora = await statusAtualDoDisparo(d.id);
    if (statusAgora === 'pausado' || statusAgora === 'cancelado' || d.status === 'pausado' || d.status === 'cancelado') {
      const cancelado = statusAgora === 'cancelado' || d.status === 'cancelado';
      await prisma.disparoEnvio.update({
        where: { id: envio.id },
        data: { status: cancelado ? 'cancelado' : 'pendente' },
      });
      d.status = statusAgora ?? d.status;
      continue;
    }

    if (infraForaNestaRodada.has(envio.inboxId)) {
      await reagendarPorInfra(envio, 'Número indisponível agora; nova tentativa em 5 min');
      resultado.reagendados += 1;
      continue;
    }

    const inbox = await infoDaInbox(envio.accountId, envio.inboxId);
    if (!inbox.conectada || !inbox.instance) {
      infraForaNestaRodada.add(envio.inboxId);
      await reagendarPorInfra(envio, `Número "${inbox.nome}" desconectado; nova tentativa em 5 min`);
      resultado.reagendados += 1;
      continue;
    }

    const texto = renderizarMensagem(d.texto, d.variantes, envio.variante, envio.variaveis as VariaveisDoEnvio | null);

    let messageId: string | null = null;
    try {
      const r = await evolutionService.sendText(envio.accountId, {
        number: envio.telefone,
        text: texto,
        instance: inbox.instance,
      });
      messageId = r.messageId || null;
    } catch (err) {
      const tipo = classificarErroEvolution(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (tipo === 'infra') {
        infraForaNestaRodada.add(envio.inboxId);
        await reagendarPorInfra(envio, `Evolution indisponível (${msg}); nova tentativa em 5 min`);
        resultado.reagendados += 1;
      } else {
        const atualizado = await registrarFalhaDeNumero(d, envio, msg, inbox.nome);
        if (atualizado) disparos.set(atualizado.id, atualizado);
        resultado.falhas += 1;
      }
      continue;
    }

    // Enviou. Conversa no Chat + status + contadores + aquecimento + anexo.
    const conversationId = await persistirNoChat(d, envio, texto, messageId);
    await prisma.$transaction([
      prisma.disparoEnvio.update({
        where: { id: envio.id },
        data: { status: 'enviada', enviadoEm: new Date(), evolutionMsgId: messageId, conversationId, erro: null },
      }),
      prisma.disparo.update({
        where: { id: d.id },
        data: { enviadas: { increment: 1 }, falhasSeguidas: zerarFalhas(d.falhasSeguidas, envio.inboxId) },
      }),
    ]);
    d.enviadas += 1;
    d.falhasSeguidas = zerarFalhas(d.falhasSeguidas, envio.inboxId);
    resultado.enviados += 1;

    try {
      await aquecimentoService.registrarEnvioExterno(envio.accountId, envio.inboxId, 1);
    } catch (err) {
      logger.warn('[disparo-worker] registrarEnvioExterno falhou (segue)', {
        inboxId: envio.inboxId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const anexo = d.anexo as unknown as AnexoDeDisparo | null;
    if (anexo?.path) {
      await esperar(ANEXO_ESPERA_MIN_MS + Math.floor(Math.random() * (ANEXO_ESPERA_MAX_MS - ANEXO_ESPERA_MIN_MS + 1)));
      await enviarAnexo(d, envio, inbox.instance, anexo, conversationId);
    }
  }

  resultado.concluidos = await concluirDisparos(Array.from(tocados));
  return resultado;
}

/**
 * Claim atômico. Tudo numa transação curta: cadeado (xact — solta sozinho),
 * recuperação de envios presos em 'enviando', promoção dos agendados que
 * venceram, o SELECT ... FOR UPDATE SKIP LOCKED e a leitura dos envios e
 * disparos envolvidos (mesmo snapshot). Devolve null se outra réplica está
 * com o cadeado.
 */
async function reivindicarLote(): Promise<{ envios: DisparoEnvio[]; disparos: Disparo[] } | null> {
  return prisma.$transaction(async (tx) => {
    const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext('disparos-worker')) AS ok
    `;
    if (!ok) return null;

    // Processo caiu no meio: o envio ficou em 'enviando' sem ninguém. Volta
    // pra fila depois de 10 min (um envio de verdade leva segundos).
    await tx.$executeRaw`
      UPDATE disparo_envios
         SET status = 'pendente', updated_at = now()
       WHERE status = 'enviando' AND updated_at < now() - interval '10 minutes'
    `;

    await tx.$executeRaw`
      UPDATE disparos
         SET status = 'enviando', iniciado_em = COALESCE(iniciado_em, now()), updated_at = now()
       WHERE status = 'agendado' AND agendado_para IS NOT NULL AND agendado_para <= now()
    `;

    const linhas = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE disparo_envios
         SET status = 'enviando', tentativas = tentativas + 1, updated_at = now()
       WHERE id IN (
         SELECT e.id
           FROM disparo_envios e
           JOIN disparos d ON d.id = e.disparo_id
          WHERE e.status = 'pendente'
            AND d.status = 'enviando'
            AND e.nao_antes_de <= now()
          ORDER BY e.nao_antes_de
          LIMIT ${TAMANHO_DO_LOTE}
          FOR UPDATE OF e SKIP LOCKED
       )
       RETURNING id
    `;
    const ids = linhas.map((l) => l.id);
    if (ids.length === 0) return { envios: [], disparos: [] };

    const envios = await tx.disparoEnvio.findMany({
      where: { id: { in: ids } },
      orderBy: [{ naoAntesDe: 'asc' }, { createdAt: 'asc' }],
    });
    const disparos = await tx.disparo.findMany({
      where: { id: { in: Array.from(new Set(envios.map((e) => e.disparoId))) } },
    });
    return { envios, disparos };
  });
}

async function statusAtualDoDisparo(id: string): Promise<string | null> {
  try {
    const d = await prisma.disparo.findUnique({ where: { id }, select: { status: true } });
    return d?.status ?? null;
  } catch {
    return null;
  }
}

// ============================================
// Passos
// ============================================

async function infoDaInbox(accountId: string, inboxId: string): Promise<InboxInfo> {
  const agora = Date.now();
  const emCache = cacheDeInbox.get(inboxId);
  if (emCache && agora - emCache.em < CACHE_DA_INBOX_MS) return emCache;

  const inbox = await prisma.inbox.findFirst({
    where: { id: inboxId, accountId },
    select: { name: true, evolutionInstance: true, active: true },
  });
  let info: InboxInfo = { nome: inbox?.name ?? 'Número', instance: inbox?.evolutionInstance ?? null, conectada: false, em: agora };
  if (inbox?.evolutionInstance && inbox.active) {
    // O `active` do banco é sincronizado pelo webhook connection.update, mas
    // a sessão pode ter caído sem aviso: confere ao vivo, com cache de 60 s.
    try {
      const st = await evolutionService.getStatus(accountId, inbox.evolutionInstance);
      info = { ...info, conectada: st.state === 'open' };
    } catch (err) {
      logger.warn('[disparo-worker] getStatus falhou; tratando número como desconectado', {
        inboxId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cacheDeInbox.set(inboxId, info);
  return info;
}

async function reagendarPorInfra(envio: DisparoEnvio, motivo: string): Promise<void> {
  await prisma.disparoEnvio.update({
    where: { id: envio.id },
    data: { status: 'pendente', naoAntesDe: new Date(Date.now() + REAGENDAR_INFRA_MS), erro: motivo },
  });
}

function lerFalhas(json: unknown): Record<string, number> {
  return json && typeof json === 'object' && !Array.isArray(json) ? { ...(json as Record<string, number>) } : {};
}

function zerarFalhas(json: unknown, inboxId: string): Record<string, number> {
  const f = lerFalhas(json);
  if (f[inboxId]) f[inboxId] = 0;
  return f;
}

/**
 * Falha de NÚMERO: envio 'falhou', contador do disparo e falhas seguidas
 * daquele número. Na 5ª seguida, redistribui ou pausa.
 */
async function registrarFalhaDeNumero(d: Disparo, envio: DisparoEnvio, erro: string, nomeDaInbox: string): Promise<Disparo | null> {
  const falhas = lerFalhas(d.falhasSeguidas);
  falhas[envio.inboxId] = (falhas[envio.inboxId] ?? 0) + 1;

  const [, atualizado] = await prisma.$transaction([
    prisma.disparoEnvio.update({ where: { id: envio.id }, data: { status: 'falhou', erro } }),
    prisma.disparo.update({ where: { id: d.id }, data: { falhas: { increment: 1 }, falhasSeguidas: falhas } }),
  ]);

  if (falhas[envio.inboxId] >= FALHAS_SEGUIDAS_PARA_PAUSAR) {
    return redistribuirOuPausar(atualizado, envio.inboxId, nomeDaInbox);
  }
  return atualizado;
}

async function redistribuirOuPausar(d: Disparo, inboxComFalha: string, nomeDaInbox: string): Promise<Disparo> {
  const falhas = lerFalhas(d.falhasSeguidas);
  const outras = d.inboxIds.filter((id) => id !== inboxComFalha && (falhas[id] ?? 0) < FALHAS_SEGUIDAS_PARA_PAUSAR);

  if (outras.length === 0) {
    const pausado = await prisma.disparo.update({
      where: { id: d.id },
      data: { status: 'pausado', pausadoMotivo: `5 falhas seguidas no número ${nomeDaInbox}` },
    });
    logger.warn('[disparo-worker] disparo pausado por falhas seguidas', { disparoId: d.id, inboxId: inboxComFalha });
    return pausado;
  }

  const movidos = await disparoService.reprogramarPendentes(d, new Date(), outras, inboxComFalha);
  logger.warn('[disparo-worker] número com 5 falhas seguidas; pendentes redistribuídos', {
    disparoId: d.id,
    inboxId: inboxComFalha,
    movidos,
    para: outras,
  });
  return d;
}

/**
 * Conversa + mensagem no Chat (reaproveita conversa-saida.service), ligada ao
 * disparo. "Fila humana" = marca `human_active` — a mesma flag que o live
 * attendance e o circuit breaker da IA já leem; nada novo.
 */
async function persistirNoChat(d: Disparo, envio: DisparoEnvio, texto: string, messageId: string | null): Promise<string | null> {
  try {
    const persistida = await conversaSaidaService.persistir({
      accountId: envio.accountId,
      contato: { nome: envio.nome, telefone: envio.telefone },
      inboxKey: envio.inboxId,
      content: texto,
      evolutionMsgId: messageId,
      status: 'sent',
      origem: 'disparo',
      metadata: { disparoId: d.id, disparoEnvioId: envio.id },
    });
    if (!persistida) return null;

    const atual = await prisma.conversation.findUnique({
      where: { id: persistida.conversationId },
      select: { customAttributes: true },
    });
    const attrs = (atual?.customAttributes as Record<string, unknown> | null) ?? {};
    const data: Prisma.ConversationUncheckedUpdateInput = { disparoId: d.id };
    if (d.atendeRespostas === 'humano') {
      data.customAttributes = {
        ...attrs,
        human_active: true,
        human_intervened: true,
        human_active_at: new Date().toISOString(),
        human_intervened_at: new Date().toISOString(),
      } as Prisma.InputJsonObject;
    }
    await prisma.conversation.update({ where: { id: persistida.conversationId }, data });
    return persistida.conversationId;
  } catch (err) {
    logger.warn('[disparo-worker] não deu pra persistir a conversa no Chat (envio já saiu)', {
      disparoId: d.id,
      envioId: envio.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function enviarAnexo(d: Disparo, envio: DisparoEnvio, instance: string, anexo: AnexoDeDisparo, conversationId: string | null): Promise<void> {
  try {
    const base64 = await disparoAnexoService.lerBase64(anexo.path);
    if (anexo.tipo === 'audio') {
      await evolutionService.sendWhatsAppAudio(envio.accountId, { number: envio.telefone, audioBase64: base64, instance });
    } else if (anexo.tipo === 'imagem') {
      await evolutionService.sendMedia(envio.accountId, {
        number: envio.telefone,
        mediaType: 'image',
        mediaUrl: `data:${anexo.mime || 'image/jpeg'};base64,${base64}`,
        instance,
      });
    } else {
      await evolutionService.sendMedia(envio.accountId, {
        number: envio.telefone,
        mediaType: 'document',
        mediaUrl: `data:${anexo.mime || 'application/pdf'};base64,${base64}`,
        mimeType: anexo.mime || 'application/pdf',
        fileName: anexo.nome,
        instance,
      });
    }
    if (conversationId) {
      await conversaSaidaService.persistir({
        accountId: envio.accountId,
        contato: { nome: envio.nome, telefone: envio.telefone },
        inboxKey: envio.inboxId,
        content: `📎 ${anexo.nome}`,
        origem: 'disparo',
        metadata: { disparoId: d.id, disparoEnvioId: envio.id, anexo },
      });
    }
  } catch (err) {
    // O texto já foi: o anexo falhar não derruba o envio. Fica registrado.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[disparo-worker] anexo não foi', { disparoId: d.id, envioId: envio.id, error: msg });
    await prisma.disparoEnvio.update({ where: { id: envio.id }, data: { erro: `Anexo não enviado: ${msg}` } }).catch(() => undefined);
  }
}

/** Disparo em 'enviando' sem pendentes nem em envio → 'concluido'. */
async function concluirDisparos(ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const abertos = await prisma.disparoEnvio.count({ where: { disparoId: id, status: { in: ['pendente', 'enviando'] } } });
    if (abertos > 0) continue;
    const r = await prisma.disparo.updateMany({
      where: { id, status: 'enviando' },
      data: { status: 'concluido', concluidoEm: new Date() },
    });
    n += r.count;
  }
  return n;
}
