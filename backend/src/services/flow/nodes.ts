/**
 * T-028 Fase 2 — catálogo de nós do fluxo de atendimento.
 *
 * Catálogo FECHADO de propósito. O n8n é genérico porque precisa servir
 * qualquer automação; aqui o domínio é um só, e cada nó a mais é uma forma a
 * mais do cliente configurar errado o próprio atendimento às 2h da manhã.
 *
 * Cada nó chama o service que já existe no CRM — o motor não dá a volta por
 * HTTP como o n8n faz hoje. Isso elimina 17 chamadas de rede por atendimento e,
 * mais importante, faz as regras de negócio (opt-out, consent, rate-limit,
 * circuit breaker de humano) valerem sem depender de quem chamou.
 */

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { safeFetch } from '../../utils/ssrf-guard';
import { conversationService } from '../conversation.service';
import { whatsappSendService } from '../whatsapp-send.service';
import { agentAvailabilityService } from '../agent-availability.service';
import { attachmentStorageService } from '../attachment-storage.service';
import { aiAgentService } from '../ai-agent.service';
import { transcribe } from '../ai/transcription';
import {
  type FlowNode,
  type NodeContext,
  type NodeDefinition,
  type NodeResult,
  type BufferedMessage,
  interpolate,
  readPath,
  bufferedText,
} from './types';
import fs from 'fs/promises';

const cfg = (node: FlowNode): Record<string, unknown> => node.config ?? {};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);

// ============================================
// Gatilho
// ============================================

const triggerMessageReceived: NodeDefinition = {
  type: 'trigger.message_received',
  label: 'Mensagem recebida',
  description: 'Dispara quando o lead manda mensagem no WhatsApp.',
  branches: [{ key: 'default', label: '' }],
  mutates: false,
  async execute(_node, ctx) {
    const msgs = Array.isArray(ctx.vars.mensagens) ? (ctx.vars.mensagens as BufferedMessage[]) : [];
    return {
      output: {
        mensagensAgrupadas: msgs.length,
        texto: bufferedText(ctx.vars).slice(0, 500),
      },
    };
  },
};

// ============================================
// Guardas — o que impede a IA de atropelar
// ============================================

const guardConditions: NodeDefinition = {
  type: 'guard.conditions',
  label: 'Só continuar se',
  description:
    'Interrompe o fluxo quando um humano assumiu, a conversa já foi resolvida, ' +
    'está fora do horário ou a conversa tem uma etiqueta de bloqueio.',
  branches: [
    { key: 'default', label: 'Pode seguir' },
    { key: 'bloqueado', label: 'Bloqueado' },
  ],
  mutates: false,
  async execute(node, ctx) {
    const c = cfg(node);
    const conversation = await prisma.conversation.findFirst({
      where: { id: ctx.conversationId, accountId: ctx.accountId },
      select: {
        status: true,
        assigneeId: true,
        customAttributes: true,
        labels: { select: { tag: { select: { slug: true, name: true } } } },
      },
    });
    if (!conversation) {
      return { stop: true, stopReason: 'conversa_nao_encontrada' };
    }

    const motivos: string[] = [];

    // Humano assumiu: assignee humano OU marcação de atividade humana recente.
    // É a guarda mais importante — sem ela a IA responde por cima do atendente.
    if (bool(c.humanoAssumiu, true)) {
      const attrs = (conversation.customAttributes ?? {}) as Record<string, unknown>;
      const humanAt = attrs.human_active_at ?? attrs.humanActiveAt;
      const janelaMin = num(c.janelaHumanoMinutos, 30);
      if (conversation.assigneeId) motivos.push('humano_atribuido');
      else if (typeof humanAt === 'string') {
        const idadeMs = Date.now() - new Date(humanAt).getTime();
        if (Number.isFinite(idadeMs) && idadeMs < janelaMin * 60_000) {
          motivos.push('humano_ativo_recente');
        }
      }
    }

    if (bool(c.conversaResolvida, true) && conversation.status === 'resolved') {
      motivos.push('conversa_resolvida');
    }

    const bloqueadoras = Array.isArray(c.etiquetasBloqueio)
      ? (c.etiquetasBloqueio as string[]).map((t) => t.toLowerCase())
      : [];
    if (bloqueadoras.length > 0) {
      const tags = conversation.labels.map((l) => l.tag.slug.toLowerCase());
      const nomes = conversation.labels.map((l) => l.tag.name.toLowerCase());
      const achou = bloqueadoras.find((b) => tags.includes(b) || nomes.includes(b));
      if (achou) motivos.push(`etiqueta_bloqueio:${achou}`);
    }

    const horario = c.horarioComercial as
      | { inicio?: string; fim?: string; dias?: number[]; timezone?: string }
      | undefined;
    if (horario?.inicio && horario?.fim) {
      if (!dentroDoHorario(horario)) motivos.push('fora_do_horario');
    }

    if (motivos.length > 0) {
      return {
        branch: 'bloqueado',
        stop: !temSaida(node, 'bloqueado', ctx),
        stopReason: motivos.join(','),
        output: { bloqueado: true, motivos },
      };
    }
    return { output: { bloqueado: false } };
  },
};

