/**
 * T-029 — Discador: telefonia ativa pelo navegador.
 *
 * O áudio vai pelo WebRTC direto entre o navegador do operador e a Twilio; o
 * backend não trafega voz. O papel dele é três coisas:
 *   1. emitir o token de acesso que autoriza aquele operador a discar;
 *   2. responder o TwiML que diz pra operadora QUEM discar;
 *   3. receber os callbacks de status e registrar a ligação.
 *
 * Por que Twilio: é a única operadora com SDK de navegador onde a conta é
 * self-service (cartão, sem contrato) e que disca pro Brasil e pro exterior no
 * mesmo dia. Trocar de operadora depois é reimplementar este arquivo — as
 * telas e o model `Call` não mudam.
 */

import twilio from 'twilio';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError, AppError } from '../utils/errors';

export const SENTINEL = '***SET***' as const;

/** Token curto: se vazar, expira sozinho. O operador renova ao abrir o discador. */
const TOKEN_TTL_SECONDS = 3600;

export interface VoiceConfigView {
  twilioAccountSid: string | null;
  twilioAuthToken: typeof SENTINEL | null;
  twilioApiKeySid: string | null;
  twilioApiKeySecret: typeof SENTINEL | null;
  twilioTwimlAppSid: string | null;
  twilioCallerId: string | null;
  voiceRecording: boolean;
  /** Tudo que falta pra discar. Vazio = pronto. */
  pendencias: string[];
}

export interface UpdateVoiceConfigInput {
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  twilioApiKeySid?: string | null;
  twilioApiKeySecret?: string | null;
  twilioTwimlAppSid?: string | null;
  twilioCallerId?: string | null;
  voiceRecording?: boolean;
}

/**
 * Normaliza pra E.164, que é o formato que a operadora exige.
 *
 * Regras aplicadas na ordem: já tem `+` → respeita (permite ligar pro exterior
 * digitando +1..., +351...). Só dígitos → assume Brasil, porque é de onde vem
 * a base de leads (Google Maps) e digitar +55 em toda ligação seria atrito
 * desnecessário pro operador.
 */
export function toE164(raw: string): string {
  const limpo = (raw ?? '').trim();
  if (!limpo) throw new ValidationError('Número vazio');

  if (limpo.startsWith('+')) {
    const digitos = limpo.slice(1).replace(/\D/g, '');
    if (digitos.length < 8 || digitos.length > 15) {
      throw new ValidationError(`Número internacional inválido: ${raw}`);
    }
    return `+${digitos}`;
  }

  const d = limpo.replace(/\D/g, '');
  if (d.length === 0) throw new ValidationError(`Número inválido: ${raw}`);

  // Já veio com o código do país.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  // DDD + número (10 = fixo, 11 = celular com o 9).
  if (d.length === 10 || d.length === 11) return `+55${d}`;

  throw new ValidationError(
    `Número inválido: "${raw}". Use DDD + número (11 dígitos) ou +código do país para o exterior.`
  );
}

/** Base pública que a operadora usa pra alcançar nossos webhooks. */
function publicBaseUrl(): string {
  return (env.WEBHOOK_BASE_URL || env.API_URL).replace(/\/$/, '');
}

class VoiceService {
  // ============================================
  // Configuração
  // ============================================

