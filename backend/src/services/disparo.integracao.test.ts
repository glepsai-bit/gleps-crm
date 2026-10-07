/**
 * ETAPA D — integração do motor de disparos contra o Postgres de verdade.
 *
 * Os testes de regras (disparo.regras.test.ts) provam a lógica com relógio
 * fixo; este prova que a fila no banco funciona: criar → worker faz claim
 * (SKIP LOCKED) → envia pela Evolution mockada → conversa no Chat com
 * disparoId → ack sobe o status → resposta inbound marca 'respondeu' →
 * concluído. Mais: 5 falhas de número redistribuem ou pausam, infra
 * reagenda, agendado é promovido na hora, opt-out é pulado já na lista.
 *
 * Só o mundo externo é mockado: Evolution e o aquecimento (capacidade).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type EntradaDeEnvio = { number: string; text?: string; instance?: string | null };
type Capacidade = { status: string; dia: number; limiteDiario: number; restantesHoje: number };

const evolutionMock = vi.hoisted(() => {
  let n = 0;
  const padrao = {
    sendText: async (_acc: string, _input: EntradaDeEnvio) => ({ messageId: `evo-${++n}`, raw: {} }),
    getStatus: async (_acc: string, _instance?: string | null) => ({ state: 'open', raw: {} }),
    sendMedia: async (_acc: string, _input: unknown) => ({ messageId: `media-${++n}`, raw: {} }),
    sendWhatsAppAudio: async (_acc: string, _input: unknown) => ({ messageId: `audio-${++n}`, raw: {} }),
  };
  return {
    padrao,
    sendText: vi.fn(padrao.sendText),
    getStatus: vi.fn(padrao.getStatus),
    sendMedia: vi.fn(padrao.sendMedia),
    sendWhatsAppAudio: vi.fn(padrao.sendWhatsAppAudio),
    getConnectedNumber: vi.fn(async () => null),
  };
});
vi.mock('./evolution.service', () => ({ evolutionService: evolutionMock }));

const aquecimentoMock = vi.hoisted(() => {
  const capacidadePadrao = async (_acc: string, _inboxId: string): Promise<Capacidade> => ({
    status: 'pronto',
    dia: 31,
    limiteDiario: 200,
    restantesHoje: 200,
  });
  return {
    capacidadePadrao,
    capacidadeDoNumero: vi.fn(capacidadePadrao),
    registrarEnvioExterno: vi.fn(async (_acc: string, _inboxId: string, _qtd?: number) => undefined),
  };
});
vi.mock('./aquecimento.service', () => ({ aquecimentoService: aquecimentoMock }));

import { prisma } from '../config/database';
import { disparoService } from './disparo.service';
import { rodadaDeDisparos, __definirEspera, __limparCacheDeInbox } from './disparo.worker';

/** Mesma tolerância documentada em flow.integracao.test.ts (dois PrismaClient, TRUNCATE entre casos). */
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

async function montarConta(inboxes: Array<{ nome: string; instance: string }> = [{ nome: 'Comercial', instance: 'inst-a' }]) {
  const account = await comRetry(() => prisma.account.create({ data: { nome: 'Clínica Teste', timezone: 'America/Sao_Paulo' } }));
  const criadas = [];
  for (const i of inboxes) {
    criadas.push(
      await comRetry(() =>
        prisma.inbox.create({
          data: { accountId: account.id, name: i.nome, channelType: 'whatsapp', evolutionInstance: i.instance, active: true },
        })
      )
    );
  }
  return { account, inboxes: criadas };
}

const LINHAS = ['Maria da Silva;11 98765-4321', 'João;+55 21 99876-5432', '5531988887777'];

/**
 * Vence os pendentes do disparo (simula o tempo passando), preservando a
 * ordem relativa — cada um fica 1 s antes do seguinte.
 */
async function vencerPendentes(disparoId: string, apenasInboxId?: string, quantos?: number) {
  const where = { disparoId, status: 'pendente', ...(apenasInboxId ? { inboxId: apenasInboxId } : {}) };
  const alvo = await prisma.disparoEnvio.findMany({ where, orderBy: { naoAntesDe: 'asc' }, select: { id: true }, ...(quantos ? { take: quantos } : {}) });
  const base = Date.now() - (alvo.length + 1) * 1000;
  for (let i = 0; i < alvo.length; i++) {
    await prisma.disparoEnvio.update({ where: { id: alvo[i].id }, data: { naoAntesDe: new Date(base + i * 1000) } });
  }
  return alvo.length;
}

