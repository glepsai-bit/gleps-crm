import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do socket.io-client: `io()` devolve sempre o mesmo socket fake, e
// guardamos os handlers registrados via `.on` pra poder disparar 'connect'
// manualmente (simula reconnect).
const h = vi.hoisted(() => {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const socket = {
    connected: false,
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      handlers[ev] = cb;
    }),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return { handlers, socket, ioMock: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: h.ioMock, Socket: class {} }));

import { ChatSocket } from './socket.client';

describe('ChatSocket — FIX-REALTIME-REJOIN (rejoin nas salas após reconnect)', () => {
  beforeEach(() => {
    h.socket.on.mockClear();
    h.socket.emit.mockClear();
    for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  });

  it('registra um handler de "connect" ao conectar', () => {
    const cs = new ChatSocket();
    cs.connect('tok');
    expect(h.handlers['connect']).toBeTypeOf('function');
  });

  it('re-emite join-conversation de TODAS as salas ativas quando reconecta', () => {
    const cs = new ChatSocket();
    cs.connect('tok');
    cs.joinConversation('conv-1');
    cs.joinConversation('conv-2');

    // isola o efeito do reconnect (ignora os joins iniciais)
    h.socket.emit.mockClear();

    // simula o socket (re)conectando — é o que quebrava antes (após rebuild do
    // backend o cliente ficava fora da sala e a thread parava de atualizar)
    h.handlers['connect']!();

    expect(h.socket.emit).toHaveBeenCalledWith('join-conversation', { conversationId: 'conv-1' });
    expect(h.socket.emit).toHaveBeenCalledWith('join-conversation', { conversationId: 'conv-2' });
  });

  it('leaveConversation tira a sala do rejoin', () => {
    const cs = new ChatSocket();
    cs.connect('tok');
    cs.joinConversation('conv-1');
    cs.joinConversation('conv-2');
    cs.leaveConversation('conv-1');

    h.socket.emit.mockClear();
    h.handlers['connect']!();

    expect(h.socket.emit).not.toHaveBeenCalledWith('join-conversation', { conversationId: 'conv-1' });
    expect(h.socket.emit).toHaveBeenCalledWith('join-conversation', { conversationId: 'conv-2' });
  });

  it('sem nenhuma sala ativa, o reconnect não emite join', () => {
    const cs = new ChatSocket();
    cs.connect('tok');
    h.socket.emit.mockClear();
    h.handlers['connect']!();
    expect(h.socket.emit).not.toHaveBeenCalled();
  });
});
