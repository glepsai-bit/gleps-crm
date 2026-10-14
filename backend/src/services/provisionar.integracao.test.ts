/**
 * PROVISIONAMENTO — de ponta a ponta contra o Postgres de teste, pela API.
 *
 * Só o modelo de IA é mockado (`chat`). Banco, services de knowledge,
 * produto, agenda, etapa, agente e fluxo são reais — é o que prova que a
 * migration 0075 existe, que o re-provisionamento não duplica nada e que a
 * simulação em sombra não deixa rastro (conversa, mensagem, reunião, run).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/chat', async (orig) => ({ ...(await orig<typeof import('./ai/chat')>()), chat: chatMock }));
// ETAPA G: a validação de modelo (GET /v1/models do provider) é mockada —
// sem isto a chave fake "sk-teste" bateria na OpenAI real e voltaria 401.
const exigirModeloValidoMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/modelos', async (orig) => ({
  ...(await orig<typeof import('./ai/modelos')>()),
  exigirModeloValido: exigirModeloValidoMock,
}));

// A chave NOVA é testada no provedor antes de gravar (PUT /conta/:id/ia) — mockado, sem rede.
const testarChaveMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/openai-provider', async (orig) => ({
  ...(await orig<typeof import('./ai/openai-provider')>()),
  openaiProvider: { name: 'openai', testConnection: testarChaveMock },
}));
vi.mock('./ai/anthropic-provider', async (orig) => ({
  ...(await orig<typeof import('./ai/anthropic-provider')>()),
  anthropicProvider: { name: 'anthropic', testConnection: testarChaveMock },
}));

import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { prisma } from '../config/database';
import { ValidationError } from '../utils/errors';
import { criarEtapasFixas } from './tag.service';
import { codificarHorario } from './agenda.service';
import { __clearKeyCache } from './ai/client-factory';
import { mensagemDeModeloInvalido } from './ai/modelos';
import { SPEC_CLINICA, SPEC_MINIMO, SPEC_SDR } from './provisionar/fixtures.test-util';
import { NOS } from './provisionar/template-fluxo';

const app = createTestApp();
const ROTA = '/api/admin/provisionar';

/** Mesmo motivo do flow.integracao.test: dois PrismaClient e o TRUNCATE entre casos. */
async function comRetry<T>(fn: () => Promise<T>, tentativas = 12): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const codigo = (err as { code?: string }).code;
      if (codigo !== 'P2003' && codigo !== 'P2025') throw err;
      ultimo = err;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw ultimo;
}

async function superAdmin() {
  const user = await comRetry(() =>
    prismaTest.user.create({
      data: {
        accountId: null,
        nome: 'Super',
        email: `super-${randomUUID().slice(0, 8)}@gleps.com`,
        passwordHash: bcrypt.hashSync('x', 4),
        role: 'super_admin',
        status: 'active',
        permissions: [],
      },
    })
  );
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: 'super_admin', accountId: null, permissions: [] },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { user, token };
}

async function contaCliente(opts: { comChave?: boolean; comCarlos?: boolean } = {}) {
  const account = await comRetry(() =>
    prismaTest.account.create({
      data: { nome: 'Clínica Vida Plena', openaiApiKey: opts.comChave === false ? null : 'sk-teste' },
    })
  );
  const funil = await comRetry(() =>
    prismaTest.funnel.create({ data: { accountId: account.id, name: 'Funil Principal', slug: 'principal', isDefault: true } })
  );
  await criarEtapasFixas(prismaTest, account.id, funil.id, funil.slug);
  const inbox = await comRetry(() =>
    prismaTest.inbox.create({ data: { accountId: account.id, name: 'WhatsApp', channelType: 'whatsapp', active: true } })
  );
  let carlos: { id: string } | null = null;
  if (opts.comCarlos !== false) {
    carlos = await comRetry(() =>
      prismaTest.user.create({
        data: {
          accountId: account.id,
          nome: 'Dr. Carlos',
          email: 'carlos@clinicavidaplena.com',
          passwordHash: bcrypt.hashSync('x', 4),
          role: 'admin',
          status: 'active',
          permissions: [],
        },
      })
    );
  }
  const admin = await comRetry(() =>
    prismaTest.user.create({
      data: {
        accountId: account.id,
        nome: 'Admin da conta',
        email: `admin-${randomUUID().slice(0, 8)}@t.com`,
        passwordHash: bcrypt.hashSync('x', 4),
        role: 'admin',
        status: 'active',
        permissions: [],
      },
    })
  );
  const tokenAdmin = jwt.sign(
    { sub: admin.id, email: admin.email, role: 'admin', accountId: account.id, permissions: [] },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { account, funil, inbox, carlos, tokenAdmin };
}

const respostaChat = (text: string, toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []) => ({
  text,
  toolCalls,
  model: 'gpt-4o-mini',
  provider: 'openai',
  usage: { inputTokens: 100, outputTokens: 20, usdEstimate: 0.0001, priced: true },
  finishReason: 'stop',
});

/** Um horário válido pelas regras do spec (seg–sex, 10:00, ≥ 2 dias à frente). */
function horarioValidoPara(profissionalId: string, produtoId: string): string {
  const tz = 'America/Sao_Paulo';
  let d = new Date(Date.now() + 2 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    const dow = Number(formatInTimeZone(d, tz, 'i')) % 7;
    if (dow >= 1 && dow <= 5) break;
    d = new Date(d.getTime() + 86_400_000);
  }
  const inicio = fromZonedTime(`${formatInTimeZone(d, tz, 'yyyy-MM-dd')}T10:00:00`, tz);
  return codificarHorario({ profissionalId, produtoId, inicio });
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 800));
});