beforeEach(() => {
  // clearAllMocks limpa chamadas, não implementações: o teste anterior pode
  // ter deixado sendText rejeitando. Volta tudo pro padrão.
  vi.clearAllMocks();
  __limparCacheDeInbox();
  __definirEspera(async () => undefined);
  evolutionMock.sendText.mockImplementation(evolutionMock.padrao.sendText);
  evolutionMock.getStatus.mockImplementation(evolutionMock.padrao.getStatus);
  evolutionMock.sendMedia.mockImplementation(evolutionMock.padrao.sendMedia);
  evolutionMock.sendWhatsAppAudio.mockImplementation(evolutionMock.padrao.sendWhatsAppAudio);
  aquecimentoMock.capacidadeDoNumero.mockImplementation(aquecimentoMock.capacidadePadrao);
});

describe('criar "agora" com números colados', () => {
  it('envios nascem pendentes, escalonados 20–60 s, com telefone normalizado e variáveis', async () => {
    const { account, inboxes } = await montarConta();
    const d = await disparoService.criar(account.id, null, {
      nome: 'Boas-vindas',
      texto: 'Oi {{primeiro_nome}}, tudo bem?',
      lista: { tipo: 'numeros', linhas: LINHAS },
      inboxIds: [inboxes[0].id],
    });
    expect(d.status).toBe('enviando');
    expect(d.total).toBe(3);
    expect(d.listaRotulo).toBe('Números colados');
    expect(d.inboxNomes).toEqual(['Comercial']);
    expect(d.previsaoTerminoEm).not.toBeNull();

    const envios = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id }, orderBy: { naoAntesDe: 'asc' } });
    expect(envios.map((e) => e.status)).toEqual(['pendente', 'pendente', 'pendente']);
    expect(envios.map((e) => e.telefone).sort()).toEqual(['5511987654321', '5521998765432', '5531988887777']);
    const maria = envios.find((e) => e.telefone === '5511987654321')!;
    expect(maria.nome).toBe('Maria da Silva');
    expect(maria.variaveis).toMatchObject({ nome: 'Maria da Silva', primeiro_nome: 'Maria' });

    for (let i = 1; i < envios.length; i++) {
      const gap = (envios[i].naoAntesDe.getTime() - envios[i - 1].naoAntesDe.getTime()) / 1000;
      // 20–60 s, ou a virada da janela (20h → 08h do dia seguinte).
      expect(gap >= 20 && gap <= 60 ? true : gap >= 12 * 3600).toBe(true);
    }
  });

  it('opt-out, repetido e inválido ficam de fora já no preview e viram envios pulados', async () => {
    const { account, inboxes } = await montarConta();
    await prisma.whatsappConsent.create({ data: { accountId: account.id, phone: '5531988887777', status: 'opted_out', source: 'auto_keyword' } });
    const lista = { tipo: 'numeros' as const, linhas: [...LINHAS, '(11) 98765-4321', 'Fulano;1133334444', 'abc'] };

    const preview = await disparoService.previewLista(account.id, lista);
    expect(preview).toEqual({ total: 6, vaoReceber: 2, optout: 1, duplicados: 1, invalidos: 2 });

    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista, inboxIds: [inboxes[0].id] });
    expect(d.total).toBe(2);
    expect(d.optout).toBe(1);
    expect(d.pulados).toBe(3);
    const porStatus = await prisma.disparoEnvio.groupBy({ by: ['status'], where: { disparoId: d.id }, _count: true });
    const mapa = Object.fromEntries(porStatus.map((p) => [p.status, p._count]));
    expect(mapa).toEqual({ pendente: 2, pulado_optout: 1, pulado_duplicado: 1, pulado_invalido: 2 });
  });

  it('ninguém válido → 400 com o resumo', async () => {
    const { account, inboxes } = await montarConta();
    await expect(
      disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas: ['abc', ''] }, inboxIds: [inboxes[0].id] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('worker: claim → envia → conversa no Chat → ack → resposta → concluído', () => {
  it('ciclo completo', async () => {
    const { account, inboxes } = await montarConta();
    const d = await disparoService.criar(account.id, null, {
      nome: 'Retorno',
      texto: 'Oi {{primeiro_nome}}, voltamos a falar?',
      variantes: ['E aí {{primeiro_nome}}, bora retomar?'],
      lista: { tipo: 'numeros', linhas: LINHAS },
      inboxIds: [inboxes[0].id],
    });

    // Nada venceu ainda (o primeiro sai "agora", mas os outros têm 20–60 s).
    // Vence tudo e roda uma rodada.
    await vencerPendentes(d.id);
    const r = await rodadaDeDisparos();
    expect(r.bloqueada).toBe(false);
    expect(r.claimados).toBe(3);
    expect(r.enviados).toBe(3);
    expect(r.concluidos).toBe(1);
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(3);
    expect(evolutionMock.sendText).toHaveBeenCalledWith(account.id, expect.objectContaining({ instance: 'inst-a', number: '5511987654321' }));
    expect(aquecimentoMock.registrarEnvioExterno).toHaveBeenCalledTimes(3);

    const envios = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id }, orderBy: { naoAntesDe: 'asc' } });
    expect(envios.every((e) => e.status === 'enviada' && e.evolutionMsgId && e.conversationId && e.enviadoEm)).toBe(true);
    // Variantes alternadas: 0, 1, 0.
    expect(envios.map((e) => e.variante)).toEqual([0, 1, 0]);

    const disparo = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(disparo.status).toBe('concluido');
    expect(disparo.enviadas).toBe(3);
    expect(disparo.concluidoEm).not.toBeNull();

    // Conversa no Chat ligada ao disparo, com a mensagem renderizada.
    const maria = envios.find((e) => e.telefone === '5511987654321')!;
    const conversa = await prisma.conversation.findUniqueOrThrow({ where: { id: maria.conversationId! }, include: { messages: true } });
    expect(conversa.disparoId).toBe(d.id);
    expect(conversa.externalId).toBe('5511987654321@s.whatsapp.net');
    expect(conversa.inboxId).toBe(inboxes[0].id);
    expect(conversa.messages[0].content).toBe('Oi Maria, voltamos a falar?');
    expect(conversa.messages[0].senderType).toBe('agent');
    expect(conversa.messages[0].externalId).toBe(maria.evolutionMsgId);
    // "Quem atende" = agente: a flag de humano NÃO é marcada.
    expect(((conversa.customAttributes as Record<string, unknown>) ?? {}).human_active).toBeUndefined();

    // Contexto pro agente de IA.
    const contexto = await disparoService.contextoParaAgente(maria.conversationId!);
    expect(contexto).toContain("disparo 'Retorno'");
    expect(contexto).toContain('«Oi Maria, voltamos a falar?»');

    // Ack só sobe: enviada → entregue → lida; 'entregue' depois de 'lida' não desce.
    expect(await disparoService.atualizarStatusPorMsgId(maria.evolutionMsgId!, 'entregue')).toBe(1);
    expect(await disparoService.atualizarStatusPorMsgId(maria.evolutionMsgId!, 'lida')).toBe(1);
    expect(await disparoService.atualizarStatusPorMsgId(maria.evolutionMsgId!, 'entregue')).toBe(0);
    expect((await prisma.disparoEnvio.findUniqueOrThrow({ where: { id: maria.id } })).status).toBe('lida');

    // Resposta inbound: 'respondeu' uma vez só.
    expect(await disparoService.registrarRespostaDeDisparo(maria.conversationId!)).toBe(1);
    expect(await disparoService.registrarRespostaDeDisparo(maria.conversationId!)).toBe(0);
    const depois = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(depois.respondidas).toBe(1);

    // Lista: foi pro bloco de concluídos com as contagens.
    const lista = await disparoService.listar(account.id);
    expect(lista.emAndamento).toHaveLength(0);
    expect(lista.concluidos[0]).toMatchObject({ id: d.id, respondidas: 1, enviadas: 3, status: 'concluido' });

    // Reenvio pra quem não respondeu: 2 contatos, mesmo texto.
    const reenvio = await disparoService.reenviarNaoRespondidos(account.id, d.id, null);
    expect(reenvio.nome).toBe('Retorno · reenvio');
    expect(reenvio.total).toBe(2);
    expect(reenvio.texto).toBe(d.texto);
    expect(reenvio.listaRotulo).toBe('Reenvio de "Retorno"');

    // Detalhe paginado com nome do número.
    const det = await disparoService.detalhe(account.id, d.id, 1, 'respondeu');
    expect(det.paginacao).toEqual({ page: 1, totalPaginas: 1, total: 1 });
    expect(det.envios[0]).toMatchObject({ telefone: '5511987654321', inboxNome: 'Comercial', status: 'respondeu' });
  });

  it('"fila humana" marca human_active na conversa (a IA não responde)', async () => {
    const { account, inboxes } = await montarConta();
    const d = await disparoService.criar(account.id, null, {
      texto: 'oi',
      lista: { tipo: 'numeros', linhas: ['5511987654321'] },
      inboxIds: [inboxes[0].id],
      atendeRespostas: 'humano',
    });
    await vencerPendentes(d.id);
    await rodadaDeDisparos();
    const envio = await prisma.disparoEnvio.findFirstOrThrow({ where: { disparoId: d.id } });
    const conversa = await prisma.conversation.findUniqueOrThrow({ where: { id: envio.conversationId! } });
    expect((conversa.customAttributes as Record<string, unknown>).human_active).toBe(true);
    expect(disparoService.atendimentoHumano(conversa)).toBe(true);
  });

  it('anexo vai como segunda mensagem (imagem) depois do texto', async () => {
    const { account, inboxes } = await montarConta();
    // Grava um PNG mínimo na pasta da conta, do jeito que o upload faria.
    const { disparoAnexoService } = await import('./disparo-anexo.service');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const anexo = await disparoAnexoService.salvar(account.id, { buffer: png, mimetype: 'image/png', originalname: 'oferta.png', size: png.length });
    expect(anexo.id.startsWith(`disparos/${account.id}/`)).toBe(true);

    const d = await disparoService.criar(account.id, null, {
      texto: 'olha isso',
      anexo: { id: anexo.id, tipo: anexo.tipo, nome: anexo.nome, mime: anexo.mime, tamanho: anexo.tamanho },
      lista: { tipo: 'numeros', linhas: ['5511987654321'] },
      inboxIds: [inboxes[0].id],
    });
    await vencerPendentes(d.id);
    await rodadaDeDisparos();
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);
    expect(evolutionMock.sendMedia).toHaveBeenCalledTimes(1);
    expect(evolutionMock.sendMedia).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ mediaType: 'image', mediaUrl: expect.stringMatching(/^data:image\/png;base64,/) })
    );
    await disparoAnexoService.remover(anexo.id);
  });

  it('anexo de outra conta é recusado', async () => {
    const { account, inboxes } = await montarConta();
    await expect(
      disparoService.criar(account.id, null, {
        texto: 'oi',
        anexo: { id: 'disparos/outra-conta/x.png', tipo: 'imagem', nome: 'x.png', mime: 'image/png', tamanho: 10 },
        lista: { tipo: 'numeros', linhas: ['5511987654321'] },
        inboxIds: [inboxes[0].id],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('falhas', () => {
  it('infra (5xx) reagenda +5 min sem contar falha; o resto do número espera', async () => {
    const { account, inboxes } = await montarConta();
    evolutionMock.sendText.mockRejectedValue(new Error('Evolution API retornou status 503'));
    const d = await disparoService.criar(account.id, null, {
      texto: 'oi',
      lista: { tipo: 'numeros', linhas: LINHAS },
      inboxIds: [inboxes[0].id],
    });
    await vencerPendentes(d.id);
    const r = await rodadaDeDisparos();
    expect(r.reagendados).toBe(3);
    expect(r.falhas).toBe(0);
    // Só tentou uma vez: depois do 1º erro de infra, os outros do mesmo número não batem na Evolution.
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);

    const envios = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id } });
    for (const e of envios) {
      expect(e.status).toBe('pendente');
      expect(e.naoAntesDe.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      expect(e.erro).toMatch(/5 min/);
    }
    const disparo = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(disparo.status).toBe('enviando');
    expect(disparo.falhas).toBe(0);
  });

  it('número desconectado (getStatus != open) também é infra', async () => {
    const { account, inboxes } = await montarConta();
    evolutionMock.getStatus.mockResolvedValue({ state: 'close', raw: {} });
    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas: LINHAS }, inboxIds: [inboxes[0].id] });
    await vencerPendentes(d.id);
    const r = await rodadaDeDisparos();
    expect(r.reagendados).toBe(3);
    expect(evolutionMock.sendText).not.toHaveBeenCalled();
  });

  it('5 falhas seguidas de número com um só número → disparo pausado com motivo', async () => {
    const { account, inboxes } = await montarConta();
    evolutionMock.sendText.mockRejectedValue(new Error('Evolution API retornou status 400'));
    const linhas = Array.from({ length: 7 }, (_, i) => `55119876543${String(i).padStart(2, '0')}`);
    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas }, inboxIds: [inboxes[0].id] });
    await vencerPendentes(d.id);
    const r = await rodadaDeDisparos();
    expect(r.falhas).toBe(5);

    const disparo = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(disparo.status).toBe('pausado');
    expect(disparo.pausadoMotivo).toBe('5 falhas seguidas no número Comercial');
    expect(disparo.falhas).toBe(5);
    // Os 2 que sobraram voltaram pra pendente (não foram tentados).
    const porStatus = await prisma.disparoEnvio.groupBy({ by: ['status'], where: { disparoId: d.id }, _count: true });
    expect(Object.fromEntries(porStatus.map((p) => [p.status, p._count]))).toEqual({ falhou: 5, pendente: 2 });

    // Retomar zera as falhas seguidas e reprograma os pendentes a partir de agora.
    const retomado = await disparoService.retomar(account.id, d.id);
    expect(retomado.status).toBe('enviando');
    expect((await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } })).falhasSeguidas).toEqual({});
  });

  it('5 falhas seguidas num número com outro disponível → pendentes vão pro outro número', async () => {
    const { account, inboxes } = await montarConta([
      { nome: 'A', instance: 'inst-a' },
      { nome: 'B', instance: 'inst-b' },
    ]);
    const [a, b] = inboxes;
    // A tem 3x a capacidade de B → de 12 contatos, 9 vão por A e 3 por B.
    aquecimentoMock.capacidadeDoNumero.mockImplementation(async (_acc: string, inboxId: string) => ({
      status: 'pronto',
      dia: 31,
      limiteDiario: 200,
      restantesHoje: inboxId === a.id ? 150 : 50,
    }));
    evolutionMock.sendText.mockImplementation(async (_acc: string, input: EntradaDeEnvio) => {
      if (input.instance === 'inst-a') throw new Error('Evolution API retornou status 400');
      return { messageId: `evo-b-${Math.random()}`, raw: {} };
    });
    const linhas = Array.from({ length: 12 }, (_, i) => `55119876540${String(i).padStart(2, '0')}`);
    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas }, inboxIds: [a.id, b.id] });
    const porInbox = await prisma.disparoEnvio.groupBy({ by: ['inboxId'], where: { disparoId: d.id }, _count: true });
    expect(Object.fromEntries(porInbox.map((p) => [p.inboxId, p._count]))).toEqual({ [a.id]: 9, [b.id]: 3 });

    // Vencem 5 de A e os 3 de B; os outros 4 de A continuam no futuro.
    expect(await vencerPendentes(d.id, a.id, 5)).toBe(5);
    await vencerPendentes(d.id, b.id);
    const r = await rodadaDeDisparos();
    expect(r.falhas).toBe(5);
    expect(r.enviados).toBe(3);

    const depois = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id } });
    const deA = depois.filter((e) => e.inboxId === a.id);
    const deB = depois.filter((e) => e.inboxId === b.id);
    expect(deA.map((e) => e.status).sort()).toEqual(['falhou', 'falhou', 'falhou', 'falhou', 'falhou']);
    expect(deB.filter((e) => e.status === 'enviada')).toHaveLength(3);
    // Os 4 pendentes de A foram pra B.
    expect(deB.filter((e) => e.status === 'pendente')).toHaveLength(4);
    expect((await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('enviando');

    // Próxima rodada: B manda os 4 e o disparo conclui.
    await vencerPendentes(d.id);
    const r2 = await rodadaDeDisparos();
    expect(r2.enviados).toBe(4);
    expect(r2.concluidos).toBe(1);
    const fim = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(fim).toMatchObject({ status: 'concluido', enviadas: 7, falhas: 5 });
  });
});

