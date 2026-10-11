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

import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { prisma } from '../config/database';
import { criarEtapasFixas } from './tag.service';
import { codificarHorario } from './agenda.service';
import { __clearKeyCache } from './ai/client-factory';
import { SPEC_CLINICA, SPEC_MINIMO } from './provisionar/fixtures.test-util';
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

    // Agente.
    const agente = await prismaTest.aiAgent.findUnique({ where: { id: d.agentId } });
    expect(agente).toMatchObject({ name: 'Bia', role: 'responder', provider: 'openai', knowledgeBaseId: d.knowledgeBaseId, specVersao: 1 });
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
    expect(agenda.turnos[1].toolCalls).toEqual(['agendar']);
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