beforeEach(() => {
  vi.clearAllMocks();
  __clearKeyCache();
  chatMock.mockResolvedValue(respostaChat(JSON.stringify({ mensagem_de_resposta: 'ok', rota: 'respondeu' })));
  exigirModeloValidoMock.mockImplementation(async (p: { model?: string | null }) => ({ ok: true, model: p.model ?? '', verificado: true }));
  testarChaveMock.mockResolvedValue({ ok: true, message: 'Conexao OK' });
});

describe('POST /admin/provisionar/agente', () => {
  it('cria base+docs, serviços, etapas, agenda, agente (prompt por seções) e fluxo em sombra — versão 1', async () => {
    const { token, user } = await superAdmin();
    const { account, carlos } = await contaCliente();

    const res = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const d = res.body.data;
    expect(d.versao).toBe(1);
    expect(d.productIds).toHaveLength(2);
    expect(Object.keys(d.etapas)).toEqual(['Em atendimento', 'Agendado', 'Com humano']);
    expect(d.profissionais).toEqual({ 'carlos@clinicavidaplena.com': carlos!.id });
    expect(d.avisos).toEqual([]);

    // Base + 3 documentos marcados como do provisionamento, pendentes de indexação.
    const base = await prismaTest.knowledgeBase.findUnique({ where: { id: d.knowledgeBaseId } });
    expect(base?.name).toBe('Clínica Vida Plena — base da Bia');
    expect(base?.businessContext).toContain('Clínica médica com foco');
    const docs = await prismaTest.knowledgeDoc.findMany({ where: { baseId: d.knowledgeBaseId }, orderBy: { createdAt: 'asc' } });
    expect(docs.map((x) => x.title)).toEqual(['Sobre o negócio', 'Convênios', 'Perguntas frequentes']);
    expect(docs.every((x) => x.sourceRef === 'provisionamento' && x.status === 'pending')).toBe(true);
    expect(docs[2].content).toBe('P: Atendem sábado?\nR: Não, de segunda a sexta.\n\nP: Tem estacionamento?\nR: Sim, gratuito para pacientes.');

    // Serviços com duração.
    const produtos = await prismaTest.product.findMany({ where: { accountId: account.id }, orderBy: { nome: 'asc' } });
    expect(produtos.map((p) => [p.nome, p.duracaoMinutos, Number(p.valorPadrao)])).toEqual([
      ['Avaliação', 20, 0],
      ['Consulta clínica', 30, 250],
    ]);

    // Etapas novas ANTES das fixas.
    const etapas = await prismaTest.tag.findMany({ where: { accountId: account.id, type: 'stage' }, orderBy: { ordem: 'asc' } });
    expect(etapas.map((e) => e.name)).toEqual(['Em atendimento', 'Agendado', 'Com humano', 'Fechado', 'Perdido']);

    // Agenda: regras + profissional.
    const cfg = await prismaTest.agendaConfiguracao.findUnique({ where: { accountId: account.id } });
    expect(cfg).toMatchObject({ antecedenciaMinimaMinutos: 120, etapaAoAgendar: 'agendado' });
    const prof = await prismaTest.agendaProfissional.findUnique({ where: { userId: carlos!.id } });
    expect(prof?.ativo).toBe(true);
    expect(prof?.horarios).toEqual({
      '1': [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
      '2': [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
      '3': [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
      '4': [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
      '5': [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
    });

    // Agente — modelo padrão do provisionamento (gpt-4.1), conferido ANTES de criar.
    const agente = await prismaTest.aiAgent.findUnique({ where: { id: d.agentId } });
    expect(agente).toMatchObject({ name: 'Bia', role: 'responder', provider: 'openai', model: 'gpt-4.1', knowledgeBaseId: d.knowledgeBaseId, specVersao: 1 });
    expect(exigirModeloValidoMock).toHaveBeenCalledWith({ accountId: account.id, provider: 'openai', model: 'gpt-4.1' });
    expect(Number(agente!.temperature)).toBe(0.4);
    expect(agente!.systemPrompt).toContain('IDENTIDADE');
    expect(agente!.systemPrompt).toContain('AGENDA');
    expect(agente!.tools).toEqual(['lembrar', 'buscar_conhecimento']);
    expect(agente!.agenda).toEqual({ ativo: true, profissionalIds: [carlos!.id], produtoIds: d.productIds });
    expect(agente!.memoryFields).toEqual([
      { chave: 'motivo', descricao: 'motivo do contato', escopo: 'memoria' },
      { chave: 'ja_paciente', descricao: 'se já é paciente (sim/não)', escopo: 'memoria' },
    ]);
    expect((agente!.outputSchema as { properties: { rota: { enum: string[] } } }).properties.rota.enum).toEqual(['respondeu', 'humano']);
    expect(agente!.spec).toMatchObject({ versao: 1, agente: { nome: 'Bia' } });

    // Fluxo em sombra, com as portas.
    const flow = await prismaTest.flow.findUnique({ where: { id: d.flowId } });
    expect(flow).toMatchObject({ name: 'Atendimento — Bia', status: 'shadow', inboxIds: null });
    const graph = flow!.graph as { nodes: { id: string; type: string; config: Record<string, unknown> }[]; edges: { source: string; branch?: string; target: string }[] };
    expect(graph.nodes.find((n) => n.id === NOS.atender)?.config.agentId).toBe(d.agentId);
    expect(graph.edges.filter((e) => e.source === NOS.atender).map((e) => e.branch).sort()).toEqual(['agendou', 'encerrou', 'humano', 'respondeu']);

    // Versão + auditoria.
    const versoes = await prismaTest.agentSpecVersion.findMany({ where: { agentId: d.agentId } });
    expect(versoes).toHaveLength(1);
    expect(versoes[0]).toMatchObject({ versao: 1, flowId: d.flowId, criadoPor: user.id, accountId: account.id });
    const evento = await prismaTest.event.findFirst({ where: { accountId: account.id, eventType: 'agente.provisionado' } });
    expect(evento).toMatchObject({ entityType: 'ai_agent', entityId: d.agentId, actorId: user.id });
  });

  it('de novo com o mesmo nome ATUALIZA: mesmos ids, versão 2, nada duplicado, doc regravado', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const primeiro = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(primeiro.status).toBe(201);
    // Alguém pôs o fluxo em active entre um provisionamento e outro: fica.
    await prisma.flow.update({ where: { id: primeiro.body.data.flowId }, data: { status: 'active' } });

    const spec2 = { ...SPEC_CLINICA, negocio: { ...SPEC_CLINICA.negocio, sobre: 'Texto novo sobre a clínica.' } };
    const segundo = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: spec2 });
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(200);

    const a = primeiro.body.data;
    const b = segundo.body.data;
    expect(b.agentId).toBe(a.agentId);
    expect(b.flowId).toBe(a.flowId);
    expect(b.knowledgeBaseId).toBe(a.knowledgeBaseId);
    expect(b.productIds).toEqual(a.productIds);
    expect(b.etapas).toEqual(a.etapas);
    expect(b.versao).toBe(2);

    expect(await prismaTest.aiAgent.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prismaTest.flow.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prismaTest.knowledgeBase.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prismaTest.knowledgeDoc.count({ where: { accountId: account.id } })).toBe(3);
    expect(await prismaTest.product.count({ where: { accountId: account.id } })).toBe(2);
    expect(await prismaTest.tag.count({ where: { accountId: account.id, type: 'stage' } })).toBe(5);
    expect(await prismaTest.agentSpecVersion.count({ where: { agentId: a.agentId } })).toBe(2);

    const sobre = await prismaTest.knowledgeDoc.findFirst({ where: { baseId: a.knowledgeBaseId, title: 'Sobre o negócio' } });
    expect(sobre?.content).toContain('Texto novo sobre a clínica.');
    const flow = await prismaTest.flow.findUnique({ where: { id: a.flowId } });
    expect(flow?.status).toBe('active');
    expect(flow?.version).toBe(2);
    expect(await prismaTest.event.count({ where: { accountId: account.id, eventType: 'agente.atualizado' } })).toBe(1);
  });

  it('conta sem chave de IA → 409 dizendo qual chave configurar', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente({ comChave: false });
    const res = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_MINIMO });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IA_SEM_CHAVE');
    expect(res.body.error.message).toContain('Configure a chave OpenAI ou Anthropic da conta em Integrações');
    expect(await prismaTest.aiAgent.count()).toBe(0);
  });

  it('conta inexistente → 404; spec inválido → 400 em português com o caminho; admin comum → 403', async () => {
    const { token } = await superAdmin();
    const { account, tokenAdmin } = await contaCliente();

    const r404 = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: randomUUID(), spec: SPEC_MINIMO });
    expect(r404.status).toBe(404);
    expect(r404.body.error.message).toBe('Conta não encontrada');

    const r400 = await request(app)
      .post(`${ROTA}/agente`)
      .set(authHeader(token))
      .send({ accountId: account.id, spec: { ...SPEC_MINIMO, negocio: { segmento: 'clinica', sobre: 'x' }, agente: { nome: 'A', tom: 'bravo' } } });
    expect(r400.status).toBe(400);
    expect(r400.body.error.code).toBe('VALIDATION_ERROR');
    expect(r400.body.error.message).toBe('Dados inválidos: spec.negocio.nome — negocio.nome é obrigatório');
    expect(r400.body.error.fieldErrors).toContainEqual({ field: 'spec.agente.tom', message: 'tom precisa ser um de: acolhedor, direto, formal, descontraido' });

    // Envelope sem spec e spec sem os objetos obrigatórios: nada de "Required".
    const semSpec = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id });
    expect(semSpec.status).toBe(400);
    expect(semSpec.body.error.message).toBe('Dados inválidos: spec — spec é obrigatório');
    const semObjetos = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ spec: { versao: 1 } });
    expect(semObjetos.status).toBe(400);
    expect(semObjetos.body.error.fieldErrors).toContainEqual({ field: 'accountId', message: 'accountId é obrigatório' });
    expect(semObjetos.body.error.fieldErrors).toContainEqual({ field: 'spec.negocio', message: 'spec.negocio é obrigatório' });
    expect(JSON.stringify(semObjetos.body)).not.toContain('Required');

    const r403 = await request(app).post(`${ROTA}/agente`).set(authHeader(tokenAdmin)).send({ accountId: account.id, spec: SPEC_MINIMO });
    expect(r403.status).toBe(403);
    expect(await request(app).get(`${ROTA}/conversas-teste/clinica`).set(authHeader(tokenAdmin)).then((r) => r.status)).toBe(403);
  });

  it('[G] modelo inexistente (ou chave sem acesso) → 400 ANTES de criar qualquer coisa', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    exigirModeloValidoMock.mockRejectedValueOnce(new ValidationError(mensagemDeModeloInvalido('gpt-9')));

    const res = await request(app)
      .post(`${ROTA}/agente`)
      .set(authHeader(token))
      .send({ accountId: account.id, spec: { ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, model: 'gpt-9' } } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Modelo "gpt-9" não existe ou a chave não tem acesso');
    expect(exigirModeloValidoMock).toHaveBeenCalledWith({ accountId: account.id, provider: 'openai', model: 'gpt-9' });
    expect(await prismaTest.aiAgent.count()).toBe(0);
    expect(await prismaTest.knowledgeBase.count()).toBe(0);
    expect(await prismaTest.flow.count()).toBe(0);
    expect(await prismaTest.product.count()).toBe(0);
  });

  it('[G] spec v1.1 (sdr): só o item agendável vira Product; prompt com COMO VENDER e CATÁLOGO; 3 toques; modelo/raciocinio do spec', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const res = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_SDR });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = res.body.data;

    expect(d.productIds).toHaveLength(2);
    const produtos = await prismaTest.product.findMany({ where: { accountId: account.id }, orderBy: { nome: 'asc' } });
    expect(produtos.map((p) => [p.nome, p.duracaoMinutos, Number(p.valorPadrao)])).toEqual([
      ['Avaliação', 30, 0],
      ['Limpeza de pele', 60, 180],
    ]);

    const agente = await prismaTest.aiAgent.findUnique({ where: { id: d.agentId } });
    expect(agente).toMatchObject({ name: 'Sofia', provider: 'openai', model: 'gpt-5-mini' });
    expect(exigirModeloValidoMock).toHaveBeenCalledWith({ accountId: account.id, provider: 'openai', model: 'gpt-5-mini' });
    expect(agente!.systemPrompt).toContain('COMO VENDER');
    expect(agente!.systemPrompt).toContain('| Está caro | A avaliação é gratuita e o plano cabe em 10x. |');
    expect(agente!.systemPrompt).toContain('- Plano mensal — R$ 390,00 por mês — 4 sessões por mês');
    expect(agente!.systemPrompt).not.toContain('atendente virtual');

    const sobre = await prismaTest.knowledgeDoc.findFirst({ where: { baseId: d.knowledgeBaseId, title: 'Sobre o negócio' } });
    expect(sobre?.content).toContain('- Limpeza de pele — R$ 180,00 por sessão (duração 60 min)');

    const flow = await prismaTest.flow.findUnique({ where: { id: d.flowId } });
    const graph = flow!.graph as { nodes: { id: string; type: string; config: Record<string, unknown> }[] };
    expect(graph.nodes.find((n) => n.id === NOS.atender)?.config).toMatchObject({
      enviarTextoAoTransferir: true,
      mensagemAoTransferir: 'Vou chamar alguém da equipe para te ajudar, um instante.',
    });
    expect(graph.nodes.find((n) => n.id === 'avisar_transferencia')).toBeUndefined();
    expect(graph.nodes.filter((n) => n.type === 'flow.aguardar' && n.id.startsWith('fu')).map((n) => n.config.valor)).toEqual([2, 24, 72]);

    // O spec gravado é o normalizado (v1.1 com derivados) e passa de novo na validação (reverter revalida).
    expect(agente!.spec).toMatchObject({ versao: 1.1, agente: { papel: 'sdr', raciocinio: 'low' }, followup: { tentativas: ['2h', '1d', '3d'], aposHoras: 2, maxTentativas: 3 } });
    // Sem profissional na conta (marina): aviso, agenda do agente desligada.
    expect(d.avisos.join(' ')).toContain('marina@studioluz.com não tem usuário ativo');
  });

  it('profissional sem usuário na conta → aviso (não erro) e agenda do agente desligada', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente({ comCarlos: false });
    const res = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(res.status).toBe(201);
    expect(res.body.data.profissionais).toEqual({ 'carlos@clinicavidaplena.com': null });
    expect(res.body.data.avisos.join(' ')).toContain('carlos@clinicavidaplena.com não tem usuário ativo nesta conta');
    expect(res.body.data.avisos.join(' ')).toContain('Agenda desligada no agente');
    const agente = await prismaTest.aiAgent.findUnique({ where: { id: res.body.data.agentId } });
    expect(agente?.agenda).toBeNull();
    expect(agente?.systemPrompt).toContain('AGENDA'); // o prompt segue o spec; a habilidade liga quando houver profissional
  });

  it('inboxIds restringe o fluxo; inbox de outra conta → 400', async () => {
    const { token } = await superAdmin();
    const { account, inbox } = await contaCliente();
    const ok = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: { ...SPEC_MINIMO, inboxIds: [inbox.id] } });
    expect(ok.status).toBe(201);
    expect((await prismaTest.flow.findUnique({ where: { id: ok.body.data.flowId } }))?.inboxIds).toEqual([inbox.id]);

    const ruim = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: { ...SPEC_MINIMO, inboxIds: [randomUUID()] } });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error.message).toContain('inbox não encontrada nesta conta');
  });
});

