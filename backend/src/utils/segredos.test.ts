/**
 * ETAPA G (P0-6) — a máscara de segredos: `••••` + 4 últimos em todo campo
 * sensível, flags de chave de IA, e o valor mascarado devolvido pelo
 * formulário é ignorado na escrita.
 */

import { describe, it, expect } from 'vitest';
import {
  ehCampoSensivel,
  ehValorMascarado,
  mascararValor,
  mascararSegredos,
  semValoresMascarados,
  CAMPOS_SENSIVEIS,
} from './segredos';

describe('ehCampoSensivel', () => {
  it('os campos nomeados e qualquer *Secret|*Token|*Password|*ApiKey|*Senha', () => {
    for (const c of CAMPOS_SENSIVEIS) expect(ehCampoSensivel(c)).toBe(true);
    expect(ehCampoSensivel('novoProviderApiKey')).toBe(true);
    expect(ehCampoSensivel('webhookToken')).toBe(true);
    expect(ehCampoSensivel('smtpPassword')).toBe(true);
    expect(ehCampoSensivel('clientSecret')).toBe(true);
    expect(ehCampoSensivel('senhaDoPainel')).toBe(false); // termina em "Painel", não em "Senha"
    expect(ehCampoSensivel('minhaSenha')).toBe(true);
    expect(ehCampoSensivel('nome')).toBe(false);
    expect(ehCampoSensivel('googleClientId')).toBe(false);
    expect(ehCampoSensivel('sendgridFromEmail')).toBe(false);
    expect(ehCampoSensivel('twilioApiKeySid')).toBe(true);
  });
});

describe('mascararValor / ehValorMascarado', () => {
  it('•••• + 4 últimos só com 12+ caracteres; segredo curto vira só ••••', () => {
    expect(mascararValor('sk-openai-ABCD1234')).toBe('••••1234');
    expect(mascararValor('abcdefghij12')).toBe('••••ij12'); // 12: já mostra o fim
    expect(mascararValor('abcdefghij1')).toBe('••••'); // 11: não
    expect(mascararValor('senha123')).toBe('••••'); // senha de 8: os 4 últimos seriam metade dela
    expect(mascararValor('  abc  ')).toBe('••••');
    expect(mascararValor('abcd')).toBe('••••');
    expect(mascararValor('abcde')).toBe('••••');
    expect(mascararValor('  abcdefghij12  ')).toBe('••••ij12'); // mede o valor aparado
  });

  it('reconhece a nossa máscara e a sentinela antiga; valor real não', () => {
    expect(ehValorMascarado('••••1234')).toBe(true);
    expect(ehValorMascarado('••••')).toBe(true);
    expect(ehValorMascarado('***SET***')).toBe(true);
    expect(ehValorMascarado(' ••••abcd ')).toBe(true);
    expect(ehValorMascarado('sk-real')).toBe(false);
    expect(ehValorMascarado('')).toBe(false);
    expect(ehValorMascarado(null)).toBe(false);
    expect(ehValorMascarado(42)).toBe(false);
  });
});

describe('mascararSegredos', () => {
  it('mascara todo campo sensível, mantém o resto, e põe as flags de chave de IA', () => {
    const conta = {
      id: 'a',
      nome: 'Clínica',
      openaiApiKey: 'sk-openai-ABCD1234',
      anthropicApiKey: null,
      evolutionApiKey: '',
      evolutionWebhookSecret: 'segredo-webhook-16-chars',
      sendgridApiKey: 'SG.xyz.9876',
      googleClientId: 'cliente-publico',
      googleClientSecret: 'gcs-0001',
      twilioAccountSid: 'AC1234567890',
      twilioAuthToken: 'tw-4321',
      sipPassword: 'sip-2468',
      modulos: ['emails'],
      _count: { users: 2 },
    };
    const m = mascararSegredos(conta);
    expect(m).toEqual({
      id: 'a',
      nome: 'Clínica',
      openaiApiKey: '••••1234',
      anthropicApiKey: null,
      evolutionApiKey: null,
      evolutionWebhookSecret: '••••hars',
      sendgridApiKey: '••••', // 11 caracteres: curto
      googleClientId: 'cliente-publico',
      googleClientSecret: '••••', // 8
      twilioAccountSid: '••••7890', // 12: mostra o fim
      twilioAuthToken: '••••', // 7
      sipPassword: '••••', // 8
      modulos: ['emails'],
      _count: { users: 2 },
      temChaveOpenai: true,
      temChaveAnthropic: false,
    });
    // Não muta o original.
    expect(conta.openaiApiKey).toBe('sk-openai-ABCD1234');
    expect(JSON.stringify(m)).not.toContain('sk-openai');
  });

  it('campo ausente continua ausente (não inventa chave null)', () => {
    const m = mascararSegredos({ id: 'x', nome: 'y' });
    expect(m).toEqual({ id: 'x', nome: 'y', temChaveOpenai: false, temChaveAnthropic: false });
    expect('openaiApiKey' in m).toBe(false);
  });
});

describe('semValoresMascarados', () => {
  it('tira só os campos sensíveis cujo valor é máscara; valor real, null e não sensível ficam', () => {
    const entrada = {
      nome: '••••abcd', // não é campo sensível: fica (é um nome esquisito, mas é do usuário)
      openaiApiKey: '••••1234',
      anthropicApiKey: 'sk-ant-nova',
      sendgridApiKey: '***SET***',
      evolutionWebhookSecret: null,
      sipPassword: '',
      twilioAuthToken: undefined,
    };
    expect(semValoresMascarados(entrada)).toEqual({
      nome: '••••abcd',
      anthropicApiKey: 'sk-ant-nova',
      evolutionWebhookSecret: null,
      sipPassword: '',
      twilioAuthToken: undefined,
    });
    expect(entrada.openaiApiKey).toBe('••••1234'); // não muta
  });
});
