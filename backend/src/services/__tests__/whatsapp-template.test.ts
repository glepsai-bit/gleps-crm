/**
 * Testes unitários — whatsapp-template.service
 * QA T-022 Sprint 2 (2026-06-23)
 *
 * Cobre:
 *  - render(): substituição de variáveis, variável ausente → string vazia, edge cases
 *  - A discrepância de regex entre whatsapp-template.service ({nome})
 *    e whatsapp-campaign.service ({{nome}} e {nome}) é registrada aqui como teste de documentação.
 */

import { describe, it, expect } from 'vitest';

// ── helpers copiados do service (não exportados) ──────────────────────────
// Replicados aqui para testar isoladamente sem precisar de Prisma.
const VARIABLE_REGEX_TEMPLATE = /\{(\w+)\}/g;

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(VARIABLE_REGEX_TEMPLATE, (_match, name: string) => {
    const value = variables[name];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

function extractVariables(content: string): string[] {
  const found = new Set<string>();
  const ordered: string[] = [];
  const matches = content.matchAll(VARIABLE_REGEX_TEMPLATE);
  for (const match of matches) {
    const name = match[1];
    if (!found.has(name)) {
      found.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

// ── regex do whatsapp-campaign.service (diferente!) ──────────────────────
const CAMPAIGN_REGEX = /\{\{?\s*([\w.]+)\s*\}?\}/g;

function renderCampaign(content: string, variables: Record<string, string> = {}): string {
  if (!content) return '';
  return content.replace(CAMPAIGN_REGEX, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

// ─────────────────────────────────────────────────────────────────────────

describe('whatsapp-template.service — render()', () => {
  it('substitui variável simples {nome}', () => {
    const result = renderTemplate('Olá, {nome}!', { nome: 'João Silva' });
    expect(result).toBe('Olá, João Silva!');
  });

  it('substitui múltiplas variáveis distintas', () => {
    const result = renderTemplate('Olá, {nome}! Seu valor é R$ {valor}.', {
      nome: 'Maria',
      valor: '199,90',
    });
    expect(result).toBe('Olá, Maria! Seu valor é R$ 199,90.');
  });

  it('variável ausente vira string vazia (não quebra)', () => {
    const result = renderTemplate('Olá, {nome}! Seu plano: {plano}.', { nome: 'Pedro' });
    expect(result).toBe('Olá, Pedro! Seu plano: .');
  });

  it('conteúdo sem placeholder retorna intacto', () => {
    const content = 'Bom dia, seja bem-vindo ao FitPark!';
    expect(renderTemplate(content, {})).toBe(content);
  });

  it('mesma variável repetida é substituída nas duas ocorrências', () => {
    const result = renderTemplate('{nome} disse: olá, meu nome é {nome}.', { nome: 'Ana' });
    expect(result).toBe('Ana disse: olá, meu nome é Ana.');
  });

  it('variável com valor numérico (convertido para string)', () => {
    const result = renderTemplate('Você tem {dias} dias restantes.', { dias: '30' });
    expect(result).toBe('Você tem 30 dias restantes.');
  });

  it('template vazio retorna string vazia', () => {
    expect(renderTemplate('', { nome: 'X' })).toBe('');
  });
});

describe('whatsapp-template.service — extractVariables()', () => {
  it('extrai variáveis na ordem de primeira aparição', () => {
    const vars = extractVariables('Olá, {nome}! Seu valor é R$ {valor}. Obrigado, {nome}!');
    // {nome} aparece primeiro, {valor} segundo; duplicatas ignoradas
    expect(vars).toEqual(['nome', 'valor']);
  });

  it('retorna array vazio se não houver placeholders', () => {
    expect(extractVariables('Mensagem sem variáveis')).toEqual([]);
  });

  it('extrai múltiplas variáveis distintas', () => {
    const vars = extractVariables('{a} {b} {c}');
    expect(vars).toEqual(['a', 'b', 'c']);
  });
});

describe('DIVERGÊNCIA DE REGEX — template.service vs campaign.service', () => {
  /**
   * BUG-1 (MÉDIA): renderTemplate do whatsapp-template.service usa regex /\{(\w+)\}/g
   * que captura apenas {variavel}.
   * renderTemplate do whatsapp-campaign.service usa /\{\{?\s*([\w.]+)\s*\}?\}/g
   * que aceita {{variavel}}, { variavel }, e {variavel.subchave}.
   *
   * Isso significa que:
   * - Um template criado com {nome} funcionará em ambos (OK).
   * - Um template criado com {{nome}} (Handlebars-style) funcionará apenas no campaign service.
   * - A UI de preview (AdminWhatsappTemplatesPage) usa o método render() do backend
   *   via endpoint de renderização — que usa a regex do template.service.
   * - O send real (whatsapp-campaign.service) usa a regex do campaign.service.
   * - Resultado: preview pode mostrar resultado diferente do que será enviado.
   *
   * Recomendação: unificar a regex nos dois services.
   */

  it('DOCUMENTO: {nome} funciona nos dois renders (baseline OK)', () => {
    const templateResult = renderTemplate('Olá, {nome}', { nome: 'João' });
    const campaignResult = renderCampaign('Olá, {nome}', { nome: 'João' });
    expect(templateResult).toBe(campaignResult); // ambos produzem 'Olá, João'
  });

  it('DOCUMENTO: {{nome}} — comportamento real verificado em testes', () => {
    const templateResult = renderTemplate('Olá, {{nome}}', { nome: 'João' });
    const campaignResult = renderCampaign('Olá, {{nome}}', { nome: 'João' });
    // RESULTADO REAL (descoberto nos testes 2026-06-23):
    // A regex /\{(\w+)\}/g do template.service captura {nome} dentro de {{nome}}
    // porque o primeiro { extra é ignorado pelo match e o resultado é '{João}' (o { extra sobra).
    // Isso difere do campaign.service que produce 'Olá, João' (limpo).
    // AMBOS substituem {nome}, porém o template.service deixa o '{' extra no output.
    expect(templateResult).toBe('Olá, {João}'); // '{' extra vaza — BUG cosmético
    expect(campaignResult).toBe('Olá, João');   // correto
    // Se alguém criar template com {{nome}}, o preview (template.service) mostra '{João}'
    // mas o envio real (campaign.service) envia 'João'. Preview incorreto → UX confusa.
    // Recomendação: unificar regex usando a do campaign.service em ambos.
  });
});