/**
 * O nó só encerra o run se o grafo não tiver um caminho pro ramo 'bloqueado'.
 * Se o usuário desenhou uma saída pra esse caso (ex.: avisar que está fora do
 * horário), o fluxo segue por ela.
 */
function temSaida(node: FlowNode, branch: string, ctx: NodeContext): boolean {
  const edges = (ctx.vars.__edges as { source: string; branch?: string | null }[]) ?? [];
  return edges.some((e) => e.source === node.id && e.branch === branch);
}

function dentroDoHorario(h: {
  inicio?: string;
  fim?: string;
  dias?: number[];
  timezone?: string;
}): boolean {
  const tz = h.timezone || 'America/Sao_Paulo';
  const agora = new Date();
  // Intl é o jeito de obter hora local no fuso da conta sem trazer date-fns-tz.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(agora).map((p) => [p.type, p.value]));
  const minutos = Number(partes.hour) * 60 + Number(partes.minute);

  const mapaDia: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dia = mapaDia[String(partes.weekday)] ?? new Date().getDay();
  const dias = Array.isArray(h.dias) && h.dias.length > 0 ? h.dias : [1, 2, 3, 4, 5];
  if (!dias.includes(dia)) return false;

  const paraMin = (s: string) => {
    const [hh, mm] = s.split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
  };
  return minutos >= paraMin(h.inicio!) && minutos <= paraMin(h.fim!);
}

// ============================================
// Agrupamento e mídia
// ============================================

const bufferDebounce: NodeDefinition = {
  type: 'buffer.debounce',
  label: 'Agrupar mensagens',
  description:
    'Espera o lead terminar de digitar antes de responder. Mensagens que chegam ' +
    'durante a espera entram na mesma resposta.',
  branches: [{ key: 'default', label: '' }],
  mutates: false,
  async execute(node, ctx) {
    // A espera em si acontece ANTES do run começar: o gatilho lê `segundos`
    // daqui e agenda o run pra frente, e cada mensagem nova empurra o horário.
    // Quando o motor chega neste nó, o agrupamento já terminou — o nó existe
    // pra configurar a janela e pra registrar quantas mensagens juntou.
    const msgs = Array.isArray(ctx.vars.mensagens) ? (ctx.vars.mensagens as BufferedMessage[]) : [];
    return {
      output: {
        janelaSegundos: num(cfg(node).segundos, 15),
        mensagensAgrupadas: msgs.length,
      },
    };
  },
};

