/**
 * ETAPA D — regras puras do motor de disparos, com relógio e aleatório fixos.
 * Sem banco: render de variáveis/variantes, rodízio ponderado, cálculo de
 * nao_antes_de (janela, virada de dia, cota) e classificação de erro.
 */
import { describe, it, expect } from 'vitest';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  calcularHorarios,
  classificarErroEvolution,
  dentroDaJanela,
  distribuirPorNumero,
  estimarDias,
  proximaAbertura,
  renderizarMensagem,
  renderizarTexto,
  variaveisDoContato,
  variaveisUsadas,
  type CapacidadeDoNumero,
} from './disparo/regras';

const FUSO = 'America/Sao_Paulo';
/** Instante no fuso de SP: "2026-10-07 09:00" → Date UTC correspondente. */
const sp = (iso: string) => fromZonedTime(iso, FUSO);
const horaSp = (d: Date) => {
  const z = toZonedTime(d, FUSO);
  return `${String(z.getHours()).padStart(2, '0')}:${String(z.getMinutes()).padStart(2, '0')}`;
};
const diaSp = (d: Date) => toZonedTime(d, FUSO).getDate();

describe('render de variáveis e variantes', () => {
  it('troca {{nome}} {{primeiro_nome}} {{empresa}} e o {nome} legado', () => {
    const v = variaveisDoContato('Maria da Silva', 'Clínica Vida');
    expect(renderizarTexto('Oi {{primeiro_nome}}, tudo bem? Aqui é da {{empresa}}. {nome}', v)).toBe(
      'Oi Maria, tudo bem? Aqui é da Clínica Vida. Maria da Silva'
    );
  });

  it('variável sem valor some e não deixa espaço duplo nem vírgula solta', () => {
    expect(renderizarTexto('Olá {{nome}}, temos novidade', variaveisDoContato(null))).toBe('Olá, temos novidade');
    expect(renderizarTexto('Oi {{nome}} tudo bem?', {})).toBe('Oi tudo bem?');
  });

  it('variante N % total, com as variáveis do contato', () => {
    const variantes = ['B {{nome}}', 'C {{nome}}'];
    expect(renderizarMensagem('A {{nome}}', variantes, 0, { nome: 'Ana' })).toBe('A Ana');
    expect(renderizarMensagem('A {{nome}}', variantes, 1, { nome: 'Ana' })).toBe('B Ana');
    expect(renderizarMensagem('A {{nome}}', variantes, 2, { nome: 'Ana' })).toBe('C Ana');
    expect(renderizarMensagem('A {{nome}}', variantes, 3, { nome: 'Ana' })).toBe('A Ana');
  });

  it('variantes inválidas (não string / vazias) ficam de fora do rodízio', () => {
    expect(renderizarMensagem('A', ['', 7, null, 'B'], 1, {})).toBe('B');
    expect(renderizarMensagem('A', null, 5, {})).toBe('A');
  });

  it('variaveisUsadas lista as chaves do texto', () => {
    expect(Array.from(variaveisUsadas('Oi {{ nome }}, da {{empresa}}')).sort()).toEqual(['empresa', 'nome']);
  });
});

describe('rodízio ponderado entre números', () => {
  const cap = (inboxId: string, restantesHoje: number, limiteDiario = 200): CapacidadeDoNumero => ({
    inboxId,
    status: 'pronto',
    dia: 31,
    limiteDiario,
    restantesHoje,
  });

  it('distribui proporcional à capacidade restante (150 × 50 → 3:1)', () => {
    const r = distribuirPorNumero(40, [cap('A', 150), cap('B', 50)]);
    const a = r.filter((x) => x === 'A').length;
    const b = r.filter((x) => x === 'B').length;
    expect(a).toBe(30);
    expect(b).toBe(10);
    // Intercalado, não em bloco: os primeiros quatro são A A A B ou parecido.
    expect(new Set(r.slice(0, 4)).size).toBe(2);
  });

  it('todos com 0 restantes → ponderação igual', () => {
    const r = distribuirPorNumero(10, [cap('A', 0), cap('B', 0)]);
    expect(r.filter((x) => x === 'A').length).toBe(5);
    expect(r.filter((x) => x === 'B').length).toBe(5);
  });

  it('número com 0 no meio de outros com capacidade não recebe', () => {
    const r = distribuirPorNumero(10, [cap('A', 100), cap('B', 0)]);
    expect(r.every((x) => x === 'A')).toBe(true);
  });

  it('contato preso ao número vai pra onde já conversou, e conta na cota dele', () => {
    const r = distribuirPorNumero(4, [cap('A', 100), cap('B', 100)], ['B', 'B', null, null]);
    expect(r[0]).toBe('B');
    expect(r[1]).toBe('B');
    // Os dois livres compensam: vão pra A.
    expect(r[2]).toBe('A');
    expect(r[3]).toBe('A');
  });

  it('preso a um número que não está na lista é ignorado', () => {
    const r = distribuirPorNumero(2, [cap('A', 10)], ['Z', 'Z']);
    expect(r).toEqual(['A', 'A']);
  });
});