  async getConfig(accountId: string): Promise<VoiceConfigView> {
    const a = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        twilioAccountSid: true,
        twilioAuthToken: true,
        twilioApiKeySid: true,
        twilioApiKeySecret: true,
        twilioTwimlAppSid: true,
        twilioCallerId: true,
        voiceRecording: true,
      },
    });
    if (!a) throw new NotFoundError('Conta');

    const pendencias: string[] = [];
    if (!a.twilioAccountSid) pendencias.push('Account SID');
    if (!a.twilioAuthToken) pendencias.push('Auth Token');
    if (!a.twilioApiKeySid) pendencias.push('API Key SID');
    if (!a.twilioApiKeySecret) pendencias.push('API Key Secret');
    if (!a.twilioTwimlAppSid) pendencias.push('TwiML App SID');
    if (!a.twilioCallerId) pendencias.push('Número de origem');

    return {
      // SID não é segredo (é identificador público da conta) — mostrar ajuda a
      // conferir se está apontando pra conta certa. Token e Secret são segredo.
      twilioAccountSid: a.twilioAccountSid,
      twilioAuthToken: a.twilioAuthToken ? SENTINEL : null,
      twilioApiKeySid: a.twilioApiKeySid,
      twilioApiKeySecret: a.twilioApiKeySecret ? SENTINEL : null,
      twilioTwimlAppSid: a.twilioTwimlAppSid,
      twilioCallerId: a.twilioCallerId,
      voiceRecording: a.voiceRecording,
      pendencias,
    };
  }

  async updateConfig(accountId: string, input: UpdateVoiceConfigInput): Promise<VoiceConfigView> {
    const data: Record<string, string | boolean | null> = {};

    const campos = [
      'twilioAccountSid',
      'twilioAuthToken',
      'twilioApiKeySid',
      'twilioApiKeySecret',
      'twilioTwimlAppSid',
      'twilioCallerId',
    ] as const;

    for (const campo of campos) {
      const valor = input[campo];
      if (valor === undefined) continue;
      // '***SET***' reenviado pela tela = preservar o valor atual.
      if (valor === SENTINEL) continue;
      const limpo = typeof valor === 'string' ? valor.trim() : '';
      data[campo] = limpo === '' ? null : limpo;
    }

    if (input.twilioCallerId !== undefined && typeof data.twilioCallerId === 'string') {
      data.twilioCallerId = toE164(data.twilioCallerId);
    }
    if (input.voiceRecording !== undefined) data.voiceRecording = input.voiceRecording;

    if (Object.keys(data).length > 0) {
      await prisma.account.update({ where: { id: accountId }, data });
    }
    return this.getConfig(accountId);
  }

  private async credenciais(accountId: string) {
    const a = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        twilioAccountSid: true,
        twilioAuthToken: true,
        twilioApiKeySid: true,
        twilioApiKeySecret: true,
        twilioTwimlAppSid: true,
        twilioCallerId: true,
        voiceRecording: true,
      },
    });
    if (!a) throw new NotFoundError('Conta');
    return a;
  }

  // ============================================
  // Token do navegador
  // ============================================

  /**
   * Token que autoriza ESTE operador a discar. Sem ele o SDK do navegador não
   * conecta. `identity` é o userId — é assim que a operadora nos diz depois
   * quem originou a chamada.
   */
  async createAccessToken(accountId: string, userId: string): Promise<{ token: string; expiresIn: number }> {
    const c = await this.credenciais(accountId);
    if (!c.twilioAccountSid || !c.twilioApiKeySid || !c.twilioApiKeySecret || !c.twilioTwimlAppSid) {
      throw new AppError(
        'Discador não configurado. Preencha as credenciais em Administração → Discador.',
        503
      );
    }

    const { AccessToken } = twilio.jwt;
    const { VoiceGrant } = AccessToken;

    const token = new AccessToken(c.twilioAccountSid, c.twilioApiKeySid, c.twilioApiKeySecret, {
      identity: userId,
      ttl: TOKEN_TTL_SECONDS,
    });
    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: c.twilioTwimlAppSid,
        // Só ativo por enquanto: o operador liga, não recebe.
        incomingAllow: false,
      })
    );

    return { token: token.toJwt(), expiresIn: TOKEN_TTL_SECONDS };
  }

  // ============================================
  // Discagem
  // ============================================

  /**
   * Registra a ligação ANTES de discar e devolve o id.
   *
   * Registrar antes é o que garante que uma chamada que nunca conecta (número
   * inválido, saldo, rede) ainda apareça no histórico. Se o registro fosse
   * criado no callback, a ligação que falha sumiria e o operador não saberia
   * por que "não aconteceu nada".
   */
  async startCall(params: {
    accountId: string;
    userId: string;
    to: string;
    contactId?: string | null;
  }): Promise<{ callId: string; to: string }> {
    const c = await this.credenciais(params.accountId);
    if (!c.twilioCallerId) {
      throw new AppError('Falta configurar o número de origem em Administração → Discador.', 503);
    }

    const to = toE164(params.to);

    // Se o número existe na base, amarra na ficha do contato — é o que faz a
    // ligação aparecer no histórico do lead.
    let contactId = params.contactId ?? null;
    if (!contactId) {
      const soDigitos = to.replace(/\D/g, '');
      const contato = await prisma.contact.findFirst({
        where: {
          accountId: params.accountId,
          OR: [
            { telefone: to },
            { telefone: soDigitos },
            { telefone: soDigitos.slice(2) }, // sem o 55
          ],
        },
        select: { id: true },
      });
      contactId = contato?.id ?? null;
    }

    const call = await prisma.call.create({
      data: {
        accountId: params.accountId,
        userId: params.userId,
        contactId,
        direction: 'outbound',
        toNumber: to,
        fromNumber: c.twilioCallerId,
        status: 'queued',
      },
    });

    return { callId: call.id, to };
  }

  /**
   * TwiML: a instrução que a operadora busca quando o navegador pede a chamada.
   * É aqui que a ligação de fato é encaminhada pro número de destino.
   */
  async buildDialTwiml(accountId: string, to: string, callId: string): Promise<string> {
    const c = await this.credenciais(accountId);
    const base = publicBaseUrl();
    const resposta = new twilio.twiml.VoiceResponse();

    if (c.voiceRecording) {
      // AVISO DE GRAVAÇÃO: gravar sem informar não é opção. Fica antes do
      // <Dial> pra tocar assim que a chamada é atendida.
      resposta.say(
        { language: 'pt-BR', voice: 'Polly.Camila' },
        'Esta ligação poderá ser gravada para fins de qualidade.'
      );
    }

    const dial = resposta.dial({
      callerId: c.twilioCallerId ?? undefined,
      answerOnBridge: true,
      ...(c.voiceRecording
        ? {
            record: 'record-from-answer-dual' as const,
            recordingStatusCallback: `${base}/api/voice/recording?callId=${encodeURIComponent(callId)}`,
            recordingStatusCallbackMethod: 'POST' as const,
          }
        : {}),
    });

    dial.number(
      {
        statusCallback: `${base}/api/voice/status?callId=${encodeURIComponent(callId)}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      },
      to
    );

    return resposta.toString();
  }

  // ============================================
  // Callbacks da operadora
  // ============================================

  /** Atualiza a ligação conforme os eventos chegam (tocando, atendeu, encerrou). */
  async handleStatusCallback(callId: string, payload: Record<string, string>): Promise<void> {
    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      logger.warn('[voice] callback de status para ligação inexistente', { callId });
      return;
    }

    const status = (payload.CallStatus || payload.DialCallStatus || '').toLowerCase();
    const sid = payload.CallSid || payload.DialCallSid || null;
    const duracao = Number(payload.CallDuration || payload.DialCallDuration || 0);

    const data: Record<string, unknown> = {};
    if (status) data.status = status;
    if (sid && !call.providerCallSid) data.providerCallSid = sid;
    if (status === 'in-progress' && !call.startedAt) data.startedAt = new Date();
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
      data.endedAt = new Date();
      if (Number.isFinite(duracao) && duracao > 0) data.durationSec = duracao;
    }
    // A Twilio informa o preço só depois de fechar a bilhetagem; quando vier,
    // guardamos pro controle de custo (o mesmo tratamento que a IA já tem).
    if (payload.Price) {
      const preco = Math.abs(Number(payload.Price));
      if (Number.isFinite(preco)) data.priceUsd = preco;
    }

    if (Object.keys(data).length > 0) {
      await prisma.call.update({ where: { id: callId }, data });
    }
  }

  async handleRecordingCallback(callId: string, payload: Record<string, string>): Promise<void> {
    const url = payload.RecordingUrl;
    if (!url) return;
    await prisma.call
      .update({ where: { id: callId }, data: { recordingUrl: `${url}.mp3` } })
      .catch(() => undefined);
  }

  /** Conta dona da ligação — usada para achar o Auth Token que valida o callback. */
  async accountIdDaLigacao(callId: string): Promise<string | null> {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { accountId: true },
    });
    return call?.accountId ?? null;
  }

  /**
   * Confere a assinatura do webhook. Sem isso qualquer um que descubra a URL
   * consegue forjar status de ligação e poluir o histórico.
   */
  async validateWebhook(
    accountId: string,
    signature: string | undefined,
    url: string,
    params: Record<string, string>
  ): Promise<boolean> {
    const c = await this.credenciais(accountId);
    if (!c.twilioAuthToken || !signature) return false;
    return twilio.validateRequest(c.twilioAuthToken, signature, url, params);
  }

  // ============================================
  // Histórico
  // ============================================

  async listCalls(
    accountId: string,
    filtros: { contactId?: string; userId?: string; limit?: number } = {}
  ) {
    return prisma.call.findMany({
      where: {
        accountId,
        ...(filtros.contactId ? { contactId: filtros.contactId } : {}),
        ...(filtros.userId ? { userId: filtros.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filtros.limit ?? 50, 200),
      include: {
        contact: { select: { id: true, nome: true, telefone: true } },
        user: { select: { id: true, nome: true } },
      },
    });
  }

  /** Resultado que o operador marca depois de desligar. */
  async setOutcome(
    accountId: string,
    callId: string,
    input: { disposition?: string; notes?: string }
  ) {
    const call = await prisma.call.findFirst({ where: { id: callId, accountId } });
    if (!call) throw new NotFoundError('Ligação');

    return prisma.call.update({
      where: { id: callId },
      data: {
        ...(input.disposition !== undefined ? { disposition: input.disposition.slice(0, 40) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes.slice(0, 5000) } : {}),
      },
    });
  }
}

export const voiceService = new VoiceService();
