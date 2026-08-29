/**
 * T-029 — discador: contrato comum e seleção da operadora.
 *
 * Duas implementações atendem ao mesmo contrato:
 *   - SIP sobre WebSocket → provedor nacional com plano fechado. O navegador
 *     registra direto no provedor.
 *   - Twilio → API paga por minuto, com SDK próprio.
 *
 * A tela não sabe qual está em uso: ela consome `UseDialerResult` e pronto.
 * Trocar de operadora não mexe em nada da interface.
 */
import { useSipDialer } from './useSipDialer';
import { useTwilioDialer } from './useTwilioDialer';

export type DialerState =
  | 'desconectado'
  | 'pronto'
  | 'discando'
  | 'chamando'
  | 'em_ligacao'
  | 'encerrando'
  | 'erro';

export interface UseDialerResult {
  state: DialerState;
  erro: string | null;
  /** Segundos desde que a ligação foi atendida. */
  duracao: number;
  mudo: boolean;
  callId: string | null;
  numeroAtual: string | null;
  ligar: (numero: string, contactId?: string | null) => Promise<void>;
  desligar: () => void;
  alternarMudo: () => void;
  /** Dígito do teclado durante a ligação (URA do outro lado). */
  enviarDigito: (digito: string) => void;
}

export type VoiceProvider = 'twilio' | 'sip';

/**
 * Os DOIS hooks são sempre chamados — regra do React, hook não pode ser
 * condicional. Cada um recebe `enabled` e o desligado não abre conexão
 * nenhuma; só o ativo tem o resultado devolvido.
 */
export function useDialer(provider: VoiceProvider | undefined): UseDialerResult {
  const usarSip = provider !== 'twilio';

  const sip = useSipDialer(usarSip);
  const twilio = useTwilioDialer(!usarSip);

  return usarSip ? sip : twilio;
}
