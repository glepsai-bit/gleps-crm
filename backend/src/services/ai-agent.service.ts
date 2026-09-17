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
import { autoriaDaMemoria, valorDaMemoria } from './ai/memoria';

export { autoriaDaMemoria, valorDaMemoria };
import { prisma } from '../config/database';
import { NotFoundError, ValidationError, ConflictError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { chat, type ChatMessage, type ChatToolCall, type ChatToolDef, type ChatUsage } from './ai/chat';
import type { AiProviderName } from './ai/client-factory';
import {
  search,
  loadOverview,
  formatHitsForPrompt,
  formatBusinessContext,
  formatBaseIndex,
  type SearchHit,
  type MotivoSemTrechos,
  type BaseOverview,
} from './ai/knowledge-index';
import { validateAgainstSchema, extractJson } from './ai/json-schema-lite';
import {
  lerHttpTools,
  definicaoDaHttpTool,
  executarHttpTool,
  type HttpToolConfig,
} from './ai/http-tool';
import {
  lerCamposDeMemoria,
  validarCamposDeMemoria,
  definicaoDoLembrarDeclarado,
  formatFichaDeMemoria,
  escopoDaChave,
  chavesDeclaradas,
  ehChaveReservada,
  type CampoDeMemoria,
} from './ai/memoria-declarada';

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
/**
 * Quantas mensagens precisam ter caído da janela antes de gastar uma chamada
 * resumindo. Resumir a cada mensagem custaria uma chamada extra por
 * atendimento; esperar acumular dilui esse custo.
 */
const RESUMO_A_CADA = 10;
/** Chave reservada nos atributos da conversa. O prefixo `_` some do prompt. */
const CHAVE_RESUMO = '_resumo_conversa';

export interface UpsertAgentInput {
  name: string;
  description?: string | null;
  role?: AgentRole;
  systemPrompt: string;
  /** Ids de agentes que este pode consultar. */
  subAgentIds?: string[] | null;
  httpTools?: unknown;
  /** Campos de memória que este agente mantém. Vazio = campo livre. */
  memoryFields?: unknown;
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
   * LONGO PRAZO — fatos sobre a PESSOA, que valem entre conversas diferentes.
   * Vive no contato, não na conversa: o lead que sumiu e voltou em março
   * continua sendo o mesmo, com o mesmo faturamento e a mesma dor.
   */
  memory?: Record<string, unknown>;
  /**
   * CURTO PRAZO — estado DESTA conversa (onde paramos no roteiro, o que já foi
   * oferecido). Morre quando a conversa encerra, e é isso que se quer: o
   * roteiro recomeça, os fatos sobre a pessoa não.
   */
  session?: Record<string, unknown>;
  /** Resumo do que saiu da janela de histórico. Evita perder o início. */
  historySummary?: string | null;
  /**
   * Histórico já carregado por quem chamou.
   *
   * Existe para a delegação: o especialista rodava o caminho completo e relia
   * conversa, contagem e mensagens que o coordenador tinha acabado de ler —
   * três consultas jogadas fora por consulta. Além do custo, havia a janela em
   * que uma mensagem nova entrava entre as duas leituras e os dois agentes
   * enxergavam conversas diferentes.
   */
  preloadedHistory?: ChatMessage[] | null;
  /** Contato dono da memória de longo prazo — necessário pra ferramenta `lembrar`. */
  contactId?: string | null;
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

    if (input.httpTools !== undefined) {
      const lidas = lerHttpTools(input.httpTools);
      const bruto = Array.isArray(input.httpTools) ? input.httpTools : [];
      if (bruto.length !== lidas.length) {
        throw new ValidationError(
          'Toda ferramenta precisa de nome (minúsculas, sem espaço), endereço e "quando usar"'
        );
      }
      // Nome colidindo com ferramenta de sistema silenciaria a do agente ou a
      // do sistema, dependendo da ordem — e qual das duas rodou não apareceria
      // em lugar nenhum.
      const reservados = Object.keys(AVAILABLE_TOOLS).concat(FERRAMENTA_CONSULTA);
      const colisao = lidas.find((t) => reservados.includes(t.nome));
      if (colisao) {
        throw new ValidationError(`"${colisao.nome}" é nome de ferramenta do sistema`);
      }
      const nomes = lidas.map((t) => t.nome);
      if (new Set(nomes).size !== nomes.length) {
        throw new ValidationError('Há duas ferramentas com o mesmo nome');
      }
      data.httpTools = lidas as unknown as object;
    }

    // CAMPOS DE MEMÓRIA DECLARADOS.
    //
    // Validação estrita aqui (e tolerante na leitura do agente gravado): quem
    // está cadastrando precisa saber POR QUE a chave foi recusada. Um campo
    // que some sem explicação vira memória que o admin jura ter configurado.
    if (input.memoryFields !== undefined) {
      const { campos, erros } = validarCamposDeMemoria(input.memoryFields);
      if (erros.length > 0) throw new ValidationError(erros.join(' '));
      data.memoryFields = campos as unknown as object;
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
    // Zero trechos tem DOIS motivos, e o agente precisa dizer coisas diferentes:
    // "não achei nada sobre isso" ≠ "não consegui consultar agora". Tratar os
    // dois como silêncio é o que deixava a IA improvisar preço.
    let motivoSemTrechos: MotivoSemTrechos = 'nada_relevante';
    let overview: BaseOverview | null = null;
    if (agent.knowledgeBaseId) {
      try {
        // O mapa da base (contexto + índice) vem junto da busca: os dois saem
        // do mesmo cache, então isto não é uma ida a mais ao banco.
        [hits, overview] = await Promise.all([
          search(input.accountId, agent.knowledgeBaseId, userMessage),
          loadOverview(input.accountId, agent.knowledgeBaseId),
        ]);
      } catch (err) {
        motivoSemTrechos = 'busca_indisponivel';
        logger.warn('[ai-agent] busca na base de conhecimento falhou; seguindo sem RAG', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // O histórico vem ANTES do prompt: é ele que produz o resumo do trecho que
    // saiu da janela, e o resumo entra no prompt.
    const historico = await this.loadHistory(
      input.accountId,
      input.conversationId,
      agent.historyLimit,
      agent,
      input.preloadedHistory
    );

    // Os campos que o admin declarou pra ESTE agente. Lidos uma vez: valem no
    // prompt (a ficha, com os buracos) e na forma da ferramenta (o enum).
    const camposDeMemoria = lerCamposDeMemoria(agent.memoryFields);

    // Lido ANTES do prompt: é a lista de ferramentas que decide se a ficha pode
    // mandar registrar. Declarar campos e tirar `lembrar` são duas telas — o
    // prompt precisa saber qual das duas configurações venceu.
    const toolNames = Array.isArray(agent.tools) ? (agent.tools as string[]) : [];
    const temFerramentaLembrar = toolNames.includes('lembrar') && !!AVAILABLE_TOOLS.lembrar;

    const system = this.buildSystemPrompt({
      agent,
      hits,
      camposDeMemoria,
      temFerramentaLembrar,
      motivoSemTrechos,
      overview,
      variables: input.variables,
      memory: input.memory,
      // Só o que é de todos, mais o que é privado DESTE agente. O rascunho de
      // trabalho dos outros não entra — é ruído que custa token e confunde.
      session: escoparSessao(input.session, agent.id),
      // Resumo passado de fora (delegação) tem precedência; senão o que o
      // próprio agente calculou ao carregar o histórico.
      historySummary: input.historySummary ?? historico.summary,
    });

    const messages: ChatMessage[] = [
      ...historico.messages,
      { role: 'user', content: userMessage },
    ];

    const tools: ChatToolDef[] = toolNames
      .filter((n) => AVAILABLE_TOOLS[n])
      // `lembrar` deixa de ser definição estática quando o agente declara
      // campos: aí `campo` é enum e a descrição lista chave por chave. Sem
      // campos declarados vale a definição do catálogo, campo livre — que é o
      // que roda em produção hoje.
      .map((n) =>
        n === 'lembrar' && camposDeMemoria.length > 0
          ? definicaoDoLembrarDeclarado(camposDeMemoria)
          : AVAILABLE_TOOLS[n].definition
      );

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

    // FERRAMENTAS HTTP DO PRÓPRIO AGENTE.
    //
    // É o que fecha a distância pro n8n: em vez de 400 integrações, uma
    // ferramenta que o admin descreve. Entram junto das de sistema, e o modelo
    // escolhe entre todas pela descrição — por isso o campo "quando usar" é o
    // que decide se ela é chamada.
    const httpTools: HttpToolConfig[] = lerHttpTools(agent.httpTools);
    for (const t of httpTools) tools.push(definicaoDaHttpTool(t));

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
            {
              conversationId: input.conversationId,
              contactId: input.contactId,
              memory: input.memory,
              session: input.session,
              historySummary: input.historySummary ?? historico.summary,
              // O mesmo histórico que este agente está usando. São 3 consultas
              // a menos por consulta, e os dois passam a ler exatamente a
              // mesma conversa — sem a janela entre as duas leituras.
              history: historico.messages,
              depth: depth + 1,
            }
          );
          messages.push({ role: 'tool', content: saida, toolCallId: call.id });
          continue;
        }

        // Ferramenta do próprio agente vem antes da whitelist de sistema: o
        // admin nomeia as dele, e um nome que colida com `lembrar` seria
        // confuso — a validação no create/update impede isso.
        const propria = httpTools.find((t) => t.nome === call.name);
        if (propria) {
          const saida = await executarHttpTool(propria, call.arguments);
          messages.push({ role: 'tool', content: saida, toolCallId: call.id });
          continue;
        }

        const tool = AVAILABLE_TOOLS[call.name];
        let output: string;
        if (!tool) {
          output = `Ferramenta "${call.name}" não está disponível.`;
        } else {
          try {
            output = await tool.execute(call.arguments, {
              accountId: input.accountId,
              agent,
              contactId: input.contactId,
              // Campo de escopo `sessao` grava na CONVERSA — sem o id dela a
              // ferramenta não teria onde pôr.
              conversationId: input.conversationId,
              camposDeMemoria,
            });
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
    ctx: {
      conversationId?: string;
      contactId?: string | null;
      memory?: Record<string, unknown>;
      session?: Record<string, unknown>;
      historySummary?: string | null;
      /** O histórico que o coordenador já carregou. Evita a releitura. */
      history?: ChatMessage[];
      depth: number;
    }
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
        contactId: ctx.contactId,
        memory: ctx.memory,
        session: ctx.session,
        // O resumo já calculado é repassado pra que o especialista não gaste
        // outra chamada resumindo a mesma conversa.
        historySummary: ctx.historySummary,
        // E o histórico junto: sem isto ele relê do banco a mesma conversa que
        // o coordenador acabou de ler.
        preloadedHistory: ctx.history,
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

  /**
   * Objeto em vez de posicionais: com o índice e o contexto do negócio seriam
   * oito argumentos em sequência, e trocar dois de lugar por engano passaria
   * pelo compilador — todos são string ou objeto.
   */
  private buildSystemPrompt(p: {
    agent: AiAgent;
    hits: SearchHit[];
    /** Campos declarados deste agente. Vazio = prompt igual ao de antes. */
    camposDeMemoria?: CampoDeMemoria[];
    /**
     * `lembrar` está entre as ferramentas ENVIADAS ao provider nesta execução?
     * Campos declarados e ferramentas são telas diferentes: declarar campo e
     * não ter a ferramenta é um estado alcançável, e a ficha precisa saber.
     */
    temFerramentaLembrar?: boolean;
    /** Por que não vieram trechos. Só importa quando `hits` está vazio. */
    motivoSemTrechos?: MotivoSemTrechos;
    /** Mapa da base. Null quando o agente não tem base vinculada. */
    overview?: BaseOverview | null;
    variables?: Record<string, string>;
    memory?: Record<string, unknown>;
    session?: Record<string, unknown>;
    historySummary?: string | null;
  }): string {
    const { agent, hits, variables, memory, session, historySummary } = p;
    const campos = p.camposDeMemoria ?? [];
    // O que a ficha já mostra não se repete nos blocos genéricos: o mesmo fato
    // duas vezes no prompt custa token e sugere ao modelo que são dois fatos.
    //
    // POR ESCOPO, e não um Set plano pros dois blocos: a ficha lê cada campo no
    // escopo em que foi declarado, então só ali ela consegue mostrar o valor.
    // Omitir `nome` do bloco da memória longa porque `nome` foi declarado como
    // `sessao` apagava do prompt um "João" que estava gravado no contato — a
    // ficha marcava "(ainda não sei)" e o agente perguntava o nome de quem já
    // conhecia.
    const naFichaPelaMemoria = chavesDeclaradas(campos, 'memoria');
    const naFichaPelaSessao = chavesDeclaradas(campos, 'sessao');
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

    // A ordem é do mais específico pro mais genérico, porque é assim que o
    // modelo pondera: fato sobre ESTA pessoa vale mais que estado da conversa,
    // que vale mais que material do negócio.
    const longo = formatMemoryBlock(
      memory,
      'O QUE SABEMOS SOBRE ESTA PESSOA (vale entre conversas)',
      'Não pergunte de novo o que já está aqui.',
      naFichaPelaMemoria
    );
    if (longo) blocos.push(longo);

    const curto = formatMemoryBlock(
      session,
      'ONDE ESTAMOS NESTA CONVERSA',
      'Continue de onde parou; não recomece o roteiro.',
      naFichaPelaSessao
    );
    if (curto) blocos.push(curto);

    // A FICHA — os campos declarados, INCLUSIVE os vazios.
    //
    // É o vazio que importa: os blocos acima só mostram o que já se sabe, então
    // o agente nunca enxerga o buraco. Aqui ele vê a lista inteira e sabe o que
    // ainda falta apurar. Sem campos declarados o bloco não existe, e o prompt
    // fica idêntico ao de antes.
    const ficha = formatFichaDeMemoria(
      campos,
      { memoria: memory, sessao: session },
      valorDaMemoria,
      // Se `lembrar` não foi para o provider, a ficha não pode mandar usá-la.
      // Ela vira contexto do que já se sabe, sem a instrução de registrar.
      p.temFerramentaLembrar ?? false
    );
    if (ficha) blocos.push(ficha);

    if (historySummary && historySummary.trim()) {
      blocos.push(
        'RESUMO DO QUE JÁ FOI CONVERSADO ANTES DAS ÚLTIMAS MENSAGENS\n\n' +
          historySummary.trim()
      );
    }

    // MATERIAL DO NEGÓCIO, do mais estável ao mais volátil: quem somos →
    // o que sabemos → o que é relevante nesta mensagem. O índice precisa vir
    // ANTES dos trechos: é ele que diz ao agente que existe assunto além do
    // que a busca trouxe, e a instrução do bloco seguinte se refere a ele.
    if (p.overview) {
      const negocio = formatBusinessContext(p.overview);
      if (negocio) blocos.push(negocio);

      const indice = formatBaseIndex(p.overview);
      if (indice) blocos.push(indice);
    }

    // Sem base vinculada não há bloco nenhum — nem o aviso de vazio, que só faz
    // sentido quando existe base para consultar.
    if (agent.knowledgeBaseId) {
      blocos.push(formatHitsForPrompt(hits, p.motivoSemTrechos ?? 'nada_relevante'));
    }

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
    limit: number,
    agent: AiAgent,
    preloaded?: ChatMessage[] | null
  ): Promise<{ messages: ChatMessage[]; summary: string | null }> {
    if (!conversationId || limit <= 0) return { messages: [], summary: null };

    // Já veio pronto de quem chamou: nada a buscar. O resumo vem junto, pela
    // mesma via (`historySummary`), então não há o que recalcular aqui.
    if (preloaded) return { messages: preloaded, summary: null };

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true, customAttributes: true },
    });
    if (!conversation) throw new NotFoundError('Conversa');

    const filtro = {
      conversationId,
      deletedAt: null,
      isPrivate: false, // nota interna não vai pro modelo
      contentType: { not: 'system_note' },
      content: { not: null },
    };

    const total = await prisma.message.count({ where: filtro });

    const rows = await prisma.message.findMany({
      where: filtro,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { senderType: true, content: true },
    });

    const messages = rows
      .reverse()
      .filter((m) => (m.content ?? '').trim().length > 0)
      .map((m) => ({
        role: m.senderType === 'customer' ? ('user' as const) : ('assistant' as const),
        content: m.content as string,
      }));

    // Nada saiu da janela: o histórico completo já está nas mensagens.
    const forintam = Math.max(total - limit, 0);
    if (forintam === 0) return { messages, summary: null };

    const attrs = (conversation.customAttributes ?? {}) as Record<string, unknown>;
    const guardado = (attrs[CHAVE_RESUMO] ?? null) as
      | { texto?: string; cobertas?: number }
      | null;
    const cobertas = Number(guardado?.cobertas ?? 0);

    // O resumo ainda cobre o que saiu da janela — não gasta chamada.
    if (forintam - cobertas < RESUMO_A_CADA) {
      return { messages, summary: guardado?.texto ?? null };
    }

    const texto = await this.refreshSummary({
      accountId,
      conversationId,
      agent,
      filtro,
      de: cobertas,
      ate: forintam,
      anterior: guardado?.texto ?? null,
      attrs,
    });
    return { messages, summary: texto };
  }

  /**
   * Comprime o trecho que saiu da janela num resumo corrido e guarda nos
   * atributos da conversa.
   *
   * Sem isso, uma conversa longa perde o começo — justamente onde costuma estar
   * a qualificação. O resumo é acumulativo: o anterior entra como base pra que
   * nada se perca a cada compressão.
   */
  private async refreshSummary(p: {
    accountId: string;
    conversationId: string;
    agent: AiAgent;
    filtro: Record<string, unknown>;
    de: number;
    ate: number;
    anterior: string | null;
    attrs: Record<string, unknown>;
  }): Promise<string | null> {
    try {
      const antigas = await prisma.message.findMany({
        where: p.filtro,
        orderBy: { createdAt: 'asc' },
        skip: p.de,
        take: p.ate - p.de,
        select: { senderType: true, content: true },
      });
      if (antigas.length === 0) return p.anterior;

      const transcricao = antigas
        .map((m) => `${m.senderType === 'customer' ? 'Lead' : 'Nós'}: ${m.content}`)
        .join('\n');

      const r = await chat({
        accountId: p.accountId,
        provider: p.agent.provider as AiProviderName,
        // Modelo padrão do provider de propósito: resumir é tarefa barata e não
        // precisa do modelo caro que o agente usa pra atender.
        system:
          'Resuma a conversa preservando o que muda decisão: dados apurados do lead, ' +
          'objeções, combinados e pendências. Descarte cortesia e repetição. ' +
          'Português, terceira pessoa, no máximo 200 palavras.',
        messages: [
          {
            role: 'user',
            content: p.anterior
              ? `Resumo até aqui:\n${p.anterior}\n\nContinuação da conversa:\n${transcricao}\n\nDevolva o resumo atualizado, incorporando os dois.`
              : `Conversa:\n${transcricao}`,
          },
        ],
        maxTokens: 400,
      });

      const texto = r.text.trim();
      if (!texto) return p.anterior;

      await prisma.conversation.update({
        where: { id: p.conversationId },
        data: {
          customAttributes: {
            ...p.attrs,
            [CHAVE_RESUMO]: { texto, cobertas: p.ate },
          } as object,
        },
      });
      logger.info('[ai-agent] resumo do histórico atualizado', {
        conversationId: p.conversationId,
        mensagensCobertas: p.ate,
      });
      return texto;
    } catch (err) {
      // Resumir é melhoria de contexto, não requisito: se falhar, o agente
      // atende com a janela recente e o motivo fica no log.
      logger.warn('[ai-agent] não foi possível resumir o histórico', {
        conversationId: p.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return p.anterior;
    }
  }
}

/**
 * Transforma um conjunto de fatos num bloco legível pro modelo.
 *
 * Valor vazio é descartado: dizer "faturamento: (não informado)" gasta token e
 * confunde o agente, que passa a tratar a ausência como fato apurado.
 * Chaves internas (prefixo `_`) ficam de fora — são controle nosso, não fato
 * sobre o lead.
 */
/** Prefixo das chaves privadas de um agente na memória de conversa. */
const PREFIXO_PRIVADO = '_agente.';


/**
 * Separa o que é de todos do que é só deste agente.
 *
 * Chaves `_agente.<id>.*` são estado de trabalho privado: a triagem não precisa
 * saber que o agendamento está no passo "escolhendo horário". Com quatro
 * agentes, sem esta separação o prompt de cada um enche do rascunho dos outros.
 */
function escoparSessao(
  dados: Record<string, unknown> | undefined,
  agentId: string
): Record<string, unknown> {
  if (!dados) return {};
  const meuPrefixo = `${PREFIXO_PRIVADO}${agentId}.`;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dados)) {
    if (k.startsWith(meuPrefixo)) {
      saida[k.slice(meuPrefixo.length)] = v;
    } else if (!k.startsWith('_')) {
      saida[k] = v;
    }
  }
  return saida;
}

function formatMemoryBlock(
  dados: Record<string, unknown> | undefined,
  titulo: string,
  instrucao: string,
  /** Chaves que a ficha dos campos declarados já vai mostrar. */
  omitir?: Set<string>
): string {
  if (!dados) return '';
  const linhas = Object.entries(dados)
    .filter(([k]) => !k.startsWith('_'))
    .filter(([k]) => !omitir?.has(k))
    .map(([k, v]) => [k, valorDaMemoria(v)] as const)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (linhas.length === 0) return '';
  return `${titulo}\n${instrucao}\n\n${linhas.join('\n')}`;
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
  /** Dono da memória de longo prazo. Sem ele, `lembrar` não tem onde gravar. */
  contactId?: string | null;
  /** Dono da memória de curto prazo — destino dos campos de escopo `sessao`. */
  conversationId?: string | null;
  /** Campos declarados do agente. Vazio = campo livre, como antes. */
  camposDeMemoria?: CampoDeMemoria[];
}

interface AgentTool {
  definition: ChatToolDef;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export const AVAILABLE_TOOLS: Record<string, AgentTool> = {
  lembrar: {
    definition: {
      name: 'lembrar',
      description:
        'Guarda um fato sobre esta PESSOA para as próximas conversas — faturamento, ' +
        'segmento, quem decide, a dor principal, o que já foi combinado. Use quando o ' +
        'lead informar algo que você não vai querer perguntar de novo. Não use para ' +
        'coisa passageira do papo de agora.',
      parameters: {
        type: 'object',
        properties: {
          campo: {
            type: 'string',
            description: 'Nome curto e estável do fato. Ex: faturamento_mensal, decisor, segmento.',
          },
          valor: { type: 'string', description: 'O fato, em poucas palavras.' },
        },
        required: ['campo', 'valor'],
      },
    },
    async execute(args, ctx) {
      const campo = typeof args.campo === 'string' ? args.campo.trim() : '';
      const valor = typeof args.valor === 'string' ? args.valor.trim() : '';
      if (!campo || !valor) return 'Informe o campo e o valor a lembrar.';
      // `_` é reservado pra controle interno (resumo, marcadores); não pode ser
      // sobrescrito por um campo que o modelo inventou.
      if (campo.startsWith('_')) return 'Nome de campo inválido.';
      // E a reserva que não tem `_`: as bandeiras do atendimento na conversa
      // (`human_active` e companhia). A validação do cadastro já recusa, e a
      // leitura tolerante já descarta — esta é a guarda no ponto de ESCRITA,
      // que é onde o estrago aconteceria. Vale também no campo livre, onde o
      // nome vem do modelo.
      if (ehChaveReservada(campo)) {
        return `"${campo}" é um nome usado pelo atendimento — escolha outro campo.`;
      }

      const campos = ctx.camposDeMemoria ?? [];

      // COM CAMPOS DECLARADOS: só as chaves declaradas entram, e o escopo diz
      // onde gravar. O enum já barra no provider; esta checagem existe porque
      // nem todo modelo respeita enum, e memória com chave inventada é
      // exatamente o que os campos declarados vieram impedir.
      //
      // SEM CAMPOS DECLARADOS: nada muda — campo livre, gravando no contato.
      // É o caso de toda a produção de hoje.
      const escopo = campos.length > 0 ? escopoDaChave(campos, campo) : 'memoria';
      if (!escopo) {
        return (
          `"${campo}" não é um campo deste atendimento. ` +
          `Use um destes: ${campos.map((c) => c.chave).join(', ')}.`
        );
      }

      // A autoria acompanha o valor nos dois escopos: com vários agentes
      // escrevendo na mesma memória, um fato errado contamina todos, e sem
      // isto não há como descobrir de qual deles veio.
      const registro = { v: valor, por: ctx.agent.name, em: new Date().toISOString() };

      if (escopo === 'sessao') {
        if (!ctx.conversationId) {
          return 'Este campo vale só para a conversa, e não há conversa aqui — nada foi guardado.';
        }
        const conversa = await prisma.conversation.findFirst({
          where: { id: ctx.conversationId, accountId: ctx.accountId },
          select: { customAttributes: true },
        });
        if (!conversa) return 'Conversa não encontrada.';

        const attrsConversa = (conversa.customAttributes ?? {}) as Record<string, unknown>;
        // Chave CRUA, sem o prefixo `_agente.<id>.` de rascunho privado: campo
        // declarado é dado do atendimento, tem que ser legível por outro
        // agente e por relatório. O prefixo é pro que só interessa a um agente
        // — e `escoparSessao` já deixa passar a chave crua pra todo mundo.
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { customAttributes: { ...attrsConversa, [campo]: registro } as object },
        });
        return `Guardado nesta conversa: ${campo} = ${valor}`;
      }

      if (!ctx.contactId) return 'Esta conversa ainda não tem contato vinculado — nada foi guardado.';

      const contato = await prisma.contact.findFirst({
        where: { id: ctx.contactId, accountId: ctx.accountId },
        select: { customAttributes: true },
      });
      if (!contato) return 'Contato não encontrado.';

      const attrs = (contato.customAttributes ?? {}) as Record<string, unknown>;
      await prisma.contact.update({
        where: { id: ctx.contactId },
        data: { customAttributes: { ...attrs, [campo]: registro } as object },
      });
      return `Guardado: ${campo} = ${valor}`;
    },
  },

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
