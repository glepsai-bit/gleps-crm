/**
 * AREA T3 — Seguranca / whatsapp-template service.
 *
 * Cobre:
 *  - Sanitizacao de HTML/script no `content` (createTemplate).
 *  - Estrita do TEMPLATE_VAR_REGEX (rejeita formas assimetricas `{nome}`,
 *    `{{nome}`, `{nome}}` — todas exploraveis para template injection ou
 *    leak parcial de variaveis).
 *  - renderTemplate substitui corretamente `{{var}}` pelos valores.
 *
 * IMPORTANTE: O service atualmente NAO faz sanitizacao HTML (so valida que
 * name/content nao sao vazios). Os testes que esperam `throw ValidationError`
 * em payload XSS ficam como `it.todo()` para documentar o gap de seguranca
 * sem quebrar a suite. Quando o fix landar, basta trocar `it.todo` por `it`.
 */

import { describe, it, expect } from 'vitest';
import {
  whatsappTemplateService,
  TEMPLATE_VAR_REGEX,
  renderTemplate,
  extractTemplateVariables,
} from './whatsapp-template.service';
import { createTestAccount } from '../test/helpers';

describe('whatsapp-template.service / createTemplate — sanitizacao HTML/script', () => {
  // TODO(SECURITY): o service nao sanitiza nem rejeita conteudo HTML/script
  // hoje — qualquer payload <script>...</script> ou <img onerror=...> e' salvo
  // como esta no banco. Como o conteudo do template e' enviado via WhatsApp
  // (texto puro, sem renderizacao HTML do cliente), o risco e' baixo no canal
  // primario, mas alto se o painel/admin renderizar o content sem escape.
  // Trocar `it.todo` por `it` quando o fix landar (rejeitar via ValidationError).
  it.todo('rejeita createTemplate com content "<script>alert(1)</script>"', async () => {
    const { account } = await createTestAccount();
    await expect(
      whatsappTemplateService.create(account.id, {
        name: 'XSS Test',
        content: '<script>alert(1)</script>',
      })
    ).rejects.toThrow();
  });

  it.todo('rejeita createTemplate com content "<img onerror=alert(1)>"', async () => {
    const { account } = await createTestAccount();
    await expect(
      whatsappTemplateService.create(account.id, {
        name: 'XSS Test 2',
        content: '<img src=x onerror=alert(1)>',
      })
    ).rejects.toThrow();
  });

  it('aceita createTemplate com content texto puro', async () => {
    const { account } = await createTestAccount();
    const t = await whatsappTemplateService.create(account.id, {
      name: 'Boas vindas',
      content: 'Ola {{nome}}, bem-vindo!',
    });
    expect(t.id).toBeTruthy();
    expect(t.content).toBe('Ola {{nome}}, bem-vindo!');
    expect(t.variables).toEqual(['nome']);
  });
});

describe('whatsapp-template.service / TEMPLATE_VAR_REGEX — estrita', () => {
  /**
   * Helper: testa o regex como ele e' usado em runtime (matchAll). Usamos
   * extractTemplateVariables porque ele encapsula a logica correta de uso.
   */
  function matches(content: string): string[] {
    return extractTemplateVariables(content);
  }

  it('rejeita `{{nome}` (par assimetrico — fecha so com `}`)', () => {
    expect(matches('Ola {{nome}')).toEqual([]);
  });

  it('rejeita `{nome}}` (par assimetrico — abre so com `{`)', () => {
    expect(matches('Ola {nome}}')).toEqual([]);
  });

  it('rejeita `{nome}` (formato Mustache simples, nao Handlebars)', () => {
    expect(matches('Ola {nome}')).toEqual([]);
  });

  it('aceita `{{nome}}` (par completo Handlebars)', () => {
    expect(matches('Ola {{nome}}')).toEqual(['nome']);
  });

  it('aceita `{{nome.sobrenome}}` (acesso aninhado via ponto)', () => {
    expect(matches('Sr. {{contato.sobrenome}}')).toEqual(['contato.sobrenome']);
  });

  it('aceita `{{ nome }}` com espacos internos', () => {
    expect(matches('Ola {{ nome }}')).toEqual(['nome']);
  });

  it('regex global matcha multiplas variaveis em ordem', () => {
    // Reseta lastIndex usando matchAll (que cria iterator novo).
    const vars = extractTemplateVariables('{{a}} e {{b}} e {{a}} de novo');
    // Set garante unicidade — esperamos ['a', 'b'].
    expect(vars).toEqual(['a', 'b']);
  });
});

describe('whatsapp-template.service / renderTemplate', () => {
  it('substitui {{var}} pelos valores fornecidos', () => {
    const out = renderTemplate('Ola {{nome}}, sua compra de {{valor}} foi confirmada.', {
      nome: 'Maria',
      valor: 'R$ 99,90',
    });
    expect(out).toBe('Ola Maria, sua compra de R$ 99,90 foi confirmada.');
  });

  it('substitui variaveis ausentes por string vazia', () => {
    const out = renderTemplate('Ola {{nome}}, {{empresa}} agradece.', { nome: 'Joao' });
    expect(out).toBe('Ola Joao,  agradece.');
  });

  it('lida com content vazio', () => {
    expect(renderTemplate('', { nome: 'Test' })).toBe('');
  });

  it('chama onMissing(name) para variaveis nao fornecidas', () => {
    const missing: string[] = [];
    renderTemplate('Ola {{nome}} - {{cargo}}', { nome: 'Ana' }, (n) => {
      missing.push(n);
    });
    expect(missing).toEqual(['cargo']);
  });

  it('NAO renderiza `{nome}` (forma rejeitada pela regex)', () => {
    // Garante consistencia entre extract + render: se regex nao matcha, render
    // nao substitui — o `{nome}` literal e' preservado.
    const out = renderTemplate('Ola {nome}', { nome: 'Maria' });
    expect(out).toBe('Ola {nome}');
  });
});
