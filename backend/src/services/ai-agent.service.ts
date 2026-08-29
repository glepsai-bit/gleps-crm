/**
 * T-027 Fase 1 — agentes de IA configuráveis pela conta.
 *
 * É o que substitui os dois nós `AI Agent` do fluxo n8n: o classificador (que
 * lê a conversa e devolve a etapa do kanban) e o respondente (o "Marcus"). Os
 * dois viram registros de `AiAgent` — prompt, modelo, base de conhecimento e
 * schema de saída deixam de ser um JSON exportado de outra ferramenta e passam
 * a ser dado da conta, editável na tela.
 */

import type { AiAgent } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ValidationError, ConflictError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { chat, type ChatMessage, type ChatToolCall, type ChatToolDef, type ChatUsage } from './ai/chat';
import type { AiProviderName } from './ai/client-factory';
import { search, formatHitsForPrompt, type SearchHit } from './ai/knowledge-index';
import { validateAgainstSchema, extractJson } from './ai/json-schema-lite';

export type AgentRole = 'classifier' | 'responder' | 'custom';

/** Teto de rodadas de ferramenta por execução — trava anti-loop. */
const MAX_TOOL_ROUNDS = 3;
/**
 * Profundidade máxima de consulta entre agentes. 1 = o coordenador consulta o
 * especialista, e o especialista responde sozinho. Sem esse teto, dois agentes
 * que se consultam mutuamente entrariam em laço queimando token até o limite
 * de gasto da conta.
 */
const MAX_AGENT_DEPTH = 1;
/** Nome fixo da ferramenta de delegação — o prompt do agente pode citá-la. */
const FERRAMENTA_CONSULTA = 'consultar_especialista';
const MAX_HISTORY = 60;

export interface UpsertAgentInput {
  name: string;
  description?: string | null;
  role?: AgentRole;
  systemPrompt: string;
  /** Ids de agentes que este pode consultar. */
  subAgentIds?: string[] | null;
  provider?: AiProviderName;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  historyLimit?: number;
  knowledgeBaseId?: string | null;
  tools?: string[];
  outputSchema?: Record<string, unknown> | null;
  active?: boolean;
}

export interface RunAgentInput {
  accountId: string;
  agentId: string;
  /** Mensagem do lead nesta rodada. */
  userMessage: string;
  /** Quando presente, o histórico da conversa entra no contexto. */
  conversationId?: string;
  /** Variáveis do fluxo interpoladas no prompt como {{chave}}. */
  variables?: Record<string, string>;
  /**
   * O que já se sabe sobre este lead, acumulado entre mensagens anteriores.
   * Sem isso cada agente recomeça do zero a cada mensagem — e nenhuma
   * arquitetura multi-agente se sustenta.
   */
  memory?: Record<string, unknown>;
  /** Profundidade da consulta entre agentes. 0 = chamada de origem. */
  depth?: number;
}

export interface RunAgentResult {
  text: string;
  /** Objeto validado contra outputSchema; null quando o agente não define schema. */
  structured: Record<string, unknown> | null;
  toolCalls: ChatToolCall[];
  hits: SearchHit[];
  usage: ChatUsage;
  model: string;
  provider: AiProviderName;
  /** 1 = acertou de primeira; 2 = precisou da rodada de autocorreção. */
  attempts: number;
}

class AiAgentService {
  // ============================================
  // CRUD
  // ============================================

