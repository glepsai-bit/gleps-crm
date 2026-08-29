/**
 * T-029 — hook do discador.
 *
 * Encapsula o SDK de voz da Twilio: o áudio vai por WebRTC direto entre o
 * navegador e a operadora, sem passar pelo nosso servidor. O que este hook faz
 * é gerenciar o ciclo de vida do Device (que é caro de criar) e traduzir os
 * eventos do SDK num estado simples pra tela.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Device, type Call } from '@twilio/voice-sdk';
import { voiceService } from '@/services/voice.backend.service';

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

export function useDialer(): UseDialerResult {
  const [state, setState] = useState<DialerState>('desconectado');
  const [erro, setErro] = useState<string | null>(null);
  const [duracao, setDuracao] = useState(0);
  const [mudo, setMudo] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [numeroAtual, setNumeroAtual] = useState<string | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cria o Device uma vez e o mantém registrado. Recriar a cada ligação
  // adicionaria segundos de latência antes de cada discagem.
  useEffect(() => {
    let ativo = true;
    let device: Device | null = null;

    (async () => {
      try {
        const { token } = await voiceService.getToken();
        if (!ativo) return;

        device = new Device(token, {
          // Codec preferido: opus tem qualidade melhor; pcmu é o fallback
          // universal quando a rede não coopera.
          codecPreferences: ['opus', 'pcmu'] as never,
          logLevel: 'error' as never,
        });

        device.on('registered', () => ativo && setState('pronto'));
        device.on('error', (e: { message?: string }) => {
          if (!ativo) return;
          setErro(e?.message ?? 'Erro no dispositivo de voz');
          setState('erro');
        });
        // O token expira em 1h; o SDK avisa antes e nós renovamos sem derrubar
        // o operador no meio do expediente.
        device.on('tokenWillExpire', async () => {
          try {
            const novo = await voiceService.getToken();
            device?.updateToken(novo.token);
          } catch {
            /* a próxima ligação falha com erro claro */
          }
        });

        await device.register();
        deviceRef.current = device;
      } catch (e) {
        if (!ativo) return;
        setErro(e instanceof Error ? e.message : 'Não foi possível iniciar o discador');
        setState('erro');
      }
    })();

    return () => {
      ativo = false;
      pararTimer();
      try {
        device?.destroy();
      } catch {
        /* ignora */
      }
      deviceRef.current = null;
    };
  }, [pararTimer]);

  const ligar = useCallback(
    async (numero: string, contactId?: string | null) => {
      const device = deviceRef.current;
      if (!device) {
        setErro('Discador ainda não está pronto.');
        return;
      }
      setErro(null);
      setState('discando');

      try {
        // Registra a ligação ANTES de conectar: assim uma chamada que nem
        // completa continua aparecendo no histórico.
        const { callId: id, to } = await voiceService.startCall(numero, contactId);
        setCallId(id);
        setNumeroAtual(to);

        const call = await device.connect({ params: { To: to, CallId: id } });
        callRef.current = call;
        setState('chamando');

        call.on('accept', () => {
          setState('em_ligacao');
          setDuracao(0);
          pararTimer();
          timerRef.current = setInterval(() => setDuracao((d) => d + 1), 1000);
        });
        const encerrar = () => {
          pararTimer();
          callRef.current = null;
          setMudo(false);
          setState(deviceRef.current ? 'pronto' : 'desconectado');
        };
        call.on('disconnect', encerrar);
        call.on('cancel', encerrar);
        call.on('reject', encerrar);
        call.on('error', (e: { message?: string }) => {
          setErro(e?.message ?? 'Erro na ligação');
          encerrar();
        });
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Não foi possível completar a ligação');
        setState(deviceRef.current ? 'pronto' : 'erro');
      }
    },
    [pararTimer]
  );

  const desligar = useCallback(() => {
    setState('encerrando');
    try {
      callRef.current?.disconnect();
      deviceRef.current?.disconnectAll();
    } catch {
      /* ignora */
    }
  }, []);

  const alternarMudo = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const novo = !mudo;
    call.mute(novo);
    setMudo(novo);
  }, [mudo]);

  const enviarDigito = useCallback((digito: string) => {
    callRef.current?.sendDigits(digito);
  }, []);

  return {
    state,
    erro,
    duracao,
    mudo,
    callId,
    numeroAtual,
    ligar,
    desligar,
    alternarMudo,
    enviarDigito,
  };
}
