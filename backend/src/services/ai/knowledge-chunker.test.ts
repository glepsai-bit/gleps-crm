/**
 * T-027 Fase 1 — testes do chunker.
 *
 * É a peça que decide a qualidade do RAG: trecho fora do limite quebra o
 * embedding, e sobreposição mal feita ou faz o loop nunca avançar ou perde a
 * frase que cai na fronteira entre parágrafos.
 */

import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens } from './knowledge-chunker';

const paragraph = (n: number, chars: number) =>
  `P${n} ` + 'palavra '.repeat(Math.ceil(chars / 8)).slice(0, chars);

describe('chunkText', () => {
  it('texto curto vira um único trecho', () => {
    const chunks = chunkText('A Mychooice atende academias e clínicas.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordem).toBe(0);
    expect(chunks[0].content).toContain('Mychooice');
  });

  it('texto vazio ou só espaço não gera trecho', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('respeita o teto de tokens por trecho', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i, 600)).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Tolerância de 1 peça: o buffer só corta ANTES de adicionar a próxima,
      // então um parágrafo que cabe sozinho pode encostar no teto.
      expect(c.tokens).toBeLessThanOrEqual(200 + estimateTokens(paragraph(0, 600)));
    }
  });

  it('numera os trechos em sequência a partir de 0', () => {
    const text = Array.from({ length: 8 }, (_, i) => paragraph(i, 500)).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 150, overlapTokens: 20 });
    expect(chunks.map((c) => c.ordem)).toEqual(chunks.map((_, i) => i));
  });

  it('sobrepõe conteúdo entre trechos vizinhos', () => {
    const text = ['ALFA ' + 'a'.repeat(400), 'BETA ' + 'b'.repeat(400), 'GAMA ' + 'c'.repeat(400)].join(
      '\n\n'
    );
    const chunks = chunkText(text, { maxTokens: 150, overlapTokens: 120 });

    expect(chunks.length).toBeGreaterThan(1);
    // O rabo do trecho anterior reaparece no começo do seguinte.
    const overlapped = chunks.some((c, i) => i > 0 && chunks[i - 1].content.includes(c.content.slice(0, 30)));
    expect(overlapped).toBe(true);
  });

  it('parágrafo maior que a sobreposição não trava o loop', () => {
    // Regressão do bug clássico: se o carry recarrega um parágrafo maior que o
    // orçamento de overlap, o buffer nunca esvazia e o chunker roda pra sempre.
    const huge = 'X'.repeat(4000);
    const text = [huge, huge, huge].join('\n\n');

    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 90 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(500); // terminou — não explodiu
  });

  it('frase única gigante é cortada em vez de estourar o limite', () => {
    const semQuebra = 'y'.repeat(5000); // sem ponto, sem \n\n
    const chunks = chunkText(semQuebra, { maxTokens: 100, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100 * 4);
    }
  });

  it('preserva a ordem do conteúdo original', () => {
    const text = ['PRIMEIRO bloco.', 'SEGUNDO bloco.', 'TERCEIRO bloco.'].join('\n\n');
    const joined = chunkText(text, { maxTokens: 5, overlapTokens: 0 })
      .map((c) => c.content)
      .join(' ');

    expect(joined.indexOf('PRIMEIRO')).toBeLessThan(joined.indexOf('SEGUNDO'));
    expect(joined.indexOf('SEGUNDO')).toBeLessThan(joined.indexOf('TERCEIRO'));
  });
});

// ============================================
// Tabelas — o cabeçalho não pode se perder
// ============================================

const tabelaPrecos = (linhas: number) =>
  ['| Plano | Mensal | Anual |', ...Array.from({ length: linhas }, (_, i) => `| Plano ${i + 1} Empresarial Plus | R$ ${500 + i * 10},00 | R$ ${5000 + i * 100},00 |`)].join('\n');

