/**
 * Integration tests para warmup-media.controller.ts (T-023 V2 Phase 3B)
 *
 * Cobertura:
 *   - POST /upload — auth, validacao de tipo/mime/tamanho, persistencia
 *     em WarmupTemplate + gravacao no disco.
 *   - GET /media — filtro por type, scope multi-tenant (proprio + globais).
 *   - DELETE /media/:id — multi-tenant guard, super_admin podendo deletar
 *     globais, fs.unlink best-effort.
 *
 * Isolamento: setup.ts trunca warmup_templates no beforeEach. Os arquivos
 * gravados em backend/uploads/warmup/<type>/ sao escritos em um diretorio
 * de teste TMP separado via override de cwd, removido no afterEach.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { prismaTest } from '../test/setup';
import { createTestAccount, authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

// ─── Sandbox de upload ────────────────────────────────────────────────────
// Reaponta o cwd pra um tmpdir antes dos testes para que
// uploadsRoot() (path.resolve(process.cwd(), 'uploads')) grave fora do
// repo. Isso evita poluir backend/uploads em desenvolvimento.

let originalCwd: string;
let sandboxDir: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warmup-media-test-'));
  process.chdir(sandboxDir);
  // Cria a arvore esperada para que express.static nao 404 caso seja
  // exercitado em teste no futuro.
  await fs.mkdir(path.join(sandboxDir, 'uploads', 'warmup', 'audio'), {
    recursive: true,
  });
  await fs.mkdir(path.join(sandboxDir, 'uploads', 'warmup', 'sticker'), {
    recursive: true,
  });
  await fs.mkdir(path.join(sandboxDir, 'uploads', 'warmup', 'image'), {
    recursive: true,
  });
});

afterAll(async () => {
  process.chdir(originalCwd);
  try {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function createAgentJwt(accountId: string): Promise<string> {
  const passwordHash = await bcrypt.hash('Test@1234', 4);
  const user = await prismaTest.user.create({
    data: {
      accountId,
      nome: 'Agent Teste',
      email: `agent-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'agent',
      status: 'active',
      permissions: ['dashboard'],
    },
  });
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'agent',
      accountId,
      permissions: ['dashboard'],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
}

/**
 * Cria um super_admin vinculado a uma account (requireAccountId middleware
 * impede super_admin sem account). Esse super_admin pode deletar templates
 * globais (accountId=null) pelas regras do controller.
 */
