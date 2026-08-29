/**
 * T-029b — discador via SIP sobre WebSocket.
 *
 * O navegador registra DIRETO no provedor: sem Asterisk, sem servidor de mídia
 * e sem webhook. O áudio é WebRTC ponta a ponta com o provedor.
 *
 * A contrapartida de não ter webhook é que ninguém no servidor sabe o que
 * aconteceu com a ligação — quem observa é este hook, e por isso ele reporta o
 * andamento de volta pro backend (`reportProgress`). Sem isso o histórico
 * ficaria eternamente em "na fila".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UserAgent,
  Registerer,
  Inviter,
  SessionState,
  type Session,
  type SessionDescriptionHandler,
} from 'sip.js';
import { voiceService } from '@/services/voice.backend.service';
import type { DialerState, UseDialerResult } from './useDialer';

/** O SDH do SIP.js expõe a RTCPeerConnection, mas fora do tipo público. */
interface SdhComPeer extends SessionDescriptionHandler {
  peerConnection?: RTCPeerConnection;
}

/** `enabled` = false deixa o hook inerte (ver useDialer.ts). */
export function useSipDialer(enabled: boolean): UseDialerResult {
  const [state, setState] = useState<DialerState>('desconectado');
  const [erro, setErro] = useState<string | null>(null);
  const [duracao, setDuracao] = useState(0);
  const [mudo, setMudo] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [numeroAtual, setNumeroAtual] = useState<string | null>(null);

  const uaRef = useRef<UserAgent | null>(null);
  const registererRef = useRef<Registerer | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dominioRef = useRef<string>('');
  const callIdRef = useRef<string | null>(null);
  const duracaoRef = useRef(0);

  const pararTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Reporta o andamento pro backend; falha aqui não pode derrubar a ligação. */
  const reportar = useCallback(
    (status: string, extra: { durationSec?: number; error?: string } = {}) => {
      const id = callIdRef.current;
      if (!id) return;
      void voiceService.reportProgress(id, { status, ...extra }).catch(() => undefined);
    },
    []
  );

  // Elemento de áudio único: é nele que o som do outro lado toca. Sem isso a
  // ligação conecta em silêncio — o erro mais confuso de depurar em WebRTC.
  useEffect(() => {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    audioRef.current = el;
    return () => {
      el.srcObject = null;
      el.remove();
      audioRef.current = null;
    };
  }, []);

  // Registro no provedor: feito uma vez e mantido.
  useEffect(() => {
    if (!enabled) return;
    let ativo = true;
    let ua: UserAgent | null = null;
    let registerer: Registerer | null = null;

    (async () => {
      try {
        const cred = await voiceService.getSipCredentials();
        if (!ativo) return;
        dominioRef.current = cred.domain;

        const uri = UserAgent.makeURI(`sip:${cred.username}@${cred.domain}`);
        if (!uri) throw new Error('Usuário ou domínio SIP inválido');

        ua = new UserAgent({
          uri,
          transportOptions: { server: cred.wsServer },
          authorizationUsername: cred.username,
          authorizationPassword: cred.password,
          ...(cred.callerId ? { displayName: cred.callerId } : {}),
          sessionDescriptionHandlerFactoryOptions: {
            constraints: { audio: true, video: false },
          },
        });

        await ua.start();
        if (!ativo) return;

        registerer = new Registerer(ua);
        await registerer.register();
        if (!ativo) return;

        uaRef.current = ua;
        registererRef.current = registerer;
        setState('pronto');
      } catch (e) {
        if (!ativo) return;
        setErro(
          e instanceof Error
            ? e.message
            : 'Não foi possível conectar no provedor. Confira os dados SIP.'
        );
        setState('erro');
      }
    })();

    return () => {
      ativo = false;
      pararTimer();
      void registerer?.unregister().catch(() => undefined);
      void ua?.stop().catch(() => undefined);
      uaRef.current = null;
      registererRef.current = null;
    };
  }, [enabled, pararTimer]);

  /** Liga o áudio remoto no elemento — é o que faz o operador escutar. */
  const conectarAudio = useCallback((session: Session) => {
    const sdh = session.sessionDescriptionHandler as SdhComPeer | undefined;
    const pc = sdh?.peerConnection;
    if (!pc || !audioRef.current) return;

    const remoto = new MediaStream();
    pc.getReceivers().forEach((r) => {
      if (r.track && r.track.kind === 'audio') remoto.addTrack(r.track);
    });
    audioRef.current.srcObject = remoto;
    void audioRef.current.play().catch(() => undefined);
  }, []);

  const encerrar = useCallback(
    (status: string, mensagem?: string) => {
      pararTimer();
      reportar(status, { durationSec: duracaoRef.current, ...(mensagem ? { error: mensagem } : {}) });
      if (audioRef.current) audioRef.current.srcObject = null;
      sessionRef.current = null;
      callIdRef.current = null;
      duracaoRef.current = 0;
      setMudo(false);
      setState(uaRef.current ? 'pronto' : 'desconectado');
    },
    [pararTimer, reportar]
  );

  const ligar = useCallback(
    async (numero: string, contactId?: string | null) => {
      const ua = uaRef.current;
      if (!ua) {
        setErro('Discador ainda não está pronto.');
        return;
      }
      setErro(null);
      setState('discando');

      try {
        // Registra antes de discar: chamada que nem completa continua no histórico.
        const { callId: id, to } = await voiceService.startCall(numero, contactId);
        setCallId(id);
        callIdRef.current = id;
        setNumeroAtual(to);

        // O provedor espera o número sem o '+' na maioria dos casos; mandamos
        // só dígitos, que é o formato aceito por todos.
        const destino = UserAgent.makeURI(`sip:${to.replace(/^\+/, '')}@${dominioRef.current}`);
        if (!destino) throw new Error(`Número inválido para o provedor: ${to}`);

        const inviter = new Inviter(ua, destino, {
          sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
        });
        sessionRef.current = inviter;

        inviter.stateChange.addListener((novo: SessionState) => {
          switch (novo) {
            case SessionState.Establishing:
              setState('chamando');
              reportar('ringing');
              break;
            case SessionState.Established:
              setState('em_ligacao');
              duracaoRef.current = 0;
              setDuracao(0);
              conectarAudio(inviter);
              reportar('in-progress');
              pararTimer();
              timerRef.current = setInterval(() => {
                duracaoRef.current += 1;
                setDuracao(duracaoRef.current);
              }, 1000);
              break;
            case SessionState.Terminated:
              // Sem tempo de conversa = ninguém atendeu.
              encerrar(duracaoRef.current > 0 ? 'completed' : 'no-answer');
              break;
            default:
              break;
          }
        });

        await inviter.invite();
        reportar('initiated');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Não foi possível completar a ligação';
        setErro(msg);
        encerrar('failed', msg);
      }
    },
    [conectarAudio, encerrar, pararTimer, reportar]
  );

  const desligar = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    setState('encerrando');
    try {
      // O verbo SIP correto depende do estágio: cancelar o que ainda toca,
      // desligar o que já foi atendido. Trocar os dois deixa a linha presa.
      if (session.state === SessionState.Established) {
        void session.bye().catch(() => undefined);
      } else if (session instanceof Inviter) {
        void session.cancel().catch(() => undefined);
      }
    } catch {
      /* o listener de Terminated finaliza o estado */
    }
  }, []);

  const alternarMudo = useCallback(() => {
    const sdh = sessionRef.current?.sessionDescriptionHandler as SdhComPeer | undefined;
    const pc = sdh?.peerConnection;
    if (!pc) return;
    const novo = !mudo;
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === 'audio') s.track.enabled = !novo;
    });
    setMudo(novo);
  }, [mudo]);

  const enviarDigito = useCallback((digito: string) => {
    const session = sessionRef.current;
    if (!session || session.state !== SessionState.Established) return;
    // DTMF via INFO: é o caminho que todo provedor SIP aceita.
    void session
      .info({
        requestOptions: {
          body: {
            contentDisposition: 'render',
            contentType: 'application/dtmf-relay',
            content: `Signal=${digito}\r\nDuration=200`,
          },
        },
      })
      .catch(() => undefined);
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
