/**
 * PROVISIONAMENTO DE AGENTE — do spec ao agente pronto em sombra.
 *
 * O super admin (ou o kit do operador, pela API) manda um `spec` e este
 * serviço monta, NA CONTA, tudo que o atendimento precisa: base de
 * conhecimento com documentos, serviços, agenda (regras + profissionais),
 * etapas do funil, o agente com prompt por seções e o fluxo "Atendimento —
 * <agente>" em sombra. Depois simula em lote, publica e reverte.
 *
 * Reusa os services que a tela já usa (knowledge, product, agenda, tag,
 * ai-agent, flow): a mesma validação, os mesmos eventos. O que há de novo é a
 * costura e o versionamento.
 *
 * IDEMPOTENTE POR AGENTE, NÃO ATÔMICO. Cada passo acha o que já existe pelo
 * nome (base, documento, serviço, etapa, fluxo) e atualiza em vez de duplicar;
 * um provisionamento que falhou no meio se conserta repetindo o POST. Uma
 * transação de verdade exigiria reescrever cada service com `tx` — o custo
 * não paga: nada aqui é dinheiro nem mensagem enviada.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { AppError, ErrorCodes, NotFoundError, ValidationError } from '../utils/errors';
import { aiAgentService } from './ai-agent.service';
import type { ChatMessage } from './ai/chat';
import type { AiProviderName } from './ai/client-factory';
import { hasProvider } from './ai/client-factory';
import { knowledgeService } from './knowledge.service';
import { productService } from './product.service';
import { agendaService } from './agenda.service';
import { tagService, criarEtapasFixas } from './tag.service';
import { flowService } from './flow.service';
import { eventService } from './event.service';
import { validateGraph } from './flow/engine';
import type { FlowStatus } from './flow/types';
import type { HorariosSemanais } from './agenda/horarios';
import { validarSpec, etapasDoSpec, type SpecV1 } from './provisionar/spec';
import { montarPrompt, schemaDeSaida, moeda, PromptLongoDemaisError } from './provisionar/prompt';
import { montarGrafo, nomeDoFluxo, type EtapasDoFluxo } from './provisionar/template-fluxo';

/** Marca dos documentos que o provisionamento mantém — os outros são do admin. */
const ORIGEM_DOC = 'provisionamento';
const TITULO_SOBRE = 'Sobre o negócio';
const TITULO_FAQ = 'Perguntas frequentes';
/** Teto do contexto do negócio na base — é o que `formatBusinessContext` realmente usa. */
const MAX_CONTEXTO_BASE = 4000;

export const MAX_CONVERSAS_SIMULADAS = 30;
export const MAX_TURNOS_SIMULADOS = 12;
const TIMEOUT_POR_TURNO_MS = 60_000;
const CONVERSAS_EM_PARALELO = 4;
/** Mensagens de histórico que a simulação repassa ao agente por turno. */
const MAX_HISTORICO_SIMULADO = 40;

export type MotivoDoProvisionamento = 'provisionado' | 'atualizado' | 'revertido';

export interface RespostaDoProvisionamento {
  agentId: string;
  flowId: string;
  knowledgeBaseId: string;
  productIds: string[];
  etapas: Record<string, string>;
  profissionais: Record<string, string | null>;
  versao: number;
  avisos: string[];
}

export interface ConversaSimulada {
  nome: string;
  mensagens: string[];
}

export interface TurnoSimulado {
  lead: string;
  resposta: string | null;
  rota: string | null;
  resumo: string | null;
  toolCalls: string[];
  efeitos: Record<string, unknown>;
  custoUsd: number;
  tokens: number;
  erro?: string;
}

export interface RelatorioDaSimulacao {
  resumo: { conversas: number; transferidas: number; agendadas: number; comErro: number; custoUsd: number; tokens: number };
  conversas: {
    nome: string;
    turnos: TurnoSimulado[];
    transferiu: boolean;
    agendou: boolean;
    erro: string | null;
  }[];
}

class ProvisionarService {
  // ============================================
  // Provisionar (criar ou atualizar)
  // ============================================