describe('janela 08h–20h no fuso da conta', () => {
  it('dentro/fora da janela', () => {
    expect(dentroDaJanela(sp('2026-10-07 08:00'), FUSO)).toBe(true);
    expect(dentroDaJanela(sp('2026-10-07 19:59'), FUSO)).toBe(true);
    expect(dentroDaJanela(sp('2026-10-07 20:00'), FUSO)).toBe(false);
    expect(dentroDaJanela(sp('2026-10-07 07:59'), FUSO)).toBe(false);
  });

  it('próxima abertura: antes das 8 → 8h de hoje; 20h+ → 8h de amanhã; dentro → a própria', () => {
    expect(proximaAbertura(sp('2026-10-07 06:30'), FUSO)).toEqual(sp('2026-10-07 08:00'));
    expect(proximaAbertura(sp('2026-10-07 21:00'), FUSO)).toEqual(sp('2026-10-08 08:00'));
    const dentro = sp('2026-10-07 10:15');
    expect(proximaAbertura(dentro, FUSO)).toBe(dentro);
  });
});

describe('cálculo de nao_antes_de', () => {
  const cotas = [{ inboxId: 'A', restantesHoje: 200, limiteDiario: 200 }];
  // Aleatório fixo no meio: jitter de 40 s (20 + 0.5 * 41 = 40.5 → 40).
  const meio = () => 0.5;

  it('escalona 20–60 s a partir do início, o primeiro sai na hora', () => {
    const inicio = sp('2026-10-07 09:00');
    const h = calcularHorarios(inicio, FUSO, ['A', 'A', 'A'], cotas, { aleatorio: Math.random });
    expect(h[0]).toEqual(inicio);
    for (let i = 1; i < h.length; i++) {
      const gap = (h[i].getTime() - h[i - 1].getTime()) / 1000;
      expect(gap).toBeGreaterThanOrEqual(20);
      expect(gap).toBeLessThanOrEqual(60);
    }
  });

  it('dois números andam em paralelo (cursores independentes)', () => {
    const inicio = sp('2026-10-07 09:00');
    const h = calcularHorarios(inicio, FUSO, ['A', 'B', 'A', 'B'], [
      ...cotas,
      { inboxId: 'B', restantesHoje: 200, limiteDiario: 200 },
    ], { aleatorio: meio });
    expect(h[0]).toEqual(inicio);
    expect(h[1]).toEqual(inicio);
    expect(h[2].getTime() - inicio.getTime()).toBe(40_000);
    expect(h[3].getTime() - inicio.getTime()).toBe(40_000);
  });

  it('início fora da janela (21h) começa às 08h do dia seguinte', () => {
    const h = calcularHorarios(sp('2026-10-07 21:00'), FUSO, ['A', 'A'], cotas, { aleatorio: meio });
    expect(h[0]).toEqual(sp('2026-10-08 08:00'));
    expect(h[1]).toEqual(sp('2026-10-08 08:00:40'));
  });

  it('passou das 20h no meio da fila → o resto vai pras 08h de amanhã', () => {
    const inicio = sp('2026-10-07 19:59:00');
    const h = calcularHorarios(inicio, FUSO, ['A', 'A', 'A'], cotas, { aleatorio: meio });
    expect(horaSp(h[0])).toBe('19:59');
    expect(horaSp(h[1])).toBe('19:59'); // 19:59:40 ainda dentro
    expect(h[2]).toEqual(sp('2026-10-08 08:00')); // 20:00:20 → amanhã
  });

  it('cota de hoje estourada → excedente às 08h do dia seguinte, com a cota diária', () => {
    const inicio = sp('2026-10-07 09:00');
    const h = calcularHorarios(inicio, FUSO, ['A', 'A', 'A', 'A', 'A'], [{ inboxId: 'A', restantesHoje: 2, limiteDiario: 2 }], {
      aleatorio: meio,
    });
    expect(diaSp(h[0])).toBe(7);
    expect(diaSp(h[1])).toBe(7);
    expect(h[2]).toEqual(sp('2026-10-08 08:00'));
    expect(diaSp(h[3])).toBe(8);
    expect(h[4]).toEqual(sp('2026-10-09 08:00'));
  });

  it('restantesHoje 0 com limite diário → tudo amanhã', () => {
    const h = calcularHorarios(sp('2026-10-07 09:00'), FUSO, ['A'], [{ inboxId: 'A', restantesHoje: 0, limiteDiario: 50 }]);
    expect(h[0]).toEqual(sp('2026-10-08 08:00'));
  });

  it('limiteDiario 0 (pausado) não trava: usa o limite de não aquecido', () => {
    const h = calcularHorarios(sp('2026-10-07 09:00'), FUSO, ['A', 'A'], [{ inboxId: 'A', restantesHoje: 0, limiteDiario: 0 }], {
      aleatorio: meio,
    });
    expect(h[0]).toEqual(sp('2026-10-08 08:00'));
    expect(h[1]).toEqual(sp('2026-10-08 08:00:40'));
  });

  it('criado às 21h: a cota de "hoje" não vale, já começa com a diária', () => {
    const h = calcularHorarios(sp('2026-10-07 21:00'), FUSO, ['A', 'A', 'A'], [{ inboxId: 'A', restantesHoje: 0, limiteDiario: 3 }], {
      aleatorio: meio,
    });
    expect(h.map(diaSp)).toEqual([8, 8, 8]);
  });

  it('estimarDias: hoje cabe o restante, depois a diária', () => {
    expect(estimarDias(0, cotas)).toBe(0);
    expect(estimarDias(150, [{ inboxId: 'A', restantesHoje: 200, limiteDiario: 200 }])).toBe(1);
    expect(estimarDias(450, [{ inboxId: 'A', restantesHoje: 50, limiteDiario: 200 }])).toBe(3);
    expect(estimarDias(60, [{ inboxId: 'A', restantesHoje: 0, limiteDiario: 0 }])).toBe(3); // 50/dia
  });
});

describe('classificação de erro da Evolution', () => {
  it('infra: rede, timeout, 5xx, 401/403, instância desconectada', () => {
    expect(classificarErroEvolution(new Error('Falha na comunicação com Evolution API: fetch failed'))).toBe('infra');
    expect(classificarErroEvolution(new Error('Evolution API retornou status 502'))).toBe('infra');
    expect(classificarErroEvolution(new Error('Evolution API retornou status 401'))).toBe('infra');
    expect(classificarErroEvolution(new Error('The operation was aborted due to timeout'))).toBe('infra');
    expect(classificarErroEvolution(new Error('instância desconectada'))).toBe('infra');
    expect(classificarErroEvolution(undefined)).toBe('infra');
  });

  it('número: 4xx de destino e as palavras conhecidas', () => {
    expect(classificarErroEvolution(new Error('Evolution API retornou status 400'))).toBe('numero');
    expect(classificarErroEvolution(new Error('Evolution API retornou status 404'))).toBe('numero');
    expect(classificarErroEvolution(new Error('number is not on whatsapp'))).toBe('numero');
    expect(classificarErroEvolution(new Error('{"exists": false}'))).toBe('numero');
    expect(classificarErroEvolution(new Error('invalid jid'))).toBe('numero');
  });
});