describe('chunkText — tabelas', () => {
  it('tabela de 40 linhas: ≥3 trechos, todos começam pelo cabeçalho, nenhum corte no meio de linha', () => {
    const tabela = tabelaPrecos(40);
    const linhasOriginais = new Set(tabela.split('\n'));
    const chunks = chunkText(tabela, { maxTokens: 120, overlapTokens: 30 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.content.split('\n')[0]).toBe('| Plano | Mensal | Anual |');
      // Só corte em fim de linha: cada linha do trecho é uma linha inteira da tabela.
      for (const linha of c.content.split('\n')) expect(linhasOriginais.has(linha)).toBe(true);
      expect(c.tokens).toBeLessThanOrEqual(120);
    }
    // Nenhuma linha ficou de fora.
    const vistas = new Set(chunks.flatMap((c) => c.content.split('\n')));
    for (const linha of linhasOriginais) expect(vistas.has(linha)).toBe(true);
  });

  it('tabela markdown: a linha |---|---| vai junto com o cabeçalho', () => {
    const md = ['| Plano | Mensal |', '|---|---|', ...Array.from({ length: 30 }, (_, i) => `| P${i} | ${i * 100} |`)].join('\n');
    const chunks = chunkText(md, { maxTokens: 40, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.startsWith('| Plano | Mensal |\n|---|---|\n')).toBe(true);
  });

  it('CSV com ponto-e-vírgula também é tabela', () => {
    const csv = ['nome;email;cidade', ...Array.from({ length: 30 }, (_, i) => `Cliente ${i};c${i}@x.com;Cidade ${i}`)].join('\n');
    const chunks = chunkText(csv, { maxTokens: 40, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.split('\n')[0]).toBe('nome;email;cidade');
  });

  it('tabela pequena que cabe no trecho fica inteira junto do parágrafo que a apresenta', () => {
    const texto = `Nossos planos:\n\n${tabelaPrecos(3)}\n\nValores sem impostos.`;
    const chunks = chunkText(texto);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Nossos planos:');
    expect(chunks[0].content).toContain('| Plano 3 Empresarial Plus');
    expect(chunks[0].content).toContain('Valores sem impostos.');
  });

  it('a continuação da tabela não herda sobreposição de prosa: o cabeçalho é a primeira linha', () => {
    const texto = `${'Introdução longa. '.repeat(20)}\n\n${tabelaPrecos(40)}\n\nObservação final.`;
    const chunks = chunkText(texto, { maxTokens: 120, overlapTokens: 60 });

    const comTabela = chunks.filter((c) => c.content.includes('Empresarial Plus'));
    expect(comTabela.length).toBeGreaterThanOrEqual(3);
    // A partir do segundo trecho da tabela, a primeira linha é o cabeçalho —
    // não o rabo da introdução nem linhas do trecho anterior.
    for (const c of comTabela.slice(1)) expect(c.content.split('\n')[0]).toBe('| Plano | Mensal | Anual |');
    // E a prosa depois da tabela não perdeu.
    expect(chunks.some((c) => c.content.includes('Observação final.'))).toBe(true);
  });

  it('duas linhas com | não são tabela (mínimo 3) — prosa segue como antes', () => {
    const texto = 'a | b\nc | d\n\nParágrafo.';
    expect(chunkText(texto)).toEqual([{ content: texto, ordem: 0, tokens: estimateTokens(texto) }]);
  });

  it('linhas com vírgula em prosa (2 colunas) não viram tabela', () => {
    const texto = ['Vendemos arroz, feijão.', 'Também batata, cebola.', 'E alho, sal.'].join('\n');
    const chunks = chunkText(texto, { maxTokens: 10, overlapTokens: 0 });
    // Se fosse tabela, todo trecho começaria pela "linha de cabeçalho".
    expect(chunks.filter((c) => c.content.startsWith('Vendemos')).length).toBe(1);
  });
});

describe('chunkText — regressão de prosa', () => {
  // Assinatura (ordem, tokens, tamanho, começo, fim) de cada trecho gerada com
  // o chunker ANTES da detecção de tabela. Texto sem tabela tem que sair
  // idêntico: a mudança só pode afetar blocos tabulares.
  const texto = [
    'Sobre a Mychooice',
    'A Mychooice atende academias e clínicas. Oferece três planos: Essencial, Pro e Premium. O Essencial custa R$ 500 por mês! Vale a pena?',
    paragraph(1, 700),
    'Horário de atendimento: segunda a sexta, das 8h às 18h. Sábado, das 9h às 13h.',
    paragraph(2, 900),
    'Fim.',
  ].join('\n\n');

  it('saída idêntica à do chunker anterior (maxTokens 220 / overlap 40)', () => {
    const assinatura = chunkText(texto, { maxTokens: 220, overlapTokens: 40 }).map((c) => [
      c.ordem,
      c.tokens,
      c.content.length,
      c.content.slice(0, 24),
      c.content.slice(-24),
    ]);
    expect(assinatura).toEqual([
      [0, 215, 858, 'Sobre a Mychooice\n\nA Myc', 'vra palavra palavra pala'],
      [1, 20, 78, 'Horário de atendimento: ', '. Sábado, das 9h às 13h.'],
      [2, 240, 960, 'Horário de atendimento: ', 'ra palavra palavra palav'],
      [3, 8, 29, 'ra palavra palavra pala\n', 'lavra palavra pala\n\nFim.'],
    ]);
  });

  it('saída idêntica à do chunker anterior (padrões)', () => {
    expect(chunkText(texto).map((c) => [c.ordem, c.tokens, c.content.length])).toEqual([[0, 463, 1849]]);
  });
});
