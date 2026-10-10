/**
 * ETAPA E — palavras-chave de consentimento (unit, sem banco).
 *
 * `detectarPalavraChaveDeConsentimento` é pura: aqui provamos o regex de
 * sair/voltar (palavra isolada só em mensagem curta, frase em qualquer
 * tamanho, acentos, bordas). `processarPalavraChave` roda com o Prisma
 * mockado: SAIR grava e diz que mudou; SAIR de novo não muda; VOLTAR só
 * reverte quem estava fora; "quero receber" de quem nunca saiu não é
 * palavra-chave.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  whatsappConsent: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
  },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('./event.service', () => ({ eventService: { create: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./webhook-outbound.service', () => ({
  webhookOutboundService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

import {
  whatsappConsentService,
  detectarPalavraChaveDeConsentimento as detectar,
  MENSAGEM_DE_OPT_IN,
  MENSAGEM_DE_OPT_OUT,
} from './whatsapp-consent.service';

describe('detectarPalavraChaveDeConsentimento — opt-out', () => {
  it.each(['SAIR', 'sair', 'Parar', 'STOP', 'cancelar', 'opt-out', 'descadastrar', 'quero sair', 'pode parar, obrigado'])(
    'mensagem curta "%s" é opt-out',
    (msg) => {
      expect(detectar(msg)).toBe('opt_out');
    }
  );

  it('acento não atrapalha ("cancelár")', () => {
    expect(detectar('cancelár')).toBe('opt_out');
  });

  it('palavra isolada só vale em mensagem de até 30 caracteres', () => {
    expect(detectar('quero sair do grupo da academia agora')).toBeNull();
    expect('x'.repeat(26) + ' sair').toHaveLength(31);
    expect(detectar('x'.repeat(26) + ' sair')).toBeNull();
    expect(detectar('x'.repeat(25) + ' sair')).toBe('opt_out');
  });

  it('frase específica vale em qualquer tamanho', () => {
    expect(detectar('Olá, bom dia. Por favor, quero sair da lista de vocês, não tenho mais interesse.')).toBe('opt_out');
    expect(detectar('podem parar mensagens pra este número? obrigado, não preciso mais de nada')).toBe('opt_out');
  });

  it('palavra dentro de outra não casa ("sairei", "parar" em "preparar")', () => {
    expect(detectar('sairei cedo')).toBeNull();
    expect(detectar('vou preparar')).toBeNull();
  });
});

describe('detectarPalavraChaveDeConsentimento — opt-in', () => {
  it.each(['VOLTAR', 'voltar', 'quero receber', 'receber', 'Voltar, por favor', 'quero voltar a receber'])(
    'mensagem curta "%s" é opt-in',
    (msg) => {
      expect(detectar(msg)).toBe('opt_in');
    }
  );

  it('frase "quero voltar a receber" vale em qualquer tamanho', () => {
    expect(detectar('Oi! Mudei de ideia e quero voltar a receber as novidades de vocês, pode ser?')).toBe('opt_in');
  });

  it('palavra isolada só vale em mensagem curta', () => {
    expect(detectar('quero receber o catálogo completo com todos os preços')).toBeNull();
  });

  it('quando sair e voltar aparecem juntos, sair vence ("parar de receber")', () => {
    expect(detectar('parar de receber')).toBe('opt_out');
  });

  it('nada: vazio, texto comum', () => {
    expect(detectar('')).toBeNull();
    expect(detectar('   ')).toBeNull();
    expect(detectar('qual o horário de hoje?')).toBeNull();
    expect(detectar(undefined as unknown as string)).toBeNull();
  });
});

describe('processarPalavraChave', () => {
  const acc = 'acc-1';
  const tel = '5511987654321';
  const registro = (status: string | null) =>
    prismaMock.whatsappConsent.findUnique.mockResolvedValue(status ? { status, contactId: null } : null);

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.contact.findFirst.mockResolvedValue(null);
    prismaMock.whatsappConsent.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'c1',
      ...create,
      updatedAt: new Date(),
    }));
  });

  it('SAIR sem registro → grava opted_out, mudou, resposta de opt-out', async () => {
    registro(null);
    const r = await whatsappConsentService.processarPalavraChave(acc, tel, 'SAIR');
    expect(r).toEqual({ acao: 'opt_out', mudou: true, resposta: MENSAGEM_DE_OPT_OUT, phone: tel, contactId: null });
    expect(prismaMock.whatsappConsent.upsert).toHaveBeenCalledTimes(1);
    const arg = prismaMock.whatsappConsent.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ accountId: acc, phone: tel, status: 'opted_out', source: 'auto_keyword' });
    expect(arg.create.reason).toContain('SAIR');
  });

  it('SAIR de quem já está fora → não regrava, mudou=false (confirma só na 1ª)', async () => {
    registro('opted_out');
    const r = await whatsappConsentService.processarPalavraChave(acc, tel, 'sair');
    expect(r).toMatchObject({ acao: 'opt_out', mudou: false });
    expect(prismaMock.whatsappConsent.upsert).not.toHaveBeenCalled();
  });

  it('VOLTAR de quem está fora → opted_in (auto_keyword), mudou, resposta de opt-in', async () => {
    registro('opted_out');
    const r = await whatsappConsentService.processarPalavraChave(acc, tel, 'VOLTAR');
    expect(r).toEqual({ acao: 'opt_in', mudou: true, resposta: MENSAGEM_DE_OPT_IN, phone: tel, contactId: null });
    const arg = prismaMock.whatsappConsent.upsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({ status: 'opted_in', source: 'auto_keyword' });
  });

  it('"quero receber" de quem nunca saiu não é palavra-chave (segue pro atendimento)', async () => {
    registro(null);
    expect(await whatsappConsentService.processarPalavraChave(acc, tel, 'quero receber')).toBeNull();
    registro('opted_in');
    expect(await whatsappConsentService.processarPalavraChave(acc, tel, 'voltar')).toBeNull();
    expect(prismaMock.whatsappConsent.upsert).not.toHaveBeenCalled();
  });

  it('texto comum → null sem tocar no banco; telefone inválido → null', async () => {
    expect(await whatsappConsentService.processarPalavraChave(acc, tel, 'oi, tudo bem?')).toBeNull();
    expect(prismaMock.whatsappConsent.findUnique).not.toHaveBeenCalled();
    expect(await whatsappConsentService.processarPalavraChave(acc, '12', 'SAIR')).toBeNull();
  });

  it('handleInboundOptOut continua só opt-out: true no SAIR, false no VOLTAR', async () => {
    registro(null);
    expect(await whatsappConsentService.handleInboundOptOut(acc, tel, 'SAIR')).toBe(true);
    registro('opted_out');
    expect(await whatsappConsentService.handleInboundOptOut(acc, tel, 'VOLTAR')).toBe(false);
  });
});
