/**
 * Integration tests for integration-contacts.controller.ts
 *
 * Cobre os 5 endpoints novos em /api/integrations/contacts:
 *   POST   /                                  create + upsert
 *   GET    /by-phone/:phone                   normalização phone
 *   GET    /                                  filtros (phone, search, attr.*)
 *   PATCH  /:id                               update + cross-tenant
 *   PATCH  /:id/custom-attributes             merge (preserva keys)
 *
 * Estilo: cada teste cria seu próprio estado via helpers (account, api key,
 * contacts). beforeEach do setup.ts já limpa o DB.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prismaTest } from '../test/setup';
import {
  createTestAccount,
  createTestApiKey,
  apiKeyHeader,
} from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

// Telefone real autorizado para QA — segue a regra "nunca telefones fake".
const TEST_PHONE = '5534993383017';

describe('IntegrationContactsController', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/integrations/contacts  (create + upsert)
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/integrations/contacts', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app)
        .post('/api/integrations/contacts')
        .send({ nome: 'Fulano' });
      expect(res.status).toBe(401);
    });

    it('scope insuficiente (contacts:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'Fulano' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('API_KEY_SCOPE_DENIED');
    });

    it('body sem nome: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });

    it('cria contato novo (201): origem default=integration, customAttributes={}', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'Cliente n8n', telefone: TEST_PHONE });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.data.nome).toBe('Cliente n8n');
      expect(res.body.data.telefone).toBe(TEST_PHONE);
      expect(res.body.data.origem).toBe('integration');
      expect(res.body.data.customAttributes).toEqual({});
    });

    it('cria com customAttributes embutidos', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({
          nome: 'Aluno Plano',
          telefone: TEST_PHONE,
          customAttributes: { plano: 'Anual', valor: 1200 },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.customAttributes).toEqual({
        plano: 'Anual',
        valor: 1200,
      });
    });

    it('normaliza telefone com + e espaços ("+55 34 99338-3017")', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'X', telefone: '+55 34 99338-3017' });

      expect(res.status).toBe(201);
      expect(res.body.data.telefone).toBe(TEST_PHONE);
    });

    it('mesmo phone sem upsert: 409', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'A', telefone: TEST_PHONE });

      const dup = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'B', telefone: TEST_PHONE });

      expect(dup.status).toBe(409);
    });

    it('mesmo phone com upsert=true no body: 200 + atualizado + attrs merged', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const r1 = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({
          nome: 'A',
          telefone: TEST_PHONE,
          customAttributes: { plano: 'Mensal', nivel: 'bronze' },
        });
      expect(r1.status).toBe(201);

      const r2 = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({
          nome: 'A Atualizado',
          telefone: TEST_PHONE,
          upsert: true,
          customAttributes: { plano: 'Anual' }, // nivel deve ser preservado
        });

      expect(r2.status).toBe(200);
      expect(r2.body.updated).toBe(true);
      expect(r2.body.data.nome).toBe('A Atualizado');
      expect(r2.body.data.customAttributes).toEqual({
        plano: 'Anual',
        nivel: 'bronze',
      });
    });

    it('mesmo phone com ?upsert=true na query: 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'A', telefone: TEST_PHONE });

      const r = await request(app)
        .post('/api/integrations/contacts?upsert=true')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'B', telefone: TEST_PHONE });

      expect(r.status).toBe(200);
      expect(r.body.data.nome).toBe('B');
    });

    it('customAttributes com chave inválida: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .post('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey))
        .send({
          nome: 'X',
          customAttributes: { 'chave invalida com espaço': 'v' },
        });

      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/integrations/contacts/by-phone/:phone
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /api/integrations/contacts/by-phone/:phone', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get(
        `/api/integrations/contacts/by-phone/${TEST_PHONE}`
      );
      expect(res.status).toBe(401);
    });

    it('encontra contato com telefone exato', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'X', telefone: TEST_PHONE },
      });

      const res = await request(app)
        .get(`/api/integrations/contacts/by-phone/${TEST_PHONE}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data.telefone).toBe(TEST_PHONE);
    });

    it('normaliza phone com + na URL', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'X', telefone: TEST_PHONE },
      });

      const res = await request(app)
        .get(`/api/integrations/contacts/by-phone/${encodeURIComponent('+' + TEST_PHONE)}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data.telefone).toBe(TEST_PHONE);
    });

    it('contato inexistente: 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);

      const res = await request(app)
        .get(`/api/integrations/contacts/by-phone/${TEST_PHONE}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(404);
    });

    it('cross-tenant: phone existe em outra account → 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, [
        'contacts:read',
      ]);
      await prismaTest.contact.create({
        data: { accountId: accB.account.id, nome: 'X', telefone: TEST_PHONE },
      });

      const res = await request(app)
        .get(`/api/integrations/contacts/by-phone/${TEST_PHONE}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/integrations/contacts  (list + filters)
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /api/integrations/contacts', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get('/api/integrations/contacts');
      expect(res.status).toBe(401);
    });

    it('lista paginada (default limit/offset, total)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.createMany({
        data: [
          { accountId: account.id, nome: 'A' },
          { accountId: account.id, nome: 'B' },
          { accountId: account.id, nome: 'C' },
        ],
      });

      const res = await request(app)
        .get('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
      expect(res.body.data.length).toBe(3);
    });

    it('filtra por ?phone exato (normalizado)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'Alvo', telefone: TEST_PHONE },
      });
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'Outro', telefone: '5511999999999' },
      });

      const res = await request(app)
        .get(`/api/integrations/contacts?phone=${encodeURIComponent('+' + TEST_PHONE)}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].nome).toBe('Alvo');
    });

    it('filtra por ?search com escapeLike (% literal não vira wildcard)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'Joao' },
      });
      await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'Maria' },
      });

      // search por nome
      const r1 = await request(app)
        .get('/api/integrations/contacts?search=Joao')
        .set(apiKeyHeader(plaintextKey));
      expect(r1.status).toBe(200);
      expect(r1.body.total).toBe(1);

      // search com % literal — não deve retornar todos
      const r2 = await request(app)
        .get('/api/integrations/contacts?search=%')
        .set(apiKeyHeader(plaintextKey));
      expect(r2.status).toBe(200);
      expect(r2.body.total).toBe(0);
    });

    it('filtra por attr.plano=Anual', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'Anual',
          customAttributes: { plano: 'Anual' },
        },
      });
      await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'Mensal',
          customAttributes: { plano: 'Mensal' },
        },
      });

      const res = await request(app)
        .get('/api/integrations/contacts?attr.plano=Anual')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].nome).toBe('Anual');
    });

    it('filtra aniversariantes via attr.data_nascimento.month_day=06-28', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      // ISO format
      await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'AniversarianteISO',
          customAttributes: { data_nascimento: '1990-06-28' },
        },
      });
      // pt-BR format
      await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'AniversarianteBR',
          customAttributes: { data_nascimento: '28/06/1985' },
        },
      });
      // Outra data — não deve aparecer
      await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'OutroDia',
          customAttributes: { data_nascimento: '2000-01-15' },
        },
      });

      const res = await request(app)
        .get('/api/integrations/contacts?attr.data_nascimento.month_day=06-28')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      const nomes = res.body.data.map((c: any) => c.nome).sort();
      expect(nomes).toEqual(['AniversarianteBR', 'AniversarianteISO']);
    });

    it('attr.month_day em formato inválido: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);

      const res = await request(app)
        .get('/api/integrations/contacts?attr.x.month_day=invalido')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(400);
    });

    it('multi-tenant: lista apenas contatos da própria account', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, [
        'contacts:read',
      ]);
      await prismaTest.contact.create({
        data: { accountId: accA.account.id, nome: 'DaA' },
      });
      await prismaTest.contact.create({
        data: { accountId: accB.account.id, nome: 'DaB' },
      });

      const res = await request(app)
        .get('/api/integrations/contacts')
        .set(apiKeyHeader(plaintextKey));

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].nome).toBe('DaA');
    });

    it('respeita limit e offset', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      await prismaTest.contact.createMany({
        data: Array.from({ length: 5 }).map((_, i) => ({
          accountId: account.id,
          nome: `Contato ${i}`,
        })),
      });

      const res = await request(app)
        .get('/api/integrations/contacts?limit=2&offset=2')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(2);
      expect(res.body.data.length).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/integrations/contacts/:id
  // ─────────────────────────────────────────────────────────────────────────
  describe('PATCH /api/integrations/contacts/:id', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app)
        .patch('/api/integrations/contacts/11111111-1111-1111-1111-111111111111')
        .send({ nome: 'X' });
      expect(res.status).toBe(401);
    });

    it('id UUID inválido: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);

      const res = await request(app)
        .patch('/api/integrations/contacts/not-a-uuid')
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'X' });

      expect(res.status).toBe(400);
    });

    it('atualiza nome + normaliza telefone', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);
      const c = await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'Old' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}`)
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'New', telefone: '+55 34 99338-3017' });

      expect(res.status).toBe(200);
      expect(res.body.data.nome).toBe('New');
      expect(res.body.data.telefone).toBe(TEST_PHONE);
    });

    it('cross-tenant: contato pertence a outra account → 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, [
        'contacts:write',
      ]);
      const cB = await prismaTest.contact.create({
        data: { accountId: accB.account.id, nome: 'DaB' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${cB.id}`)
        .set(apiKeyHeader(plaintextKey))
        .send({ nome: 'X' });

      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/integrations/contacts/:id/custom-attributes
  // ─────────────────────────────────────────────────────────────────────────
  describe('PATCH /api/integrations/contacts/:id/custom-attributes', () => {
    it('faz merge (preserva keys não mencionadas)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);
      const c = await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'X',
          customAttributes: { plano: 'Mensal', nivel: 'bronze', cidade: 'Uberlândia' },
        },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ attrs: { plano: 'Anual', vip: true } });

      expect(res.status).toBe(200);
      expect(res.body.data.customAttributes).toEqual({
        plano: 'Anual',
        nivel: 'bronze',
        cidade: 'Uberlândia',
        vip: true,
      });
    });

    it('valor null remove a key (idioma n8n)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);
      const c = await prismaTest.contact.create({
        data: {
          accountId: account.id,
          nome: 'X',
          customAttributes: { plano: 'Mensal', nivel: 'bronze' },
        },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ attrs: { nivel: null } });

      expect(res.status).toBe(200);
      expect(res.body.data.customAttributes).toEqual({ plano: 'Mensal' });
    });

    it('aceita "customAttributes" como alias do body', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);
      const c = await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'X' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ customAttributes: { plano: 'Anual' } });

      expect(res.status).toBe(200);
      expect(res.body.data.customAttributes).toEqual({ plano: 'Anual' });
    });

    it('body vazio: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:write']);
      const c = await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'X' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });

    it('cross-tenant: contato em outra account → 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, [
        'contacts:write',
      ]);
      const cB = await prismaTest.contact.create({
        data: { accountId: accB.account.id, nome: 'B' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${cB.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ attrs: { plano: 'X' } });

      expect(res.status).toBe(404);
    });

    it('scope insuficiente (contacts:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);
      const c = await prismaTest.contact.create({
        data: { accountId: account.id, nome: 'X' },
      });

      const res = await request(app)
        .patch(`/api/integrations/contacts/${c.id}/custom-attributes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ attrs: { plano: 'X' } });

      expect(res.status).toBe(403);
    });
  });
});