async function createSuperAdminJwt(): Promise<{
  jwt: string;
  userId: string;
  accountId: string;
}> {
  const account = await prismaTest.account.create({
    data: { nome: 'Super Admin Account' },
  });
  const passwordHash = await bcrypt.hash('Test@1234', 4);
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Super Admin',
      email: `super-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'super_admin',
      status: 'active',
      permissions: ['*'],
    },
  });
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'super_admin',
      accountId: account.id,
      permissions: ['*'],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { jwt: token, userId: user.id, accountId: account.id };
}

/**
 * Audio OGG fake (~120 bytes) com magic header valido. Suficiente pra
 * passar nas validacoes de MIME (multer infere pelo Content-Type que
 * setamos manualmente — magic bytes nao sao verificados aqui).
 */
function fakeAudioBuffer(): Buffer {
  // 'OggS' + bytes aleatorios curtos
  const header = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // 'OggS'
  const padding = Buffer.alloc(120, 0);
  return Buffer.concat([header, padding]);
}

/**
 * Sticker WebP fake (~80 bytes) com magic 'RIFF....WEBP'.
 */
function fakeWebpBuffer(sizeBytes = 200): Buffer {
  // 'RIFF' <size> 'WEBP'
  const head = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary');
  const padding = Buffer.alloc(Math.max(0, sizeBytes - head.length), 0);
  return Buffer.concat([head, padding]);
}

/**
 * Image JPG fake (~100 bytes) com magic 'FFD8FF'.
 */
function fakeJpgBuffer(sizeBytes = 300): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - head.length), 0);
  return Buffer.concat([head, padding]);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('WarmupMediaController — POST /api/warmup/media/upload', () => {
  it('sem JWT: 401', async () => {
    const res = await request(app)
      .post('/api/warmup/media/upload')
      .attach('file', fakeAudioBuffer(), {
        filename: 'a.ogg',
        contentType: 'audio/ogg',
      })
      .field('type', 'audio');

    expect(res.status).toBe(401);
  });

  it('com JWT de agent (sem admin role): 403', async () => {
    const { account } = await createTestAccount();
    const agentJwt = await createAgentJwt(account.id);

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(agentJwt))
      .attach('file', fakeAudioBuffer(), {
        filename: 'a.ogg',
        contentType: 'audio/ogg',
      })
      .field('type', 'audio');

    expect(res.status).toBe(403);
  });

  it('audio com tamanho > 1MB: 400 (multer corta antes ou controller rejeita)', async () => {
    const { jwt: adminJwt } = await createTestAccount();
    // 1.5MB — passa do limite de audio (1MB), abaixo do teto global multer (2MB)
    const tooBig = Buffer.alloc(1.5 * 1024 * 1024, 0);

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', tooBig, {
        filename: 'big.ogg',
        contentType: 'audio/ogg',
      })
      .field('type', 'audio');

    expect(res.status).toBe(400);
  });

  it('mime invalido (text/plain como audio): 400', async () => {
    const { jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', Buffer.from('texto qualquer'), {
        filename: 'a.txt',
        contentType: 'text/plain',
      })
      .field('type', 'audio');

    expect(res.status).toBe(400);
  });

  it('type invalido (video nao suportado): 400', async () => {
    const { jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', fakeAudioBuffer(), {
        filename: 'x.ogg',
        contentType: 'audio/ogg',
      })
      .field('type', 'video');

    expect(res.status).toBe(400);
  });

  it('audio valido (~120B ogg): 201 + WarmupTemplate criada + arquivo no disco', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();
    const buf = fakeAudioBuffer();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', buf, {
        filename: 'saudacao.ogg',
        contentType: 'audio/ogg',
      })
      .field('type', 'audio');

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'audio',
      mimeType: 'audio/ogg',
      fileName: 'saudacao.ogg',
      sizeBytes: buf.length,
    });
    expect(res.body.data.mediaUrl).toMatch(/\/uploads\/warmup\/audio\/audio-[0-9a-f-]+\.ogg$/);

    // Persistido em DB
    const created = await prismaTest.warmupTemplate.findUnique({
      where: { id: res.body.data.id },
    });
    expect(created).toBeTruthy();
    expect(created?.accountId).toBe(account.id);
    expect(created?.type).toBe('audio');
    expect(created?.category).toBe('media');
    expect(created?.mediaMimeType).toBe('audio/ogg');
    expect(created?.mediaSizeBytes).toBe(buf.length);
    expect(created?.mediaPath).toMatch(/^warmup\/audio\/audio-[0-9a-f-]+\.ogg$/);

    // Persistido em disco
    const absPath = path.join(sandboxDir, 'uploads', created!.mediaPath as string);
    const stat = await fs.stat(absPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(buf.length);
  });

  it('sticker webp valido (<200KB): 201', async () => {
    const { jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', fakeWebpBuffer(150), {
        filename: 's.webp',
        contentType: 'image/webp',
      })
      .field('type', 'sticker');

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('sticker');
  });

  it('image jpg valida: 201 + accountId vem do JWT (nao do body)', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .attach('file', fakeJpgBuffer(500), {
        filename: 'foto.jpg',
        contentType: 'image/jpeg',
      })
      .field('type', 'image')
      // tentativa de tenant-spoof — deve ser ignorada
      .field('accountId', '00000000-0000-0000-0000-000000000999');

    expect(res.status).toBe(201);
    const created = await prismaTest.warmupTemplate.findUnique({
      where: { id: res.body.data.id },
    });
    expect(created?.accountId).toBe(account.id);
  });

  it('falta campo file: 400', async () => {
    const { jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .post('/api/warmup/media/upload')
      .set(authHeader(adminJwt))
      .field('type', 'audio');

    expect(res.status).toBe(400);
  });
});

describe('WarmupMediaController — GET /api/warmup/media', () => {
  it('sem JWT: 401', async () => {
    const res = await request(app).get('/api/warmup/media');
    expect(res.status).toBe(401);
  });

  it('lista templates da accountId + globais (accountId=null)', async () => {
    const accA = await createTestAccount({ accountName: 'A' });
    const accB = await createTestAccount({ accountName: 'B' });

    // Template proprio de A
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: accA.account.id,
        type: 'audio',
        category: 'media',
        content: 'meu audio',
        mediaPath: 'warmup/audio/meu.ogg',
        mediaMimeType: 'audio/ogg',
        mediaSizeBytes: 1000,
        fileName: 'meu.ogg',
      },
    });
    // Template global
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: 'sticker',
        category: 'media',
        content: 'sticker global',
        mediaPath: 'warmup/sticker/global.webp',
        mediaMimeType: 'image/webp',
        mediaSizeBytes: 50000,
        fileName: 'global.webp',
      },
    });
    // Template de B — NAO deve aparecer
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: accB.account.id,
        type: 'audio',
        category: 'media',
        content: 'audio do tenant B',
        mediaPath: 'warmup/audio/b.ogg',
        mediaMimeType: 'audio/ogg',
        mediaSizeBytes: 800,
        fileName: 'b.ogg',
      },
    });

    const res = await request(app)
      .get('/api/warmup/media')
      .set(authHeader(accA.jwt));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const accountIds = res.body.data.map(
      (t: { accountId: string | null }) => t.accountId
    );
    expect(accountIds).toEqual(expect.arrayContaining([accA.account.id, null]));
    expect(accountIds).not.toContain(accB.account.id);
  });

  it('filtra por type=audio (nao retorna sticker/image)', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();
    await prismaTest.warmupTemplate.createMany({
      data: [
        {
          accountId: account.id,
          type: 'audio',
          category: 'media',
          content: '',
          mediaPath: 'warmup/audio/a1.ogg',
          mediaMimeType: 'audio/ogg',
          mediaSizeBytes: 100,
          fileName: 'a1.ogg',
        },
        {
          accountId: account.id,
          type: 'sticker',
          category: 'media',
          content: '',
          mediaPath: 'warmup/sticker/s1.webp',
          mediaMimeType: 'image/webp',
          mediaSizeBytes: 100,
          fileName: 's1.webp',
        },
        {
          accountId: account.id,
          type: 'image',
          category: 'media',
          content: '',
          mediaPath: 'warmup/image/i1.jpg',
          mediaMimeType: 'image/jpeg',
          mediaSizeBytes: 100,
          fileName: 'i1.jpg',
        },
      ],
    });

    const res = await request(app)
      .get('/api/warmup/media?type=audio')
      .set(authHeader(adminJwt));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe('audio');
    // mediaUrl sempre absoluta na resposta
    expect(res.body.data[0].mediaUrl).toMatch(/^https?:\/\/.+\/uploads\/warmup\/audio\//);
  });

  it('NAO retorna templates do tipo text/reaction (sem media)', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();
    // Template do tipo text — nao deve aparecer
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: account.id,
        type: 'text',
        category: 'greeting',
        content: 'Oi, tudo bem?',
      },
    });

    const res = await request(app)
      .get('/api/warmup/media')
      .set(authHeader(adminJwt));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('WarmupMediaController — DELETE /api/warmup/media/:id', () => {
  it('cross-tenant: 404', async () => {
    const accA = await createTestAccount({ accountName: 'A' });
    const accB = await createTestAccount({ accountName: 'B' });
    const templateB = await prismaTest.warmupTemplate.create({
      data: {
        accountId: accB.account.id,
        type: 'audio',
        category: 'media',
        content: '',
        mediaPath: 'warmup/audio/b.ogg',
        mediaMimeType: 'audio/ogg',
        mediaSizeBytes: 100,
        fileName: 'b.ogg',
      },
    });

    const res = await request(app)
      .delete(`/api/warmup/media/${templateB.id}`)
      .set(authHeader(accA.jwt));

    expect(res.status).toBe(404);

    // Template B segue intacto
    const still = await prismaTest.warmupTemplate.findUnique({
      where: { id: templateB.id },
    });
    expect(still).toBeTruthy();
  });

  it('admin nao pode deletar template global (accountId=null)', async () => {
    const { jwt: adminJwt } = await createTestAccount();
    const global = await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: 'sticker',
        category: 'media',
        content: '',
        mediaPath: 'warmup/sticker/global.webp',
        mediaMimeType: 'image/webp',
        mediaSizeBytes: 100,
        fileName: 'global.webp',
      },
    });

    const res = await request(app)
      .delete(`/api/warmup/media/${global.id}`)
      .set(authHeader(adminJwt));

    expect(res.status).toBe(404);

    const still = await prismaTest.warmupTemplate.findUnique({
      where: { id: global.id },
    });
    expect(still).toBeTruthy();
  });

  it('super_admin pode deletar template global', async () => {
    const { jwt: superJwt } = await createSuperAdminJwt();
    const global = await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: 'sticker',
        category: 'media',
        content: '',
        mediaPath: 'warmup/sticker/global2.webp',
        mediaMimeType: 'image/webp',
        mediaSizeBytes: 100,
        fileName: 'global2.webp',
      },
    });

    const res = await request(app)
      .delete(`/api/warmup/media/${global.id}`)
      .set(authHeader(superJwt));

    expect(res.status).toBe(204);

    const gone = await prismaTest.warmupTemplate.findUnique({
      where: { id: global.id },
    });
    expect(gone).toBeNull();
  });

  it('admin proprio: 204 + remove arquivo do disco', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();

    // Cria o arquivo de verdade no sandbox para testar fs.unlink
    const filename = `audio-${randomUUID()}.ogg`;
    const relPath = `warmup/audio/${filename}`;
    const absPath = path.join(sandboxDir, 'uploads', relPath);
    await fs.writeFile(absPath, fakeAudioBuffer());

    const template = await prismaTest.warmupTemplate.create({
      data: {
        accountId: account.id,
        type: 'audio',
        category: 'media',
        content: '',
        mediaPath: relPath,
        mediaMimeType: 'audio/ogg',
        mediaSizeBytes: 124,
        fileName: 'meu.ogg',
      },
    });

    // confirma que arquivo existe ANTES
    const statBefore = await fs.stat(absPath);
    expect(statBefore.isFile()).toBe(true);

    const res = await request(app)
      .delete(`/api/warmup/media/${template.id}`)
      .set(authHeader(adminJwt));

    expect(res.status).toBe(204);

    // template removido
    const gone = await prismaTest.warmupTemplate.findUnique({
      where: { id: template.id },
    });
    expect(gone).toBeNull();

    // arquivo removido
    await expect(fs.stat(absPath)).rejects.toThrow();
  });

  it('arquivo ja sumiu do disco (ENOENT): ainda assim retorna 204', async () => {
    const { account, jwt: adminJwt } = await createTestAccount();

    const template = await prismaTest.warmupTemplate.create({
      data: {
        accountId: account.id,
        type: 'image',
        category: 'media',
        content: '',
        // path aponta pra arquivo inexistente
        mediaPath: `warmup/image/ghost-${randomUUID()}.jpg`,
        mediaMimeType: 'image/jpeg',
        mediaSizeBytes: 500,
        fileName: 'ghost.jpg',
      },
    });

    const res = await request(app)
      .delete(`/api/warmup/media/${template.id}`)
      .set(authHeader(adminJwt));

    expect(res.status).toBe(204);

    const gone = await prismaTest.warmupTemplate.findUnique({
      where: { id: template.id },
    });
    expect(gone).toBeNull();
  });

  it('id invalido (nao UUID): 400', async () => {
    const { jwt: adminJwt } = await createTestAccount();

    const res = await request(app)
      .delete('/api/warmup/media/not-a-uuid')
      .set(authHeader(adminJwt));

    expect(res.status).toBe(400);
  });
});