  async list(accountId: string) {
    return prisma.aiAgent.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      include: { knowledgeBase: { select: { id: true, name: true } } },
    });
  }

  async get(accountId: string, id: string) {
    const agent = await prisma.aiAgent.findFirst({
      where: { id, accountId },
      include: { knowledgeBase: { select: { id: true, name: true } } },
    });
    if (!agent) throw new NotFoundError('Agente de IA');
    return agent;
  }

  async create(accountId: string, input: UpsertAgentInput) {
    const data = await this.validate(accountId, input, null);
    const name = data.name as string;

    const clash = await prisma.aiAgent.findFirst({ where: { accountId, name } });
    if (clash) throw new ConflictError(`Já existe um agente chamado "${name}"`);

    return prisma.aiAgent.create({
      data: { ...data, accountId, name, systemPrompt: data.systemPrompt as string },
    });
  }

  async update(accountId: string, id: string, input: Partial<UpsertAgentInput>) {
    const current = await this.get(accountId, id);
    const data = await this.validate(accountId, input, current);
    const name = data.name as string | undefined;

    if (name && name !== current.name) {
      const clash = await prisma.aiAgent.findFirst({
        where: { accountId, name, id: { not: id } },
      });
      if (clash) throw new ConflictError(`Já existe um agente chamado "${name}"`);
    }

    return prisma.aiAgent.update({ where: { id }, data });
  }

  async delete(accountId: string, id: string) {
    await this.get(accountId, id);
    await prisma.aiAgent.delete({ where: { id } });
  }

  /**
   * Valida e normaliza. Recebe o registro atual pra saber se um campo ausente
   * é "não mexer" (update) ou "faltando" (create).
   */
  private async validate(
    accountId: string,
    input: Partial<UpsertAgentInput>,
    current: AiAgent | null
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ValidationError('Nome do agente é obrigatório');
      data.name = name;
    } else if (!current) {
      throw new ValidationError('Nome do agente é obrigatório');
    }

    if (input.systemPrompt !== undefined) {
      const prompt = input.systemPrompt.trim();
      if (!prompt) throw new ValidationError('O prompt do agente é obrigatório');
      data.systemPrompt = prompt;
    } else if (!current) {
      throw new ValidationError('O prompt do agente é obrigatório');
    }

    if (input.description !== undefined) data.description = input.description?.trim() || null;

    if (input.role !== undefined) {
      if (!['classifier', 'responder', 'custom'].includes(input.role)) {
        throw new ValidationError('Papel do agente inválido');
      }
      data.role = input.role;
    }

    if (input.provider !== undefined) {
      if (!['openai', 'anthropic'].includes(input.provider)) {
        throw new ValidationError('Provider de IA inválido');
      }
      data.provider = input.provider;
    }

    if (input.model !== undefined) data.model = input.model?.trim() || null;

    if (input.temperature !== undefined) {
      if (input.temperature < 0 || input.temperature > 2) {
        throw new ValidationError('Temperatura deve estar entre 0 e 2');
      }
      data.temperature = input.temperature;
    }

    if (input.maxTokens !== undefined) {
      if (input.maxTokens < 64 || input.maxTokens > 32_000) {
        throw new ValidationError('maxTokens deve estar entre 64 e 32000');
      }
      data.maxTokens = input.maxTokens;
    }

    if (input.historyLimit !== undefined) {
      if (input.historyLimit < 0 || input.historyLimit > MAX_HISTORY) {
        throw new ValidationError(`historyLimit deve estar entre 0 e ${MAX_HISTORY}`);
      }
      data.historyLimit = input.historyLimit;
    }

    if (input.knowledgeBaseId !== undefined) {
      if (input.knowledgeBaseId) {
        const base = await prisma.knowledgeBase.findFirst({
          where: { id: input.knowledgeBaseId, accountId },
        });
        if (!base) throw new ValidationError('Base de conhecimento não encontrada nesta conta');
        data.knowledgeBaseId = base.id;
      } else {
        data.knowledgeBaseId = null;
      }
    }

    if (input.tools !== undefined) {
      const unknown = input.tools.filter((t) => !AVAILABLE_TOOLS[t]);
      if (unknown.length > 0) {
        throw new ValidationError(`Ferramenta desconhecida: ${unknown.join(', ')}`);
      }
      data.tools = input.tools;
    }

    if (input.subAgentIds !== undefined) {
      const ids = input.subAgentIds ?? [];
      if (ids.length > 0) {
        const encontrados = await prisma.aiAgent.findMany({
          where: { id: { in: ids }, accountId },
          select: { id: true },
        });
        if (encontrados.length !== ids.length) {
          throw new ValidationError('Algum agente especialista não existe nesta conta');
        }
        if (current && ids.includes(current.id)) {
          throw new ValidationError('Um agente não pode consultar a si mesmo');
        }
      }
      data.subAgentIds = ids;
    }

    if (input.outputSchema !== undefined) {
      if (input.outputSchema && typeof input.outputSchema !== 'object') {
        throw new ValidationError('outputSchema precisa ser um objeto JSON Schema');
      }
      data.outputSchema = input.outputSchema ?? null;
    }

    if (input.active !== undefined) data.active = input.active;

    return data;
  }

  // ============================================
  // Execução
  // ============================================

  async run(input: RunAgentInput): Promise<RunAgentResult> {
    const agent = await this.get(input.accountId, input.agentId);
    if (!agent.active) {
      throw new AppError(`O agente "${agent.name}" está desativado.`, 409);
    }

    const userMessage = input.userMessage?.trim();
    if (!userMessage) throw new ValidationError('Mensagem vazia');

    // RAG: busca com a mensagem do lead. Falha na busca não derruba o
    // atendimento — o agente responde sem a base e o motivo fica no log.
    let hits: SearchHit[] = [];
    if (agent.knowledgeBaseId) {
      try {
        hits = await search(input.accountId, agent.knowledgeBaseId, userMessage);
      } catch (err) {
        logger.warn('[ai-agent] busca na base de conhecimento falhou; seguindo sem RAG', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const system = this.buildSystemPrompt(agent, hits, input.variables, input.memory);
    const messages: ChatMessage[] = [
      ...(await this.loadHistory(input.accountId, input.conversationId, agent.historyLimit)),
      { role: 'user', content: userMessage },
    ];

    const toolNames = Array.isArray(agent.tools) ? (agent.tools as string[]) : [];
    const tools: ChatToolDef[] = toolNames
      .filter((n) => AVAILABLE_TOOLS[n])
      .map((n) => AVAILABLE_TOOLS[n].definition);

    // DELEGAÇÃO: o roster de especialistas vira uma ferramenta cujo enum são os
    // nomes deles. Construída aqui (e não no catálogo estático) porque depende
    // de QUAIS agentes este coordenador pode consultar.
    const depth = input.depth ?? 0;
    const subIds = Array.isArray(agent.subAgentIds) ? (agent.subAgentIds as string[]) : [];
    let especialistas: { id: string; name: string; description: string | null }[] = [];

    if (subIds.length > 0 && depth < MAX_AGENT_DEPTH) {
      especialistas = await prisma.aiAgent.findMany({
        where: { id: { in: subIds }, accountId: input.accountId, active: true },
        select: { id: true, name: true, description: true },
      });
      if (especialistas.length > 0) {
        tools.push({
          name: FERRAMENTA_CONSULTA,
          description:
            'Consulta um especialista quando a pergunta sai do seu escopo. Ele responde ' +
            'só a você — o lead não vê. Use a resposta para compor a SUA resposta.\n' +
            especialistas.map((e) => `- ${e.name}: ${e.description ?? 'sem descrição'}`).join('\n'),
          parameters: {
            type: 'object',
            properties: {
              especialista: { type: 'string', enum: especialistas.map((e) => e.name) },
              pergunta: {
                type: 'string',
                description: 'O que você precisa saber, com o contexto necessário.',
              },
            },
            required: ['especialista', 'pergunta'],
          },
        });
      }
    }

    const schema = agent.outputSchema as Record<string, unknown> | null;
    const usageTotal: ChatUsage = { inputTokens: 0, outputTokens: 0, usdEstimate: 0, priced: true };
    const allToolCalls: ChatToolCall[] = [];

    const callModel = async () => {
      const res = await chat({
        accountId: input.accountId,
        provider: agent.provider as AiProviderName,
        model: agent.model ?? undefined,
        system,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        jsonSchema: schema ? { name: 'resposta_do_agente', schema } : undefined,
        temperature: Number(agent.temperature),
        maxTokens: agent.maxTokens,
      });
      usageTotal.inputTokens += res.usage.inputTokens;
      usageTotal.outputTokens += res.usage.outputTokens;
      usageTotal.usdEstimate += res.usage.usdEstimate;
      if (!res.usage.priced) usageTotal.priced = false;
      return res;
    };

    let res = await callModel();

    // Rodadas de ferramenta, com teto: um agente que insiste em chamar a mesma
    // ferramenta trava a conversa em vez de responder.
    for (let round = 0; round < MAX_TOOL_ROUNDS && res.toolCalls.length > 0; round++) {
      allToolCalls.push(...res.toolCalls);
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        if (call.name === FERRAMENTA_CONSULTA) {
          const saida = await this.consultarEspecialista(
            input.accountId,
            especialistas,
            call.arguments,
            { conversationId: input.conversationId, memory: input.memory, depth: depth + 1 }
          );
          messages.push({ role: 'tool', content: saida, toolCallId: call.id });
          continue;
        }

        const tool = AVAILABLE_TOOLS[call.name];
        let output: string;
        if (!tool) {
          output = `Ferramenta "${call.name}" não está disponível.`;
        } else {
          try {
            output = await tool.execute(call.arguments, { accountId: input.accountId, agent });
          } catch (err) {
            output = `Erro ao executar: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }

      res = await callModel();
    }

    // Sem schema: o texto é a resposta.
    if (!schema) {
      return {
        text: res.text,
        structured: null,
        toolCalls: allToolCalls,
        hits,
        usage: usageTotal,
        model: res.model,
        provider: res.provider,
        attempts: 1,
      };
    }

    let parsed = extractJson(res.text);
    let check = validateAgainstSchema(parsed, schema);
    let attempts = 1;

    // Autocorreção — equivale ao `Auto-fixing Output Parser` do n8n. Uma rodada
    // só: se o modelo erra o formato duas vezes, o problema é o schema ou o
    // prompt, e insistir só queima token.
    if (!check.valid) {
      attempts = 2;
      logger.warn('[ai-agent] saída fora do schema; tentando autocorreção', {
        agentId: agent.id,
        errors: check.errors.slice(0, 5),
      });
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content:
          'Sua resposta anterior não seguiu o formato exigido:\n' +
          check.errors.map((e) => `- ${e}`).join('\n') +
          '\n\nResponda de novo APENAS com o JSON válido, sem texto ao redor.',
      });
      res = await callModel();
      parsed = extractJson(res.text);
      check = validateAgainstSchema(parsed, schema);
    }

    if (!check.valid) {
      throw new AppError(
        `O agente "${agent.name}" não devolveu a saída no formato esperado: ${check.errors.join('; ')}`,
        502
      );
    }

    return {
      text: res.text,
      structured: parsed as Record<string, unknown>,
      toolCalls: allToolCalls,
      hits,
      usage: usageTotal,
      model: res.model,
      provider: res.provider,
      attempts,
    };
  }

  /**
   * Roda um especialista a pedido do coordenador e devolve a resposta em texto.
   *
   * O especialista recebe a mesma memória e o mesmo histórico — ele precisa do
   * contexto pra responder direito. O que ele NÃO recebe é o direito de
   * delegar: `depth` já vem incrementado, e no próximo nível a ferramenta nem
   * é oferecida.
   */
  private async consultarEspecialista(
    accountId: string,
    disponiveis: { id: string; name: string }[],
    args: Record<string, unknown>,
    ctx: { conversationId?: string; memory?: Record<string, unknown>; depth: number }
  ): Promise<string> {
    const nome = typeof args.especialista === 'string' ? args.especialista : '';
    const pergunta = typeof args.pergunta === 'string' ? args.pergunta.trim() : '';

    const alvo = disponiveis.find((e) => e.name.toLowerCase() === nome.toLowerCase());
    if (!alvo) {
      return `Especialista "${nome}" não está disponível. Opções: ${disponiveis
        .map((e) => e.name)
        .join(', ')}.`;
    }
    if (!pergunta) return 'Informe a pergunta para o especialista.';

    try {
      const r = await this.run({
        accountId,
        agentId: alvo.id,
        userMessage: pergunta,
        conversationId: ctx.conversationId,
        memory: ctx.memory,
        depth: ctx.depth,
      });
      logger.info('[ai-agent] especialista consultado', {
        especialista: alvo.name,
        custoUsd: r.usage.usdEstimate,
      });
      // Saída estruturada vira JSON legível; texto puro vai como está.
      return r.structured ? JSON.stringify(r.structured) : r.text;
    } catch (err) {
      // Especialista que falha não derruba o coordenador — ele segue com o que
      // tem e o motivo fica no log do passo.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[ai-agent] consulta ao especialista falhou', { especialista: alvo.name, error: msg });
      return `Não foi possível consultar ${alvo.name}: ${msg}`;
    }
  }

  private buildSystemPrompt(
    agent: AiAgent,
    hits: SearchHit[],
    variables?: Record<string, string>,
    memory?: Record<string, unknown>
  ): string {
    let prompt = agent.systemPrompt;

    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        // Escapa a chave: nome de variável com regex dentro quebraria o replace.
        prompt = prompt.replace(
          new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'),
          value
        );
      }
    }

    const blocos = [prompt];

    // MEMÓRIA: o que ficou de mensagens anteriores. Vai antes da base de
    // conhecimento porque é o mais específico — fato apurado sobre ESTE lead
    // vale mais que material genérico do negócio.
    const memoriaTexto = formatMemoryForPrompt(memory);
    if (memoriaTexto) blocos.push(memoriaTexto);

    const knowledge = formatHitsForPrompt(hits);
    if (knowledge) blocos.push(knowledge);

    return blocos.join('\n\n---\n\n');
  }

  /**
   * Histórico vem das `Message` que já existem — o chat do CRM É a memória.
   * Guardar uma cópia (como o `Postgres Chat Memory` do n8n faz) criaria duas
   * versões da mesma conversa, que divergem no primeiro erro de sincronia.
   */
  private async loadHistory(
    accountId: string,
    conversationId: string | undefined,
    limit: number
  ): Promise<ChatMessage[]> {
    if (!conversationId || limit <= 0) return [];

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundError('Conversa');

    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        isPrivate: false, // nota interna não vai pro modelo
        contentType: { not: 'system_note' },
        content: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { senderType: true, content: true },
    });

    return rows
      .reverse()
      .filter((m) => (m.content ?? '').trim().length > 0)
      .map((m) => ({
        role: m.senderType === 'customer' ? ('user' as const) : ('assistant' as const),
        content: m.content as string,
      }));
  }
}

/**
 * Transforma a memória num bloco legível pro modelo. Valor vazio é descartado —
 * dizer "faturamento: (não informado)" gasta token e confunde o agente, que
 * passa a tratar a ausência como fato apurado.
 */
function formatMemoryForPrompt(memory?: Record<string, unknown>): string {
  if (!memory) return '';
  const linhas = Object.entries(memory)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (linhas.length === 0) return '';
  return (
    'O QUE JÁ SABEMOS SOBRE ESTE LEAD (apurado em conversas anteriores).\n' +
    'Não pergunte de novo o que já está aqui.\n\n' +
    linhas.join('\n')
  );
}

// ============================================
// Ferramentas disponíveis (whitelist)
// ============================================
// Fase 1 entrega só a busca na base — é a única que não depende do motor de
// fluxo. As ações de CRM (agendar, aplicar etapa, transferir) entram na Fase 2,
// junto com o executor de nós; a whitelist e o loop já estão prontos pra elas.

interface ToolContext {
  accountId: string;
  agent: AiAgent;
}

interface AgentTool {
  definition: ChatToolDef;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export const AVAILABLE_TOOLS: Record<string, AgentTool> = {
  buscar_conhecimento: {
    definition: {
      name: 'buscar_conhecimento',
      description:
        'Busca informações sobre o negócio na base de conhecimento. Use quando o lead ' +
        'perguntar algo específico sobre produto, preço, processo ou política que você não tenha certeza.',
      parameters: {
        type: 'object',
        properties: {
          pergunta: {
            type: 'string',
            description: 'A pergunta ou termo a buscar, em linguagem natural.',
          },
        },
        required: ['pergunta'],
      },
    },
    async execute(args, ctx) {
      const pergunta = typeof args.pergunta === 'string' ? args.pergunta : '';
      if (!pergunta.trim()) return 'Informe a pergunta a buscar.';
      if (!ctx.agent.knowledgeBaseId) return 'Este agente não tem base de conhecimento vinculada.';

      const hits = await search(ctx.accountId, ctx.agent.knowledgeBaseId, pergunta);
      if (hits.length === 0) return 'Nenhum trecho relevante encontrado na base.';
      return hits
        .map((h, i) => `[${i + 1}] (${h.docTitle || 'sem título'})\n${h.content}`)
        .join('\n\n---\n\n');
    },
  },
};

export const aiAgentService = new AiAgentService();