  async provisionar(p: {
    accountId: string;
    spec: SpecV1;
    /** Força atualizar ESTE agente (PUT/reverter). Sem ele, casa pelo nome. */
    agentId?: string | null;
    atorId: string | null;
    motivo?: MotivoDoProvisionamento;
  }): Promise<{ resposta: RespostaDoProvisionamento; criado: boolean }> {
    const { accountId, spec } = p;
    const avisos: string[] = [];

    const conta = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, timezone: true },
    });
    if (!conta) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 404, 'NOT_FOUND');

    // ---- Chave de IA: sem ela não há agente que rode ----
    const provider = await this.resolverProvider(accountId, spec.agente.provider ?? null);

    // ---- Prompt (puro; falha aqui é do briefing, 400) ----
    let prompt: string;
    try {
      prompt = montarPrompt(spec);
    } catch (err) {
      if (err instanceof PromptLongoDemaisError) throw new ValidationError(err.message);
      throw err;
    }

    // ---- Agente existente? (por id ou por nome na conta) ----
    const existente = await this.acharAgente(accountId, p.agentId ?? null, spec.agente.nome);
    const criado = !existente;

    // ---- 1. Base de conhecimento ----
    const baseId = await this.sincronizarBase(accountId, spec, existente?.knowledgeBaseId ?? null, avisos);

    // ---- 2. Serviços ----
    const productIds = await this.sincronizarServicos(accountId, spec, p.atorId);

    // ---- 3. Etapas ----
    const { etapas, mapa } = await this.sincronizarEtapas(accountId, spec, p.atorId);

    // ---- 4. Agenda ----
    const { agendaDoAgente, profissionais } = await this.sincronizarAgenda(
      accountId,
      conta.timezone,
      spec,
      etapas,
      productIds,
      avisos
    );

    // ---- 5. Agente ----
    const dadosDoAgente = {
      name: spec.agente.nome.trim(),
      description: `Provisionado a partir do briefing — ${spec.negocio.nome.trim()} (${spec.negocio.segmento})`,
      role: 'responder' as const,
      systemPrompt: prompt,
      provider,
      model: spec.agente.model?.trim() || null,
      temperature: spec.agente.temperatura ?? 0.5,
      knowledgeBaseId: baseId,
      tools: ['lembrar', 'buscar_conhecimento'],
      outputSchema: schemaDeSaida(),
      memoryFields: spec.triagem.camposMemoria.map((c) => ({
        chave: c.chave,
        descricao: c.descricao,
        escopo: 'memoria' as const,
      })),
      agenda: agendaDoAgente,
      active: true,
    };
    const agente = existente
      ? await aiAgentService.update(accountId, existente.id, dadosDoAgente)
      : await aiAgentService.create(accountId, dadosDoAgente);

    // ---- 6. Fluxo ----
    const flowId = await this.sincronizarFluxo(accountId, agente.id, existente?.id ?? null, spec, etapas, avisos);

    // ---- 7. Versão ----
    const versao = (existente?.specVersao ?? 0) + 1;
    await prisma.agentSpecVersion.create({
      data: {
        agentId: agente.id,
        accountId,
        versao,
        spec: spec as unknown as Prisma.InputJsonValue,
        flowId,
        criadoPor: p.atorId,
      },
    });
    await prisma.aiAgent.update({
      where: { id: agente.id },
      data: { spec: spec as unknown as Prisma.InputJsonValue, specVersao: versao },
    });

    // ---- 8. Auditoria ----
    const motivo: MotivoDoProvisionamento = p.motivo ?? (criado ? 'provisionado' : 'atualizado');
    await eventService.create({
      eventType: `agente.${motivo}`,
      accountId,
      actorType: 'user',
      actorId: p.atorId ?? undefined,
      entityType: 'ai_agent',
      entityId: agente.id,
      payload: { versao, flowId, knowledgeBaseId: baseId, avisos },
    });

    logger.info('[provisionar] agente provisionado', { accountId, agentId: agente.id, versao, criado, motivo });

    return {
      criado,
      resposta: {
        agentId: agente.id,
        flowId,
        knowledgeBaseId: baseId,
        productIds,
        etapas: mapa,
        profissionais,
        versao,
        avisos,
      },
    };
  }

  // ============================================
  // Consulta, reverter, publicar
  // ============================================

  async obter(agentId: string) {
    const agente = await prisma.aiAgent.findUnique({
      where: { id: agentId },
      include: { specVersions: { orderBy: { versao: 'desc' } } },
    });
    if (!agente || agente.specVersao === 0) throw new NotFoundError('Agente provisionado');

    const flow = await this.fluxoDoAgente(agente.accountId, agente.id);
    return {
      agentId: agente.id,
      accountId: agente.accountId,
      nome: agente.name,
      versao: agente.specVersao,
      spec: agente.spec,
      flow: flow ? { id: flow.id, status: flow.status as FlowStatus, inboxIds: flow.inboxIds } : null,
      versoes: agente.specVersions.map((v) => ({
        versao: v.versao,
        createdAt: v.createdAt,
        criadoPor: v.criadoPor,
      })),
    };
  }

  async reverter(agentId: string, versao: number, atorId: string | null) {
    const agente = await this.exigirProvisionado(agentId);
    const alvo = await prisma.agentSpecVersion.findUnique({
      where: { agentId_versao: { agentId, versao } },
    });
    if (!alvo) throw new NotFoundError(`Versão ${versao} do agente`);

    // Revalida: o spec gravado pode ser de antes de uma regra nova.
    const spec = validarSpec(alvo.spec);
    return this.provisionar({ accountId: agente.accountId, spec, agentId, atorId, motivo: 'revertido' });
  }

  async publicar(agentId: string, status: FlowStatus) {
    const agente = await this.exigirProvisionado(agentId);
    const flow = await this.fluxoDoAgente(agente.accountId, agente.id);
    if (!flow) throw new NotFoundError('Fluxo do agente');

    if (status === 'active') {
      const provider = agente.provider as AiProviderName;
      if (!(await hasProvider(agente.accountId, provider))) {
        throw new AppError(this.mensagemSemChave(provider), 409, 'IA_SEM_CHAVE');
      }
    }
    const atualizado = await flowService.setStatus(agente.accountId, flow.id, status);
    await eventService.create({
      eventType: 'agente.publicado',
      accountId: agente.accountId,
      actorType: 'user',
      entityType: 'ai_agent',
      entityId: agente.id,
      payload: { flowId: flow.id, status },
    });
    return { agentId: agente.id, flowId: atualizado.id, status: atualizado.status as FlowStatus };
  }

  // ============================================
  // Simulação em lote (sombra: nada grava)
  // ============================================

  async simular(agentId: string, conversas: ConversaSimulada[], maxTurnos = MAX_TURNOS_SIMULADOS): Promise<RelatorioDaSimulacao> {
    const agente = await this.exigirProvisionado(agentId);
    // Sem chave, as 30 conversas voltariam cada uma com erro: falha cedo e clara.
    const provider = agente.provider as AiProviderName;
    if (!(await hasProvider(agente.accountId, provider))) {
      throw new AppError(this.mensagemSemChave(provider), 409, 'IA_SEM_CHAVE');
    }
    const teto = Math.max(1, Math.min(maxTurnos, MAX_TURNOS_SIMULADOS));
    const lote = conversas.slice(0, MAX_CONVERSAS_SIMULADAS);

    const resultados: RelatorioDaSimulacao['conversas'] = new Array(lote.length);
    let proxima = 0;
    const trabalhador = async () => {
      while (proxima < lote.length) {
        const i = proxima++;
        resultados[i] = await this.simularConversa(agente.accountId, agente.id, lote[i], teto);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONVERSAS_EM_PARALELO, lote.length) }, trabalhador));

    const resumo = { conversas: lote.length, transferidas: 0, agendadas: 0, comErro: 0, custoUsd: 0, tokens: 0 };
    for (const c of resultados) {
      if (c.transferiu) resumo.transferidas++;
      if (c.agendou) resumo.agendadas++;
      if (c.erro) resumo.comErro++;
      for (const t of c.turnos) {
        resumo.custoUsd += t.custoUsd;
        resumo.tokens += t.tokens;
      }
    }
    resumo.custoUsd = Number(resumo.custoUsd.toFixed(6));
    return { resumo, conversas: resultados };
  }

  private async simularConversa(
    accountId: string,
    agentId: string,
    conversa: ConversaSimulada,
    maxTurnos: number
  ): Promise<RelatorioDaSimulacao['conversas'][number]> {
    const historia: ChatMessage[] = [];
    const turnos: TurnoSimulado[] = [];
    let transferiu = false;
    let agendou = false;
    let erro: string | null = null;

    for (const lead of conversa.mensagens.slice(0, maxTurnos)) {
      try {
        const r = await comTimeout(
          aiAgentService.run({
            accountId,
            agentId,
            userMessage: lead,
            preloadedHistory: historia.slice(-MAX_HISTORICO_SIMULADO),
            // Sombra: ferramentas de agenda consultam mas não reservam; `lembrar`
            // sem contato não grava. Nada toca Conversation/Message/CalendarEvent.
            shadow: true,
            contactId: null,
            contato: { nome: conversa.nome, conversasAnteriores: 0 },
            memory: {},
            session: {},
          }),
          TIMEOUT_POR_TURNO_MS
        );
        const saida = (r.structured ?? {}) as Record<string, unknown>;
        const rota = typeof saida.rota === 'string' ? saida.rota : r.text ? 'respondeu' : null;
        const resposta =
          typeof saida.mensagem_de_resposta === 'string' && saida.mensagem_de_resposta.trim()
            ? saida.mensagem_de_resposta.trim()
            : r.structured
              ? null
              : r.text.trim() || null;

        turnos.push({
          lead,
          resposta,
          rota,
          resumo: typeof saida.resumo === 'string' ? saida.resumo : null,
          toolCalls: r.toolCalls.map((t) => t.name),
          efeitos: r.efeitos,
          custoUsd: Number(r.usage.usdEstimate.toFixed(6)),
          tokens: r.usage.inputTokens + r.usage.outputTokens,
        });
        if (r.efeitos.agendou) agendou = true;

        historia.push({ role: 'user', content: lead });
        if (resposta) historia.push({ role: 'assistant', content: resposta });

        // Transferiu: em produção a próxima mensagem seria de um humano, não
        // do agente — não faz sentido continuar o roteiro.
        if (rota === 'humano') {
          transferiu = true;
          break;
        }
      } catch (err) {
        erro = err instanceof Error ? err.message : String(err);
        turnos.push({ lead, resposta: null, rota: null, resumo: null, toolCalls: [], efeitos: {}, custoUsd: 0, tokens: 0, erro });
        break;
      }
    }

    return { nome: conversa.nome, turnos, transferiu, agendou, erro };
  }

  // ============================================
  // Passos do provisionamento
  // ============================================

  private async resolverProvider(accountId: string, pedido: AiProviderName | null): Promise<AiProviderName> {
    if (pedido) {
      if (await hasProvider(accountId, pedido)) return pedido;
      throw new AppError(this.mensagemSemChave(pedido), 409, 'IA_SEM_CHAVE');
    }
    if (await hasProvider(accountId, 'openai')) return 'openai';
    if (await hasProvider(accountId, 'anthropic')) return 'anthropic';
    throw new AppError(
      'A conta não tem chave de IA. Configure a chave OpenAI ou Anthropic da conta em Integrações antes de provisionar.',
      409,
      'IA_SEM_CHAVE'
    );
  }

  private mensagemSemChave(provider: AiProviderName): string {
    const nome = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    return `A conta não tem chave ${nome}. Configure a chave ${nome} da conta em Integrações.`;
  }

  private async acharAgente(accountId: string, agentId: string | null, nome: string) {
    if (agentId) {
      const porId = await prisma.aiAgent.findFirst({ where: { id: agentId, accountId } });
      if (!porId) throw new NotFoundError('Agente de IA');
      return porId;
    }
    return prisma.aiAgent.findFirst({
      where: { accountId, name: { equals: nome.trim(), mode: 'insensitive' } },
    });
  }

  private async exigirProvisionado(agentId: string) {
    const agente = await prisma.aiAgent.findUnique({ where: { id: agentId } });
    if (!agente || agente.specVersao === 0) throw new NotFoundError('Agente provisionado');
    return agente;
  }

  /** O fluxo da versão mais recente que ainda existe; senão o de nome fixo. */
  private async fluxoDoAgente(accountId: string, agentId: string) {
    const ultima = await prisma.agentSpecVersion.findFirst({
      where: { agentId, flowId: { not: null } },
      orderBy: { versao: 'desc' },
      select: { flowId: true },
    });
    if (ultima?.flowId) {
      const f = await prisma.flow.findFirst({ where: { id: ultima.flowId, accountId } });
      if (f) return f;
    }
    const agente = await prisma.aiAgent.findUnique({ where: { id: agentId }, select: { name: true } });
    if (!agente) return null;
    return prisma.flow.findFirst({ where: { accountId, name: nomeDoFluxo(agente.name) } });
  }

  // ---- 1. Base ----

  private async sincronizarBase(
    accountId: string,
    spec: SpecV1,
    baseAtualId: string | null,
    avisos: string[]
  ): Promise<string> {
    const nome = `${spec.negocio.nome.trim()} — base da ${spec.agente.nome.trim()}`;
    const contexto = this.contextoDoNegocio(spec);

    let baseId: string;
    const atual = baseAtualId ? await prisma.knowledgeBase.findFirst({ where: { id: baseAtualId, accountId } }) : null;
    if (atual) {
      await knowledgeService.updateBase(accountId, atual.id, {
        ...(atual.name !== nome ? { name: nome } : {}),
        businessContext: contexto,
      });
      baseId = atual.id;
    } else {
      const porNome = await prisma.knowledgeBase.findFirst({ where: { accountId, name: nome } });
      if (porNome) {
        await knowledgeService.updateBase(accountId, porNome.id, { businessContext: contexto });
        baseId = porNome.id;
      } else {
        const criada = await knowledgeService.createBase(accountId, {
          name: nome,
          description: 'Criada pelo provisionamento do agente. Os documentos marcados como "provisionamento" são regravados a cada versão.',
          businessContext: contexto,
        });
        baseId = criada.id;
      }
    }

    // Documentos desejados, na ordem em que entram no índice.
    const desejados: { title: string; content: string }[] = [{ title: TITULO_SOBRE, content: this.documentoSobre(spec) }];
    for (const t of spec.conhecimento.textos) desejados.push({ title: t.titulo.trim(), content: t.conteudo.trim() });
    if (spec.conhecimento.faq.length > 0) desejados.push({ title: TITULO_FAQ, content: this.documentoFaq(spec) });

    const existentes = await prisma.knowledgeDoc.findMany({
      where: { accountId, baseId, sourceRef: ORIGEM_DOC },
      select: { id: true, title: true, content: true },
    });
    const porTitulo = new Map(existentes.map((d) => [d.title.toLowerCase(), d]));
    const mantidos = new Set<string>();

    for (const d of desejados) {
      const achado = porTitulo.get(d.title.toLowerCase());
      if (achado) {
        mantidos.add(achado.id);
        if (achado.content !== d.content) {
          // Conteúdo novo → volta pra fila de indexação (o updateDoc já faz).
          await knowledgeService.updateDoc(accountId, achado.id, { content: d.content });
        }
      } else {
        const criado = await knowledgeService.createDoc(accountId, baseId, {
          title: d.title,
          content: d.content,
          sourceType: 'text',
          sourceRef: ORIGEM_DOC,
        });
        mantidos.add(criado.id);
      }
    }
    // O que o provisionamento criou e o spec não pede mais, sai. Documento
    // que o admin subiu à mão não tem a marca e fica.
    for (const d of existentes) {
      if (!mantidos.has(d.id)) await knowledgeService.deleteDoc(accountId, d.id);
    }

    if (!(await hasProvider(accountId, 'openai'))) {
      avisos.push(
        'A base de conhecimento só é indexada com chave OpenAI (embeddings). Sem ela os documentos ficam pendentes e o agente responde sem a base.'
      );
    }
    return baseId;
  }

  private contextoDoNegocio(spec: SpecV1): string {
    const n = spec.negocio;
    const partes = [n.sobre.trim()];
    if (n.endereco?.trim()) partes.push(`Endereço: ${n.endereco.trim()}`);
    if (n.contato?.trim()) partes.push(`Contato: ${n.contato.trim()}`);
    return partes.join('\n').slice(0, MAX_CONTEXTO_BASE);
  }

  private documentoSobre(spec: SpecV1): string {
    const n = spec.negocio;
    const partes = [`${n.nome.trim()} (${n.segmento})`, '', n.sobre.trim()];
    if (n.endereco?.trim()) partes.push('', `Endereço: ${n.endereco.trim()}`);
    if (n.contato?.trim()) partes.push(`Contato: ${n.contato.trim()}`);
    if (n.diferenciais.length > 0) partes.push('', 'Diferenciais:', ...n.diferenciais.map((d) => `- ${d.trim()}`));
    if (spec.servicos.length > 0) {
      partes.push('', 'Serviços:');
      for (const s of spec.servicos) {
        const preco = s.valorPadrao > 0 ? ` — ${moeda(s.valorPadrao)}` : '';
        partes.push(`- ${s.nome.trim()} (${s.duracaoMinutos} min)${preco}${s.descricao?.trim() ? `: ${s.descricao.trim()}` : ''}`);
      }
    }
    if (spec.regras.linksUteis.length > 0) {
      partes.push('', 'Links úteis:', ...spec.regras.linksUteis.map((l) => `- ${l.rotulo.trim()}: ${l.url}`));
    }
    return partes.join('\n');
  }

  /**
   * FAQ como UM documento "P: / R:" por par, separados por linha em branco.
   * O chunker quebra por parágrafo, então cada pergunta vira um trecho
   * próprio — é o formato que a busca por similaridade acha melhor.
   */
  private documentoFaq(spec: SpecV1): string {
    return spec.conhecimento.faq
      .map((f) => `P: ${f.pergunta.trim()}\nR: ${f.resposta.trim()}`)
      .join('\n\n');
  }

  // ---- 2. Serviços ----

  private async sincronizarServicos(accountId: string, spec: SpecV1, atorId: string | null): Promise<string[]> {
    const ids: string[] = [];
    for (const s of spec.servicos) {
      const nome = s.nome.trim();
      const existente = await prisma.product.findFirst({
        where: { accountId, nome: { equals: nome, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existente) {
        await productService.update(
          existente.id,
          { nome, valorPadrao: s.valorPadrao, duracaoMinutos: s.duracaoMinutos, ativo: true },
          accountId,
          atorId ?? undefined
        );
        ids.push(existente.id);
      } else {
        const criado = await productService.create(
          { accountId, nome, valorPadrao: s.valorPadrao, duracaoMinutos: s.duracaoMinutos },
          atorId ?? undefined
        );
        ids.push(criado.id);
      }
    }
    return ids;
  }

  // ---- 3. Etapas ----

  private async sincronizarEtapas(
    accountId: string,
    spec: SpecV1,
    atorId: string | null
  ): Promise<{ etapas: EtapasDoFluxo; mapa: Record<string, string> }> {
    let funil = await prisma.funnel.findFirst({
      where: { accountId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!funil) {
      funil = await prisma.funnel.create({
        data: { accountId, name: 'Funil Principal', slug: 'principal', isDefault: true },
      });
      await criarEtapasFixas(prisma, accountId, funil.id, funil.slug);
    }

    const mapa: Record<string, string> = {};
    const slugs: Record<string, string> = {};
    for (const nome of etapasDoSpec(spec)) {
      const existente = await prisma.tag.findFirst({
        where: { accountId, type: 'stage', name: { equals: nome, mode: 'insensitive' } },
        select: { id: true, slug: true, name: true },
      });
      const tag =
        existente ??
        (await tagService.create({ accountId, funnelId: funil.id, name: nome, type: 'stage' }, atorId ?? undefined));
      mapa[nome] = tag.id;
      slugs[nome.toLowerCase()] = tag.slug;
    }

    const fixas = await prisma.tag.findMany({
      where: { accountId, type: 'stage', papel: { not: null } },
      select: { slug: true },
    });

    const slugDe = (nome: string) => slugs[nome.trim().toLowerCase()];
    return {
      mapa,
      etapas: {
        atender: slugDe(spec.funil.etapaAoAtender),
        agendar: slugDe(spec.funil.etapaAoAgendar),
        transferir: slugDe(spec.funil.etapaAoTransferir),
        terminais: fixas.map((f) => f.slug),
      },
    };
  }

  // ---- 4. Agenda ----

  private async sincronizarAgenda(
    accountId: string,
    timezoneAtual: string,
    spec: SpecV1,
    etapas: EtapasDoFluxo,
    productIds: string[],
    avisos: string[]
  ): Promise<{ agendaDoAgente: { ativo: boolean; profissionalIds: string[]; produtoIds: string[] } | null; profissionais: Record<string, string | null> }> {
    const profissionais: Record<string, string | null> = {};
    if (!spec.agenda.ativo) return { agendaDoAgente: null, profissionais };

    const fuso = spec.agenda.fuso?.trim();
    if (fuso && fuso !== timezoneAtual) {
      if (!fusoValido(fuso)) throw new ValidationError(`agenda.fuso inválido: "${fuso}" (use um nome IANA, ex.: America/Sao_Paulo)`);
      await prisma.account.update({ where: { id: accountId }, data: { timezone: fuso } });
      avisos.push(`Fuso da conta alterado de ${timezoneAtual} para ${fuso} (a agenda inteira usa o fuso da conta).`);
    }

    const horarios: HorariosSemanais = {};
    for (const faixa of spec.agenda.horarios) {
      for (const dia of faixa.dias) {
        (horarios[String(dia)] ??= []).push({ inicio: faixa.inicio, fim: faixa.fim });
      }
    }

    const profissionalIds: string[] = [];
    for (const { email } of spec.agenda.profissionais) {
      const usuario = await prisma.user.findFirst({
        where: { accountId, status: 'active', email: { equals: email.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (!usuario) {
        profissionais[email] = null;
        avisos.push(`Profissional ${email} não tem usuário ativo nesta conta — crie o usuário e provisione de novo para ele entrar na agenda.`);
        continue;
      }
      await agendaService.salvarProfissional(accountId, usuario.id, { ativo: true, horarios });
      profissionais[email] = usuario.id;
      profissionalIds.push(usuario.id);
    }

    await agendaService.salvarConfiguracao(accountId, {
      antecedenciaMinimaMinutos: Math.round(spec.agenda.antecedenciaMinimaHoras * 60),
      etapaAoAgendar: etapas.agendar,
    });

    if (profissionalIds.length === 0) {
      avisos.push('Agenda desligada no agente: nenhum profissional com usuário na conta. O fluxo mantém a porta "agendou" para quando houver.');
      return { agendaDoAgente: null, profissionais };
    }
    if (productIds.length === 0) {
      avisos.push('Agenda desligada no agente: nenhum serviço no spec. Informe `servicos[]` com duração.');
      return { agendaDoAgente: null, profissionais };
    }
    if (spec.agenda.horarios.length === 0) {
      avisos.push('Agenda sem horários de expediente: nenhum horário será oferecido até configurar `agenda.horarios`.');
    }
    return { agendaDoAgente: { ativo: true, profissionalIds, produtoIds: productIds }, profissionais };
  }

  // ---- 6. Fluxo ----

  private async sincronizarFluxo(
    accountId: string,
    agentId: string,
    agentIdAnterior: string | null,
    spec: SpecV1,
    etapas: EtapasDoFluxo,
    avisos: string[]
  ): Promise<string> {
    const graph = montarGrafo({ agentId, spec, etapas });
    const problemas = validateGraph(graph);
    if (problemas.length > 0) {
      // É o nosso template: se falhar, é defeito nosso, não do briefing.
      throw new AppError(`O fluxo gerado não passou na validação: ${problemas.join(' ')}`, 500, 'FLUXO_INVALIDO');
    }

    const inboxIds = await this.resolverInboxes(accountId, spec);
    const nome = nomeDoFluxo(spec.agente.nome);
    const descricao = `Fluxo montado pelo provisionamento do agente ${spec.agente.nome.trim()}. Re-provisionar regrava o desenho; edições à mão são perdidas.`;

    const existente = agentIdAnterior ? await this.fluxoDoAgente(accountId, agentIdAnterior) : await prisma.flow.findFirst({ where: { accountId, name: nome } });

    if (existente) {
      await flowService.update(accountId, existente.id, {
        ...(existente.name !== nome ? { name: nome } : {}),
        description: descricao,
        graph,
        inboxIds,
      });
      if (existente.status === 'draft') {
        avisos.push(`O fluxo "${nome}" está em rascunho (draft) — publique em shadow ou active quando quiser que ele rode.`);
      }
      return existente.id;
    }

    const criado = await flowService.create(accountId, { name: nome, description: descricao, graph, inboxIds });
    await flowService.setStatus(accountId, criado.id, 'shadow');
    return criado.id;
  }

  private async resolverInboxes(accountId: string, spec: SpecV1): Promise<string[] | null> {
    if (!spec.inboxIds || spec.inboxIds.length === 0) return null;
    const ids = Array.from(new Set(spec.inboxIds));
    const achados = await prisma.inbox.findMany({ where: { accountId, id: { in: ids } }, select: { id: true } });
    if (achados.length !== ids.length) {
      const faltando = ids.filter((id) => !achados.some((a) => a.id === id));
      throw new ValidationError(`inboxIds: inbox não encontrada nesta conta: ${faltando.join(', ')}`);
    }
    return ids;
  }
}

function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Turno excedeu ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([p, limite]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const provisionarService = new ProvisionarService();