describe('GET / PUT / reverter / publicar', () => {
  it('GET devolve spec, fluxo e versões; PUT re-provisiona; reverter aplica a versão antiga como versão nova', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    const agentId = criado.body.data.agentId as string;

    // PUT: agenda e FAQ saem.
    const semAgenda = { ...SPEC_CLINICA, agenda: { ativo: false }, conhecimento: { textos: SPEC_CLINICA.conhecimento!.textos } };
    const put = await request(app).put(`${ROTA}/agente/${agentId}`).set(authHeader(token)).send({ spec: semAgenda });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.versao).toBe(2);
    expect((await prismaTest.aiAgent.findUnique({ where: { id: agentId } }))?.agenda).toBeNull();
    expect(await prismaTest.knowledgeDoc.count({ where: { accountId: account.id } })).toBe(2);
    const graph2 = (await prismaTest.flow.findUnique({ where: { id: criado.body.data.flowId } }))!.graph as { edges: { branch?: string }[] };
    expect(graph2.edges.some((e) => e.branch === 'agendou')).toBe(false);

    // GET.
    const get = await request(app).get(`${ROTA}/agente/${agentId}`).set(authHeader(token));
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ agentId, accountId: account.id, nome: 'Bia', versao: 2, flow: { id: criado.body.data.flowId, status: 'shadow', inboxIds: null } });
    expect(get.body.data.spec.agenda.ativo).toBe(false);
    expect(get.body.data.versoes.map((v: { versao: number }) => v.versao)).toEqual([2, 1]);

    // Reverter para a 1: agenda volta, FAQ volta, versão 3.
    const rev = await request(app).post(`${ROTA}/agente/${agentId}/reverter`).set(authHeader(token)).send({ versao: 1 });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.data.versao).toBe(3);
    expect((await prismaTest.aiAgent.findUnique({ where: { id: agentId } }))?.agenda).toMatchObject({ ativo: true });
    expect(await prismaTest.knowledgeDoc.count({ where: { accountId: account.id } })).toBe(3);
    expect(await prismaTest.event.count({ where: { accountId: account.id, eventType: 'agente.revertido' } })).toBe(1);

    const semVersao = await request(app).post(`${ROTA}/agente/${agentId}/reverter`).set(authHeader(token)).send({ versao: 9 });
    expect(semVersao.status).toBe(404);
    const naoProvisionado = await request(app).get(`${ROTA}/agente/${randomUUID()}`).set(authHeader(token));
    expect(naoProvisionado.status).toBe(404);
  });

  it('GET normaliza na LEITURA o spec gravado em v1 cru (agente provisionado antes da v1.1) — e não grava nada', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    const agentId = criado.body.data.agentId as string;

    // Como um agente antigo: o spec guardado é o v1 do operador, sem tentativas/agendavel/defaults.
    const cru = JSON.parse(JSON.stringify(SPEC_CLINICA));
    await prismaTest.aiAgent.update({ where: { id: agentId }, data: { spec: cru } });

    const get = await request(app).get(`${ROTA}/agente/${agentId}`).set(authHeader(token));
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    const spec = get.body.data.spec;
    expect(spec.followup.tentativas).toEqual(['24h', '24h']); // aposHoras 24 × maxTentativas 2
    expect(spec.followup.janela).toEqual({ inicio: '08:00', fim: '20:00' });
    expect(spec.servicos[0]).toMatchObject({ nome: 'Consulta clínica', agendavel: true });

    // Só a leitura foi normalizada: a coluna continua como estava.
    expect((await prismaTest.aiAgent.findUnique({ where: { id: agentId } }))?.spec).toEqual(cru);
  });

  it('publicar: active demove outro fluxo ativo; shadow volta; sem chave de IA → 409', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const outro = await prisma.flow.create({
      data: { accountId: account.id, name: 'Antigo', status: 'active', graph: { nodes: [{ id: 'g', type: 'trigger.message_received' }], edges: [] } },
    });
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    const agentId = criado.body.data.agentId as string;

    const ativo = await request(app).post(`${ROTA}/agente/${agentId}/publicar`).set(authHeader(token)).send({ status: 'active' });
    expect(ativo.status, JSON.stringify(ativo.body)).toBe(200);
    expect(ativo.body.data).toEqual({ agentId, flowId: criado.body.data.flowId, status: 'active' });
    expect((await prismaTest.flow.findUnique({ where: { id: outro.id } }))?.status).toBe('draft');

    const sombra = await request(app).post(`${ROTA}/agente/${agentId}/publicar`).set(authHeader(token)).send({ status: 'shadow' });
    expect(sombra.body.data.status).toBe('shadow');

    await prisma.account.update({ where: { id: account.id }, data: { openaiApiKey: null } });
    __clearKeyCache();
    const semChave = await request(app).post(`${ROTA}/agente/${agentId}/publicar`).set(authHeader(token)).send({ status: 'active' });
    expect(semChave.status).toBe(409);
    expect(semChave.body.error.message).toBe('A conta não tem chave OpenAI. Configure a chave OpenAI da conta em Integrações.');
    expect((await prismaTest.flow.findUnique({ where: { id: criado.body.data.flowId } }))?.status).toBe('shadow');

    const invalido = await request(app).post(`${ROTA}/agente/${agentId}/publicar`).set(authHeader(token)).send({ status: 'ligado' });
    expect(invalido.status).toBe(400);
    expect(invalido.body.error.message).toContain('status precisa ser draft, shadow ou active');
  });
});

