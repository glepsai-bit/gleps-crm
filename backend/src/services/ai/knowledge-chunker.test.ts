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