describe('agendar, pausar, cancelar', () => {
  it('agendado nasce "agendado" e o worker promove quando chega a hora', async () => {
    const { account, inboxes } = await montarConta();
    const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const d = await disparoService.criar(account.id, null, {
      texto: 'oi',
      lista: { tipo: 'numeros', linhas: LINHAS },
      inboxIds: [inboxes[0].id],
      agendadoPara: amanha.toISOString(),
    });
    expect(d.status).toBe('agendado');
    expect(d.agendadoPara).toBe(amanha.toISOString());
    expect(d.iniciadoEm).toBeNull();
    const envios = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id } });
    expect(envios.every((e) => e.naoAntesDe.getTime() >= amanha.getTime() - 1000)).toBe(true);

    // Ainda não é hora: nada é pego, mesmo com envios "vencidos".
    await vencerPendentes(d.id);
    expect((await rodadaDeDisparos()).claimados).toBe(0);

    // Chegou a hora.
    await prisma.disparo.update({ where: { id: d.id }, data: { agendadoPara: new Date(Date.now() - 1000) } });
    const r = await rodadaDeDisparos();
    expect(r.claimados).toBe(3);
    expect(r.enviados).toBe(3);
    const fim = await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } });
    expect(fim.status).toBe('concluido');
    expect(fim.iniciadoEm).not.toBeNull();
    const lista = await disparoService.listar(account.id);
    expect(lista.concluidos.map((x) => x.id)).toContain(d.id);
  });

  it('pausar segura o worker; cancelar derruba os pendentes', async () => {
    const { account, inboxes } = await montarConta();
    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas: LINHAS }, inboxIds: [inboxes[0].id] });
    expect((await disparoService.pausar(account.id, d.id)).status).toBe('pausado');
    await vencerPendentes(d.id);
    expect((await rodadaDeDisparos()).claimados).toBe(0);

    const lista = await disparoService.listar(account.id);
    expect(lista.emAndamento[0]).toMatchObject({ id: d.id, status: 'pausado', pausadoMotivo: 'Pausado por você' });

    const cancelado = await disparoService.cancelar(account.id, d.id);
    expect(cancelado.status).toBe('cancelado');
    const envios = await prisma.disparoEnvio.findMany({ where: { disparoId: d.id } });
    expect(envios.every((e) => e.status === 'cancelado')).toBe(true);
    await expect(disparoService.cancelar(account.id, d.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('outra conta não enxerga nem mexe', async () => {
    const { account, inboxes } = await montarConta();
    const outra = await comRetry(() => prisma.account.create({ data: { nome: 'Outra' } }));
    const d = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas: LINHAS }, inboxIds: [inboxes[0].id] });
    await expect(disparoService.pausar(outra.id, d.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(disparoService.detalhe(outra.id, d.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await disparoService.listar(outra.id)).emAndamento).toHaveLength(0);
    // Inbox de outra conta no inboxIds → 400.
    await expect(
      disparoService.criar(outra.id, null, { texto: 'oi', lista: { tipo: 'numeros', linhas: LINHAS }, inboxIds: [inboxes[0].id] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('listas de público e de leads, e números disponíveis', () => {
  it('público salvo → leads com telefone; leads do CRM por etapa/tag', async () => {
    const { account, inboxes } = await montarConta();
    const audience = await comRetry(() => prisma.prospectingAudience.create({ data: { accountId: account.id, name: 'Pacientes sem retorno' } }));
    await prisma.prospectingAudienceLead.createMany({
      data: [
        { audienceId: audience.id, name: 'Clínica A', phone: '(11) 98888-7777' },
        { audienceId: audience.id, name: 'Clínica B', phone: null },
      ],
    });
    const pv = await disparoService.previewLista(account.id, { tipo: 'publico', audienceId: audience.id });
    expect(pv).toEqual({ total: 2, vaoReceber: 1, optout: 0, duplicados: 0, invalidos: 1 });
    const d = await disparoService.criar(account.id, null, { texto: 'oi {{empresa}}', lista: { tipo: 'publico', audienceId: audience.id }, inboxIds: [inboxes[0].id] });
    expect(d.listaRotulo).toBe('Público "Pacientes sem retorno"');

    const funil = await comRetry(() => prisma.funnel.create({ data: { accountId: account.id, name: 'Padrão', slug: 'padrao' } }));
    const etapa = await comRetry(() => prisma.tag.create({ data: { accountId: account.id, funnelId: funil.id, name: 'Em negociação', slug: 'em-negociacao', type: 'stage' } }));
    const c1 = await comRetry(() => prisma.contact.create({ data: { accountId: account.id, nome: 'Ana', telefone: '11977776666', customAttributes: { empresa: 'Padaria' } } }));
    await comRetry(() => prisma.contact.create({ data: { accountId: account.id, nome: 'Beto', telefone: '11966665555' } }));
    await prisma.leadTag.create({ data: { contactId: c1.id, tagId: etapa.id, appliedByType: 'user', source: 'kanban' } });

    const todos = await disparoService.previewLista(account.id, { tipo: 'leads' });
    expect(todos.vaoReceber).toBe(2);
    const naEtapa = await disparoService.criar(account.id, null, { texto: 'oi', lista: { tipo: 'leads', etapaTagId: etapa.id }, inboxIds: [inboxes[0].id] });
    expect(naEtapa.total).toBe(1);
    expect(naEtapa.listaRotulo).toBe('Leads em "Em negociação"');
    const envio = await prisma.disparoEnvio.findFirstOrThrow({ where: { disparoId: naEtapa.id } });
    expect(envio.contactId).toBe(c1.id);
    expect(envio.variaveis).toMatchObject({ nome: 'Ana', empresa: 'Padaria' });
  });

  it('numerosDisponiveis traz capacidade, conexão, agente do fluxo e opt-outs', async () => {
    const { account, inboxes } = await montarConta([
      { nome: 'A', instance: 'inst-a' },
      { nome: 'B', instance: 'inst-b' },
    ]);
    await prisma.inbox.update({ where: { id: inboxes[1].id }, data: { active: false } });
    await prisma.whatsappConsent.create({ data: { accountId: account.id, phone: '5511999990000', status: 'opted_out', source: 'manual' } });
    const agente = await comRetry(() => prisma.aiAgent.create({ data: { accountId: account.id, name: 'Sofia', systemPrompt: 'x' } }));
    await comRetry(() =>
      prisma.flow.create({
        data: {
          accountId: account.id,
          name: 'Atendimento',
          status: 'active',
          inboxIds: [inboxes[0].id],
          graph: { nodes: [{ id: 'n1', type: 'ai.atender', config: { agentId: agente.id } }], edges: [] },
        },
      })
    );
    aquecimentoMock.capacidadeDoNumero.mockImplementation(async (_acc: string, inboxId: string) =>
      inboxId === inboxes[0].id
        ? { status: 'aquecendo', dia: 5, limiteDiario: 25, restantesHoje: 20 }
        : { status: 'nao_aquecido', dia: 0, limiteDiario: 50, restantesHoje: 50 }
    );

    const r = await disparoService.numerosDisponiveis(account.id, 100);
    expect(r.optouts).toBe(1);
    expect(r.numeros).toHaveLength(2);
    expect(r.numeros[0]).toMatchObject({ inboxNome: 'A', conectado: true, status: 'aquecendo', dia: 5, limiteDiario: 25, restantesHoje: 20, agenteNome: 'Sofia' });
    expect(r.numeros[1]).toMatchObject({ inboxNome: 'B', conectado: false, status: 'nao_aquecido', agenteNome: null });
    expect(r.estimativa).toEqual({ contatos: 100, dias: 2 }); // 70 hoje + 75/dia
  });
});