describe('[G] leituras para o kit: GET agente enriquecido, GET conta, PUT ia', () => {
  it('GET /agente/:id traz prompt, agenda (configuração + profissionais), serviços, usuários, inboxes e ia', async () => {
    const { token } = await superAdmin();
    const { account, carlos, inbox } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(criado.status).toBe(201);
    const agentId = criado.body.data.agentId as string;

    const get = await request(app).get(`${ROTA}/agente/${agentId}`).set(authHeader(token));
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    const d = get.body.data;
    expect(d.prompt).toContain('IDENTIDADE');
    expect(d.prompt).toContain('CATÁLOGO');
    expect(d.agenda).toMatchObject({
      ativo: true,
      configuracao: { antecedenciaMinimaMinutos: 120, etapaAoAgendar: 'agendado' },
      profissionais: [{ userId: carlos!.id, nome: 'Dr. Carlos', email: 'carlos@clinicavidaplena.com' }],
    });
    expect(d.servicos).toEqual([
      { id: criado.body.data.productIds[0], nome: 'Consulta clínica', valorPadrao: 250, unidade: null, duracaoMinutos: 30, agendavel: true, ativo: true },
      { id: criado.body.data.productIds[1], nome: 'Avaliação', valorPadrao: null, unidade: null, duracaoMinutos: 20, agendavel: true, ativo: true },
    ]);
    expect(d.usuarios.map((u: { email: string; role: string; ativo: boolean }) => [u.email, u.role, u.ativo])).toContainEqual([
      'carlos@clinicavidaplena.com',
      'admin',
      true,
    ]);
    expect(d.inboxes).toEqual([{ id: inbox.id, nome: 'WhatsApp', canal: 'whatsapp', ativa: true, conectada: false, estado: null }]);
    expect(d.ia).toEqual({ provider: 'openai', model: 'gpt-4.1', raciocinio: null, temChave: true });
    expect(JSON.stringify(get.body)).not.toContain('sk-teste');
  });

  it('GET /conta/:accountId: conta mascarada + usuários + inboxes + ia + agentes; PUT /conta/:accountId/ia grava a chave e confere o modelo', async () => {
    const { token } = await superAdmin();
    const { account, tokenAdmin } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_MINIMO });
    expect(criado.status).toBe(201);

    const get = await request(app).get(`${ROTA}/conta/${account.id}`).set(authHeader(token));
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body.data.conta).toMatchObject({ id: account.id, nome: 'Clínica Vida Plena', openaiApiKey: '••••', temChaveOpenai: true, temChaveAnthropic: false }); // 'sk-teste' tem 8 caracteres: a máscara não mostra o fim
    expect(JSON.stringify(get.body)).not.toContain('sk-teste');
    expect(get.body.data.ia).toEqual({ provider: 'openai', model: 'gpt-4.1', temChave: true, temChaveOpenai: true, temChaveAnthropic: false });
    expect(get.body.data.agentes).toEqual([{ id: criado.body.data.agentId, nome: 'Léo', versao: 1, flowStatus: 'shadow' }]);
    expect(get.body.data.usuarios.length).toBeGreaterThanOrEqual(2);
    expect(get.body.data.inboxes).toHaveLength(1);

    // PUT ia: grava a chave Anthropic (cache de chave derrubado: hasProvider vê na hora), modelo conferido com a chave nova.
    const put = await request(app)
      .put(`${ROTA}/conta/${account.id}/ia`)
      .set(authHeader(token))
      .send({ provider: 'anthropic', apiKey: 'sk-ant-nova-chave-12345', model: 'claude-sonnet-4-5' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.ia).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', temChaveAnthropic: true, temChaveOpenai: true, verificado: true });
    expect(JSON.stringify(put.body)).not.toContain('sk-ant-nova');
    expect((await prismaTest.account.findUnique({ where: { id: account.id } }))?.anthropicApiKey).toBe('sk-ant-nova-chave-12345');
    expect(exigirModeloValidoMock).toHaveBeenCalledWith({ accountId: account.id, provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(await prismaTest.event.count({ where: { accountId: account.id, eventType: 'account.integrations_updated' } })).toBe(1);

    // Chave RECUSADA pelo provedor (401): 400 e NADA muda — a chave que funcionava continua lá.
    const chaveAntes = (await prismaTest.account.findUnique({ where: { id: account.id } }))?.openaiApiKey;
    expect(chaveAntes).toBe('sk-teste');
    const modeloChamadas = exigirModeloValidoMock.mock.calls.length;
    testarChaveMock.mockResolvedValueOnce({ ok: false, status: 401, message: 'Chave invalida (401)' });
    const recusada = await request(app)
      .put(`${ROTA}/conta/${account.id}/ia`)
      .set(authHeader(token))
      .send({ provider: 'openai', apiKey: '  sk-chave-ruim-000000  ', model: 'gpt-4.1' });
    expect(recusada.status).toBe(400);
    expect(recusada.body.error.message).toContain('Chave recusada pelo provedor; nada foi alterado');
    expect(testarChaveMock).toHaveBeenLastCalledWith('sk-chave-ruim-000000'); // a NOVA, já aparada
    expect((await prismaTest.account.findUnique({ where: { id: account.id } }))?.openaiApiKey).toBe(chaveAntes);
    expect(exigirModeloValidoMock.mock.calls.length).toBe(modeloChamadas); // nem chegou a conferir o modelo
    expect(await prismaTest.event.count({ where: { accountId: account.id, eventType: 'account.integrations_updated' } })).toBe(1);

    // Falha do teste que NÃO é 401 (chave restrita sem permissão de listar, 429, rede): grava, com aviso.
    testarChaveMock.mockResolvedValueOnce({ ok: false, status: 403, message: 'Chave sem permissao (403)' });
    const restrita = await request(app)
      .put(`${ROTA}/conta/${account.id}/ia`)
      .set(authHeader(token))
      .send({ provider: 'openai', apiKey: 'sk-chave-restrita-111111' });
    expect(restrita.status, JSON.stringify(restrita.body)).toBe(200);
    expect(restrita.body.data.ia.aviso).toContain('Não deu para validar a chave agora (Chave sem permissao (403))');
    expect((await prismaTest.account.findUnique({ where: { id: account.id } }))?.openaiApiKey).toBe('sk-chave-restrita-111111');

    // Modelo inválido: a chave fica gravada, mas o 400 avisa.
    exigirModeloValidoMock.mockRejectedValueOnce(new ValidationError(mensagemDeModeloInvalido('gpt-9')));
    const ruim = await request(app)
      .put(`${ROTA}/conta/${account.id}/ia`)
      .set(authHeader(token))
      .send({ provider: 'openai', apiKey: 'sk-openai-outra-chave-999', model: 'gpt-9' });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error.message).toContain('A chave foi gravada, mas: Modelo "gpt-9" não existe');
    expect((await prismaTest.account.findUnique({ where: { id: account.id } }))?.openaiApiKey).toBe('sk-openai-outra-chave-999');

    // Chave mascarada, provider inválido, conta inexistente, admin comum.
    const mascarada = await request(app).put(`${ROTA}/conta/${account.id}/ia`).set(authHeader(token)).send({ provider: 'openai', apiKey: '••••1234' });
    expect(mascarada.status).toBe(400);
    expect(mascarada.body.error.message).toContain('apiKey veio mascarada');
    const provider = await request(app).put(`${ROTA}/conta/${account.id}/ia`).set(authHeader(token)).send({ provider: 'gemini', apiKey: 'x'.repeat(20) });
    expect(provider.status).toBe(400);
    expect(provider.body.error.message).toContain('provider precisa ser openai ou anthropic');
    expect((await request(app).get(`${ROTA}/conta/${randomUUID()}`).set(authHeader(token))).status).toBe(404);
    expect((await request(app).get(`${ROTA}/conta/nao-uuid`).set(authHeader(token))).status).toBe(400);
    expect((await request(app).get(`${ROTA}/conta/${account.id}`).set(authHeader(tokenAdmin))).status).toBe(403);
    expect((await request(app).put(`${ROTA}/conta/${account.id}/ia`).set(authHeader(tokenAdmin)).send({ provider: 'openai', apiKey: 'x'.repeat(20) })).status).toBe(403);
  });
});