const mediaTranscribe: NodeDefinition = {
  type: 'media.transcribe',
  label: 'Transcrever áudio',
  description: 'Converte os áudios recebidos em texto e junta ao conteúdo da mensagem.',
  branches: [{ key: 'default', label: '' }],
  mutates: false,
  async execute(node, ctx) {
    const msgs = Array.isArray(ctx.vars.mensagens) ? (ctx.vars.mensagens as BufferedMessage[]) : [];
    const audios = msgs.filter((m) => m.contentType === 'audio');
    if (audios.length === 0) return { output: { audios: 0 } };

    const idioma = str(cfg(node).idioma, 'pt');
    const transcricoes: string[] = [];

    for (const msg of audios) {
      try {
        const att = await prisma.attachment.findFirst({
          where: { messageId: msg.id },
          select: { id: true },
        });
        if (!att) continue;

        const material = await attachmentStorageService.materialize(att.id);
        if (!material) continue;

        const buffer = await fs.readFile(material.absolutePath);
        const r = await transcribe(
          ctx.accountId,
          buffer,
          material.mimeType ?? 'audio/ogg',
          idioma
        );
        if (r.text) transcricoes.push(r.text);
      } catch (err) {
        // Áudio que não transcreve não pode derrubar o atendimento: a IA
        // responde com o que tem (texto das outras mensagens) e o motivo fica
        // no passo, visível na tela de execuções.
        logger.warn('[flow] falha ao transcrever áudio', {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (transcricoes.length === 0) return { output: { audios: audios.length, transcritos: 0 } };

    // As transcrições entram como mensagens do lead, na ordem — daí pra frente
    // o resto do fluxo trata áudio e texto igual.
    const novas: BufferedMessage[] = transcricoes.map((t, i) => ({
      id: `transcricao-${i}`,
      content: t,
      contentType: 'text',
      createdAt: new Date().toISOString(),
    }));

    return {
      vars: { mensagens: [...msgs.filter((m) => m.contentType !== 'audio'), ...novas] },
      output: { audios: audios.length, transcritos: transcricoes.length },
    };
  },
};

// ============================================
// Agente de IA
// ============================================

const aiAgentNode: NodeDefinition = {
  type: 'ai.agent',
  label: 'Agente de IA',
  description:
    'Roda um agente configurado (prompt + base de conhecimento) sobre a conversa. ' +
    'A saída fica disponível para os nós seguintes.',
  branches: [{ key: 'default', label: '' }],
  // Não muta o CRM: só produz texto. Por isso roda igual no modo sombra — é
  // exatamente o que se quer comparar com o n8n.
  mutates: false,
  async execute(node, ctx) {
    const c = cfg(node);
    const agentId = str(c.agentId);
    if (!agentId) return { stop: true, stopReason: 'agente_nao_configurado' };

    const texto = bufferedText(ctx.vars);
    if (!texto.trim()) return { stop: true, stopReason: 'mensagem_vazia' };

    const saidaEm = str(c.salvarEm, 'agente');

    const r = await aiAgentService.run({
      accountId: ctx.accountId,
      agentId,
      userMessage: texto,
      conversationId: ctx.conversationId,
      variables: Object.fromEntries(
        Object.entries(ctx.vars)
          .filter(([k, v]) => !k.startsWith('__') && typeof v === 'string')
          .map(([k, v]) => [k, v as string])
      ),
    });

    // A saída estruturada vira variável de primeira classe: os nós seguintes
    // leem {{agente.etapa}}, {{agente.mensagem_de_resposta}} etc.
    const valor = r.structured ?? { texto: r.text };

    return {
      vars: { [saidaEm]: valor, [`${saidaEm}_texto`]: r.text },
      output: {
        agente: agentId,
        modelo: r.model,
        tentativas: r.attempts,
        trechosUsados: r.hits.length,
        custoUsd: Number(r.usage.usdEstimate.toFixed(6)),
        tokens: r.usage.inputTokens + r.usage.outputTokens,
        resposta: r.text.slice(0, 1000),
        estruturado: r.structured,
      },
    };
  },
};

// ============================================
// Lógica
// ============================================

const logicSwitch: NodeDefinition = {
  type: 'logic.switch',
  label: 'Condição',
  description: 'Segue caminhos diferentes conforme o valor de uma variável.',
  branches: [{ key: 'default', label: 'Senão' }],
  mutates: false,
  async execute(node, ctx) {
    const c = cfg(node);
    const caminho = str(c.variavel);
    const bruto = readPath(ctx.vars, caminho);
    const valor = typeof bruto === 'string' ? bruto : JSON.stringify(bruto ?? null);

    const casos = Array.isArray(c.casos)
      ? (c.casos as { valor: string; branch: string }[])
      : [];
    const achou = casos.find(
      (caso) => String(caso.valor).toLowerCase() === String(valor).toLowerCase()
    );

    return {
      branch: achou?.branch,
      output: { variavel: caminho, valor, ramo: achou?.branch ?? 'default' },
    };
  },
};

// ============================================
// Ações no CRM
// ============================================

const crmApplyStage: NodeDefinition = {
  type: 'crm.apply_stage',
  label: 'Aplicar etapa',
  description: 'Aplica uma etiqueta/etapa do funil à conversa (aparece no kanban).',
  branches: [{ key: 'default', label: '' }],
  mutates: true,
  async execute(node, ctx) {
    const c = cfg(node);
    const etapa = interpolate(str(c.etapa), ctx.vars).trim();
    if (!etapa) return { output: { pulado: 'etapa_vazia' } };

    if (ctx.shadow) return { output: { simulado: true, etapa } };

    const tagId = await conversationService.resolveOrCreateTagByLabel(
      ctx.accountId,
      etapa,
      ctx.actorId
    );
    await conversationService.addLabel(ctx.conversationId, ctx.accountId, tagId, ctx.actorId);
    return { output: { etapa, tagId } };
  },
};

const crmUpdateContact: NodeDefinition = {
  type: 'crm.update_contact',
  label: 'Salvar informações',
  description: 'Grava variáveis capturadas pela IA nos campos da conversa.',
  branches: [{ key: 'default', label: '' }],
  mutates: true,
  async execute(node, ctx) {
    const c = cfg(node);
    const campos = (c.campos ?? {}) as Record<string, string>;
    const valores: Record<string, unknown> = {};
    for (const [chave, template] of Object.entries(campos)) {
      const v = interpolate(String(template), ctx.vars).trim();
      if (v) valores[chave] = v;
    }
    if (Object.keys(valores).length === 0) return { output: { pulado: 'nada_a_salvar' } };

    if (ctx.shadow) return { output: { simulado: true, valores } };

    await conversationService.setCustomAttributes(
      ctx.conversationId,
      ctx.accountId,
      valores,
      ctx.actorId
    );
    return { output: { valores } };
  },
};

const chatReply: NodeDefinition = {
  type: 'chat.reply',
  label: 'Responder no WhatsApp',
  description: 'Envia a resposta ao lead como mensagem da IA.',
  branches: [{ key: 'default', label: '' }],
  mutates: true,
  async execute(node, ctx) {
    const c = cfg(node);
    const texto = interpolate(str(c.texto, '{{agente.mensagem_de_resposta}}'), ctx.vars).trim();
    if (!texto) return { output: { pulado: 'resposta_vazia' } };

    if (ctx.shadow) return { output: { simulado: true, texto } };

    // REVALIDAÇÃO: a janela de agrupamento dura segundos e a conversa pode ter
    // mudado nesse meio-tempo — um atendente pode ter assumido depois que o
    // fluxo começou. Checar de novo aqui, imediatamente antes de enviar, é o
    // que impede a IA de falar por cima do humano.
    const atual = await prisma.conversation.findFirst({
      where: { id: ctx.conversationId, accountId: ctx.accountId },
      select: { assigneeId: true, status: true },
    });
    if (atual?.assigneeId) {
      return { stop: true, stopReason: 'humano_assumiu_durante_o_fluxo', output: { texto } };
    }

    const r = await whatsappSendService.send(ctx.accountId, {
      conversationId: ctx.conversationId,
      type: 'text',
      content: texto,
      sender_type: 'ai_bot',
      metadata: { flowId: ctx.flowId, runId: ctx.runId },
    });

    return {
      stop: r.status === 'failed',
      stopReason: r.status === 'failed' ? `envio_falhou:${r.error?.code ?? 'erro'}` : undefined,
      output: { texto, messageId: r.messageId, status: r.status, erro: r.error ?? null },
    };
  },
};

const chatAssignHuman: NodeDefinition = {
  type: 'chat.assign_human',
  label: 'Transferir para humano',
  description: 'Atribui a conversa a um atendente disponível e reabre para atendimento.',
  branches: [
    { key: 'default', label: 'Transferiu' },
    { key: 'sem_atendente', label: 'Ninguém disponível' },
  ],
  mutates: true,
  async execute(node, ctx) {
    const disponiveis = await agentAvailabilityService.listOnline(ctx.accountId);
    if (disponiveis.length === 0) {
      return {
        branch: 'sem_atendente',
        output: { transferido: false, motivo: 'nenhum_atendente_online' },
      };
    }

    // Sorteio simples, como o `Sortear_Agente1` do n8n. Distribuição por carga
    // fica pra quando houver dado de carga confiável — sorteio é previsível e
    // não cria fila fantasma.
    const escolhido = disponiveis[Math.floor(Math.random() * disponiveis.length)];

    if (ctx.shadow) {
      return { output: { simulado: true, atendente: escolhido.email } };
    }

    await conversationService.assign(
      ctx.conversationId,
      ctx.accountId,
      escolhido.id,
      ctx.actorId
    );
    await conversationService.updateStatus(ctx.conversationId, ctx.accountId, 'open', ctx.actorId);

    return { output: { atendente: escolhido.email, atendenteId: escolhido.id } };
  },
};

const chatResolve: NodeDefinition = {
  type: 'chat.resolve',
  label: 'Resolver conversa',
  description: 'Encerra a conversa marcando que foi resolvida pela IA.',
  branches: [{ key: 'default', label: '' }],
  mutates: true,
  async execute(node, ctx) {
    const c = cfg(node);
    const outcome = str(c.outcome, 'resolved') as 'resolved' | 'lost' | 'spam';

    if (ctx.shadow) return { output: { simulado: true, outcome } };

    await conversationService.resolve(ctx.conversationId, ctx.accountId, {
      resolvedBy: 'ai',
      userId: ctx.actorId,
      outcome,
      reason: str(c.motivo, 'Encerrada pelo fluxo de atendimento IA'),
      sendCsatToCustomer: bool(c.pedirCsat, false),
      resolvedByUserId: null,
    } as Parameters<typeof conversationService.resolve>[2]);

    return { stop: true, stopReason: 'conversa_resolvida', output: { outcome } };
  },
};

// ============================================
// Integração externa
// ============================================

const httpRequest: NodeDefinition = {
  type: 'http.request',
  label: 'Chamar API externa',
  description: 'Faz uma requisição HTTP (para manter integrações que vivem fora do CRM).',
  branches: [
    { key: 'default', label: 'Sucesso' },
    { key: 'erro', label: 'Erro' },
  ],
  mutates: true,
  async execute(node, ctx) {
    const c = cfg(node);
    const url = interpolate(str(c.url), ctx.vars).trim();
    if (!url) return { branch: 'erro', output: { erro: 'url_vazia' } };

    const metodo = str(c.metodo, 'POST').toUpperCase();
    const corpo = c.corpo ? interpolate(JSON.stringify(c.corpo), ctx.vars) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((c.headers as Record<string, string>) ?? {}),
    };

    if (ctx.shadow) return { output: { simulado: true, url, metodo } };

    try {
      // safeFetch: o mesmo guarda de SSRF que o webhook outbound usa. A URL vem
      // de campo livre da tela, então não pode alcançar rede interna.
      const res = await safeFetch(url, {
        method: metodo,
        headers,
        body: metodo === 'GET' ? undefined : corpo,
        signal: AbortSignal.timeout(num(c.timeoutMs, 10_000)),
      });
      const texto = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(texto);
      } catch {
        /* resposta não-JSON é normal */
      }

      const salvarEm = str(c.salvarEm);
      return {
        branch: res.ok ? undefined : 'erro',
        vars: salvarEm && json ? { [salvarEm]: json } : undefined,
        output: { url, metodo, status: res.status, resposta: texto.slice(0, 2000) },
      };
    } catch (err) {
      return {
        branch: 'erro',
        output: { url, erro: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

const flowWait: NodeDefinition = {
  type: 'flow.wait',
  label: 'Esperar',
  description: 'Pausa antes do próximo passo.',
  branches: [{ key: 'default', label: '' }],
  mutates: false,
  async execute(node) {
    const segundos = Math.min(num(cfg(node).segundos, 5), 60);
    await new Promise((r) => setTimeout(r, segundos * 1000));
    return { output: { segundos } };
  },
};

// ============================================
// Registro
// ============================================

export const NODE_CATALOG: Record<string, NodeDefinition> = Object.fromEntries(
  [
    triggerMessageReceived,
    guardConditions,
    bufferDebounce,
    mediaTranscribe,
    aiAgentNode,
    logicSwitch,
    crmApplyStage,
    crmUpdateContact,
    chatReply,
    chatAssignHuman,
    chatResolve,
    httpRequest,
    flowWait,
  ].map((d) => [d.type, d])
);

/** Catálogo para a tela montar a paleta de nós. */
export function listNodeTypes() {
  return Object.values(NODE_CATALOG).map((d) => ({
    type: d.type,
    label: d.label,
    description: d.description,
    branches: d.branches,
    mutates: d.mutates,
  }));
}

export type { NodeResult };
