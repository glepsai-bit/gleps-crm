/**
 * Regressão do "flake" do integration-chat (ver servidor-loopback.ts): o
 * servidor que o supertest abre precisa ficar em 127.0.0.1, senão o kernel pode
 * entregar a porta de um listener ALHEIO em 127.0.0.1 e quem responde ao teste
 * é outro processo (404/401 que não são do app).
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';

const ouvir = (s: http.Server, ...args: unknown[]) =>
  new Promise<void>((resolve) => {
    (s.listen as (...a: unknown[]) => http.Server).call(s, ...args, resolve);
  });
const fechar = (s: http.Server) => new Promise<void>((resolve) => s.close(() => resolve()));

describe('servidores de teste presos ao loopback', () => {
  it('listen(0) e listen(0, cb) ligam em 127.0.0.1, não no curinga', async () => {
    const a = http.createServer();
    await ouvir(a, 0);
    expect((a.address() as AddressInfo).address).toBe('127.0.0.1');
    await fechar(a);

    const b = http.createServer();
    const quando = new Promise<void>((r) => b.once('listening', () => r()));
    b.listen(0);
    await quando;
    expect((b.address() as AddressInfo).address).toBe('127.0.0.1');
    await fechar(b);
  });

  it('listen({ port: 0 }) sem host também', async () => {
    const s = http.createServer();
    await ouvir(s, { port: 0 });
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
    await fechar(s);
  });

  it('host explícito continua respeitado', async () => {
    const s = http.createServer();
    await ouvir(s, 0, '0.0.0.0');
    expect((s.address() as AddressInfo).address).toBe('0.0.0.0');
    await fechar(s);
  });

  it('o supertest fala com o app, mesmo que outro processo escute em 127.0.0.1', async () => {
    const app = express();
    app.get('/ping', (_req, res) => res.status(401).json({ de: 'app' }));
    const res = await request(app).get('/ping');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ de: 'app' });
  });

  it('120.000 servidores efêmeros nunca recebem a porta de um listener alheio em 127.0.0.1', async () => {
    // O "outro processo": escuta em 127.0.0.1:F (host explícito, como o VS Code).
    const alheio = http.createServer((_q, r) => r.end('alheio'));
    await ouvir(alheio, 0, '127.0.0.1');
    const portaAlheia = (alheio.address() as AddressInfo).port;

    // Sem o patch, cada listen(0) tem 1/16384 de chance de cair em F → ~7 colisões
    // esperadas em 120k (chance de zero ≈ 0,07%). Com o patch, o kernel recusa F.
    let colisoes = 0;
    for (let i = 0; i < 120_000; i++) {
      const s = http.createServer();
      await ouvir(s, 0);
      if ((s.address() as AddressInfo).port === portaAlheia) colisoes++;
      await fechar(s);
    }
    await fechar(alheio);
    expect(colisoes).toBe(0);
  }, 120_000);
});