describe('POST /agente/:id/simular (sombra, nada grava)', () => {
  it('uma conversa transfere por "humano", outra agenda via efeitos, o histórico acumula — e o banco fica limpo', async () => {
    const { token } = await superAdmin();
    const { account, carlos } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(criado.status).toBe(201);
    const agentId = criado.body.data.agentId as string;
    const produtoId = criado.body.data.productIds[0] as string;
    const horarioId = horarioValidoPara(carlos!.id, produtoId);

    chatMock.mockImplementation(async (req: { messages: { role: string; content: string }[] }) => {
      const ultima = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const jaRodouFerramenta = req.messages.some((m) => m.role === 'tool');
      if (jaRodouFerramenta) {
        return respostaChat(JSON.stringify({ mensagem_de_resposta: 'Marcado! Você recebe um lembrete.', rota: 'respondeu', resumo: 'agendou' }));
      }
      if (/humano/i.test(ultima)) {
        return respostaChat(JSON.stringify({ mensagem_de_resposta: '', rota: 'humano', resumo: 'pediu uma pessoa' }));
      }
      if (/confirmo/i.test(ultima)) {
        return respostaChat('', [{ id: 't1', name: 'agendar', arguments: { id: horarioId } }]);
      }
      return respostaChat(JSON.stringify({ mensagem_de_resposta: `entendi: ${ultima}`, rota: 'respondeu', resumo: 'em andamento' }));
    });

    const res = await request(app)
      .post(`${ROTA}/agente/${agentId}/simular`)
      .set(authHeader(token))
      .send({
        conversas: [
          { nome: 'Pede humano', mensagens: ['oi', 'quero falar com humano', 'isto nunca roda'] },
          { nome: 'Agenda', mensagens: ['quero marcar consulta', 'sim, confirmo'] },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const { resumo, conversas } = res.body.data;
    expect(resumo).toMatchObject({ conversas: 2, transferidas: 1, agendadas: 1, comErro: 0 });
    expect(resumo.tokens).toBeGreaterThan(0);

    const humano = conversas[0];
    expect(humano.transferiu).toBe(true);
    expect(humano.turnos).toHaveLength(2); // parou na transferência
    expect(humano.turnos[0]).toMatchObject({ lead: 'oi', resposta: 'entendi: oi', rota: 'respondeu', toolCalls: [] });
    expect(humano.turnos[1]).toMatchObject({ lead: 'quero falar com humano', resposta: null, rota: 'humano', resumo: 'pediu uma pessoa' });

    const agenda = conversas[1];
    expect(agenda.agendou).toBe(true);
    // ETAPA G — o relatório traz os argumentos e o resultado de cada ferramenta.
    expect(agenda.turnos[1].toolCalls).toEqual([
      { nome: 'agendar', argumentos: { id: horarioId }, resultadoResumo: expect.stringContaining('Marcado:') },
    ]);
    expect(agenda.turnos[1].efeitos.agendou).toMatchObject({ simulado: true, servico: 'Consulta clínica', profissional: 'Dr. Carlos' });
    expect(agenda.turnos[1].resposta).toBe('Marcado! Você recebe um lembrete.');

    // O histórico da própria conversa simulada chega ao modelo no turno seguinte.
    const chamadaDoSegundoTurno = chatMock.mock.calls
      .map((c) => c[0] as { messages: { role: string; content: string }[]; system: string })
      .find((c) => c.messages.at(-1)?.content === 'quero falar com humano');
    expect(chamadaDoSegundoTurno?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'oi'],
      ['assistant', 'entendi: oi'],
      ['user', 'quero falar com humano'],
    ]);
    expect(chamadaDoSegundoTurno?.system).toContain('nome: Pede humano');

    // NADA foi gravado.
    expect(await prismaTest.conversation.count()).toBe(0);
    expect(await prismaTest.message.count()).toBe(0);
    expect(await prismaTest.calendarEvent.count()).toBe(0);
    expect(await prismaTest.flowRun.count()).toBe(0);
  });

  it('[G1] duas conversas reservam o MESMO horário e confirmam SEM id no turno seguinte: as duas agendam, em sequência, e calendar_events = 0', async () => {
    const { token } = await superAdmin();
    const { account, carlos } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_CLINICA });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const agentId = criado.body.data.agentId as string;
    const horarioId = horarioValidoPara(carlos!.id, criado.body.data.productIds[0] as string);

    chatMock.mockImplementation(async (req: { messages: { role: string; content: string }[] }) => {
      const ultima = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const ultimaFerramenta = [...req.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
      if (ultimaFerramenta.startsWith('Reservado')) {
        return respostaChat(JSON.stringify({ mensagem_de_resposta: 'Reservei. Confirma?', rota: 'respondeu', resumo: 'reservou' }));
      }
      if (ultimaFerramenta.startsWith('Marcado')) {
        return respostaChat(JSON.stringify({ mensagem_de_resposta: 'Marcado!', rota: 'respondeu', resumo: 'agendou' }));
      }
      if (/confirmo/i.test(ultima)) return respostaChat('', [{ id: 't2', name: 'agendar', arguments: {} }]);
      return respostaChat('', [{ id: 't1', name: 'reservar', arguments: { horario_id: horarioId } }]);
    });

    const res = await request(app)
      .post(`${ROTA}/agente/${agentId}/simular`)
      .set(authHeader(token))
      .send({
        conversas: [
          { nome: 'Conversa A', mensagens: ['quero marcar', 'sim, confirmo'] },
          { nome: 'Conversa B', mensagens: ['quero marcar', 'sim, confirmo'] },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { resumo, conversas } = res.body.data;
    expect(resumo).toMatchObject({ conversas: 2, agendadas: 2, comErro: 0 });

    for (const c of conversas) {
      expect(c.agendou).toBe(true);
      expect(c.turnos[0].toolCalls).toEqual([{ nome: 'reservar', argumentos: { horario_id: horarioId }, resultadoResumo: expect.stringContaining('Reservado por') }]);
      expect(c.turnos[1].toolCalls).toEqual([{ nome: 'agendar', argumentos: {}, resultadoResumo: expect.stringContaining('Marcado:') }]);
      expect(c.turnos[1].efeitos.agendou).toMatchObject({ simulado: true, profissional: 'Dr. Carlos' });
    }

    // No turno do "confirmo", o prompt lembrava a reserva — sem o modelo carregar a ref.
    // (O run muta o mesmo array `messages` entre as rodadas de ferramenta, então o
    // turno é identificado pela mensagem do lead em qualquer posição, não pela última.)
    const chamadas = chatMock.mock.calls.map((c) => c[0] as { system: string; messages: { role: string; content: string }[] });
    const confirmoDaA = chamadas.find(
      (c) => c.system.includes('nome: Conversa A') && c.messages.some((m) => m.role === 'user' && m.content === 'sim, confirmo')
    );
    expect(confirmoDaA?.system).toContain('RESERVA PENDENTE nesta conversa');
    expect(confirmoDaA?.system).toContain('chame agendar (sem id)');

    // Sequencial: toda chamada da A vem antes de qualquer chamada da B.
    const ultimaDaA = chamadas.map((c, i) => (c.system.includes('nome: Conversa A') ? i : -1)).filter((i) => i >= 0).pop()!;
    const primeiraDaB = chamadas.findIndex((c) => c.system.includes('nome: Conversa B'));
    expect(ultimaDaA).toBeLessThan(primeiraDaB);

    // Nada no banco: nem held, nem scheduled.
    expect(await prismaTest.calendarEvent.count()).toBe(0);
  });

  it('erro de um turno não derruba o lote; limites do corpo em português', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_MINIMO });
    const agentId = criado.body.data.agentId as string;

    chatMock.mockImplementation(async (req: { messages: { role: string; content: string }[] }) => {
      const ultima = req.messages.at(-1)?.content ?? '';
      if (ultima === 'quebra') throw new Error('provider caiu');
      return respostaChat(JSON.stringify({ mensagem_de_resposta: 'ok', rota: 'respondeu' }));
    });

    const res = await request(app)
      .post(`${ROTA}/agente/${agentId}/simular`)
      .set(authHeader(token))
      .send({ conversas: [{ nome: 'Quebra', mensagens: ['quebra', 'nunca'] }, { nome: 'Normal', mensagens: ['oi'] }], maxTurnos: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.resumo).toMatchObject({ conversas: 2, comErro: 1 });
    expect(res.body.data.conversas[0]).toMatchObject({ erro: 'provider caiu', transferiu: false });
    expect(res.body.data.conversas[0].turnos[0].erro).toBe('provider caiu');
    expect(res.body.data.conversas[1].turnos).toHaveLength(1);

    const demais = await request(app)
      .post(`${ROTA}/agente/${agentId}/simular`)
      .set(authHeader(token))
      .send({ conversas: Array.from({ length: 31 }, (_, i) => ({ nome: `c${i}`, mensagens: ['oi'] })) });
    expect(demais.status).toBe(400);
    expect(demais.body.error.message).toContain('no máximo 30 conversas por lote');
  });

  it('[qa-P] conta sem chave de IA: 409 IA_SEM_CHAVE em vez de 200 com todas as conversas em erro', async () => {
    const { token } = await superAdmin();
    const { account } = await contaCliente();
    const criado = await request(app).post(`${ROTA}/agente`).set(authHeader(token)).send({ accountId: account.id, spec: SPEC_MINIMO });
    const agentId = criado.body.data.agentId as string;
    await prisma.account.update({ where: { id: account.id }, data: { openaiApiKey: null } });
    __clearKeyCache();

    const res = await request(app)
      .post(`${ROTA}/agente/${agentId}/simular`)
      .set(authHeader(token))
      .send({ conversas: [{ nome: 'x', mensagens: ['oi'] }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IA_SEM_CHAVE');
  });
});

describe('GET /conversas-teste/:segmento', () => {
  it('devolve a bateria fixa (12 por segmento) e recusa segmento desconhecido', async () => {
    const { token } = await superAdmin();
    for (const seg of ['clinica', 'estetica', 'academia', 'servicos', 'outro']) {
      const res = await request(app).get(`${ROTA}/conversas-teste/${seg}`).set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(12);
      expect(res.body.data.every((c: { mensagens: string[] }) => c.mensagens.length >= 1 && c.mensagens.length <= 12)).toBe(true);
    }
    const ruim = await request(app).get(`${ROTA}/conversas-teste/padaria`).set(authHeader(token));
    expect(ruim.status).toBe(400);
    expect(ruim.body.error.message).toContain('Segmento inválido');
  });
});
