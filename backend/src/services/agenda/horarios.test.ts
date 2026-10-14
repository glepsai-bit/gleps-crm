/**
 * T-039 — a aritmética de horários, sem banco.
 *
 * Tudo em America/Sao_Paulo (UTC-3), que é onde o erro de fuso aparece: 09:00
 * civil é 12:00Z. Um teste que passasse em UTC e falhasse em São Paulo seria
 * exatamente o bug que a profissional descobre na segunda de manhã.
 */

import { describe, it, expect } from 'vitest';
import {
  calcularHorarios,
  horarioValido,
  minutosDoDia,
  periodoDoDia,
  rotuloDoHorario,
  validarHorarios,
  agoraPorExtenso,
  espacados,
  selecionarHorarios,
  resolverDia,
  janelaDoDiaCivil,
  somarDiasCivis,
} from './horarios';

const TZ = 'America/Sao_Paulo';
// Quarta-feira, 30/09/2026, 10:00 em São Paulo.
const AGORA = new Date('2026-09-30T13:00:00Z');
const sp = (iso: string) => new Date(iso + '-03:00');

const base = {
  agora: AGORA,
  timezone: TZ,
  horarios: { '4': [{ inicio: '09:00', fim: '12:00' }] }, // quinta
  duracaoMinutos: 30,
  intervaloMinutos: 0,
  passoMinutos: 30,
  antecedenciaMinimaMinutos: 120,
  janelaMaximaDias: 30,
  de: AGORA,
  ate: new Date('2026-10-03T03:00:00Z'),
  ocupados: [],
};

describe('calcularHorarios', () => {
  it('fatia o expediente no fuso da conta e cabe a duração na faixa', () => {
    const r = calcularHorarios(base);
    // Quinta 01/10: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30 (12:00 não cabe 30 min).
    expect(r.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T09:30:00').toISOString(),
      sp('2026-10-01T10:00:00').toISOString(),
      sp('2026-10-01T10:30:00').toISOString(),
      sp('2026-10-01T11:00:00').toISOString(),
      sp('2026-10-01T11:30:00').toISOString(),
    ]);
    expect(r[0].fim.toISOString()).toBe(sp('2026-10-01T09:30:00').toISOString());
  });

  it('remove o que bate em ocupação e respeita a folga dos dois lados', () => {
    const r = calcularHorarios({
      ...base,
      intervaloMinutos: 15,
      ocupados: [{ inicio: sp('2026-10-01T10:00:00'), fim: sp('2026-10-01T10:30:00') }],
    });
    // Ocupado 10:00–10:30 com folga 15 → bloqueia 09:45–10:45. Caem 09:30 (9:30–10:00
    // encosta em 09:45), 10:00 e 10:30 (10:30–11:00 encosta em 10:45).
    expect(r.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T11:00:00').toISOString(),
      sp('2026-10-01T11:30:00').toISOString(),
    ]);
  });

  it('não oferece antes da antecedência mínima nem depois da janela máxima', () => {
    // Expediente HOJE (quarta) 09:00–18:00, agora 10:00, antecedência 2h → só a partir de 12:00.
    const r = calcularHorarios({
      ...base,
      horarios: { '3': [{ inicio: '09:00', fim: '18:00' }] },
      ate: new Date('2026-10-01T03:00:00Z'),
    });
    expect(r[0].inicio.toISOString()).toBe(sp('2026-09-30T12:00:00').toISOString());

    const curta = calcularHorarios({ ...base, janelaMaximaDias: 1 });
    // Janela de 1 dia acaba quinta 10:00 → só o que TERMINA até lá.
    expect(curta.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T09:30:00').toISOString(),
    ]);
  });

  it('um serviço mais longo que a faixa não gera horário', () => {
    expect(calcularHorarios({ ...base, duracaoMinutos: 200 })).toHaveLength(0);
  });

  it('evento de dia inteiro (00:00–24:00) apaga o dia', () => {
    const r = calcularHorarios({
      ...base,
      ocupados: [{ inicio: sp('2026-10-01T00:00:00'), fim: sp('2026-10-02T00:00:00') }],
    });
    expect(r).toHaveLength(0);
  });
});

describe('horarioValido', () => {
  it('aceita um horário da grade e recusa um fora dela', () => {
    expect(horarioValido(base, sp('2026-10-01T09:30:00'))).toBe(true);
    // 09:40 não está no passo de 30 min.
    expect(horarioValido(base, sp('2026-10-01T09:40:00'))).toBe(false);
    // Sexta não tem expediente.
    expect(horarioValido(base, sp('2026-10-02T09:00:00'))).toBe(false);
  });

  it('recusa horário ocupado', () => {
    const p = { ...base, ocupados: [{ inicio: sp('2026-10-01T09:00:00'), fim: sp('2026-10-01T10:00:00') }] };
    expect(horarioValido(p, sp('2026-10-01T09:30:00'))).toBe(false);
    expect(horarioValido(p, sp('2026-10-01T10:00:00'))).toBe(true);
  });
});

describe('rótulos e períodos', () => {
  it('fala o horário como o lead lê, no fuso da conta', () => {
    expect(rotuloDoHorario(sp('2026-10-01T14:00:00'), TZ)).toBe('quinta-feira, 01/10 às 14:00');
    expect(periodoDoDia(sp('2026-10-01T11:59:00'), TZ)).toBe('manha');
    // Meio-dia é período próprio: "de tarde" pro lead é depois do almoço.
    expect(periodoDoDia(sp('2026-10-01T12:00:00'), TZ)).toBe('meio_dia');
    expect(periodoDoDia(sp('2026-10-01T12:30:00'), TZ)).toBe('meio_dia');
    expect(periodoDoDia(sp('2026-10-01T13:00:00'), TZ)).toBe('tarde');
    expect(periodoDoDia(sp('2026-10-01T14:00:00'), TZ)).toBe('tarde');
    expect(periodoDoDia(sp('2026-10-01T18:00:00'), TZ)).toBe('noite');
    expect(agoraPorExtenso(AGORA, TZ)).toBe('quarta-feira, 30/09/2026, 10:00 (America/Sao_Paulo)');
  });

  it('minutosDoDia lê HH:MM e recusa lixo', () => {
    expect(minutosDoDia('09:30')).toBe(570);
    expect(minutosDoDia('9:05')).toBe(545);
    expect(minutosDoDia('25:00')).toBeNull();
    expect(minutosDoDia('abc')).toBeNull();
  });
});

/*
  ETAPA G — o que OFERECER dentre os livres.

  O piloto devolvia 08:00, 08:30 e 09:00 pra quem pediu "de tarde". Agora a
  seleção espalha pelo período pedido, aproxima do horário desejado, e sem
  pedido traz 2 de manhã + 2 à tarde dos próximos dias.
*/
describe('selecionarHorarios', () => {
  // Quinta 01/10 e sexta 02/10, 08:00–18:00 de 30 em 30 (20 por dia).
  const grade = (dia: string) =>
    Array.from({ length: 20 }, (_, i) => {
      const h = 8 + Math.floor(i / 2);
      const m = i % 2 === 0 ? '00' : '30';
      return { inicio: sp(`${dia}T${String(h).padStart(2, '0')}:${m}:00`) };
    });
  const todos = [...grade('2026-10-01'), ...grade('2026-10-02'), ...grade('2026-10-05')];
  const hora = (h: { inicio: Date }) => rotuloDoHorario(h.inicio, TZ).slice(-5);

  it('espacados: primeiro, último e o meio — nunca só os primeiros', () => {
    expect(espacados([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
    expect(espacados([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(espacados([1, 2, 3], 1)).toEqual([1]);
    expect(espacados([], 3)).toEqual([]);
  });

  it('período "tarde" com janela 08–18: tudo ≥ 13:00, espalhado, até 8, em rodadas por dia', () => {
    const r = selecionarHorarios(todos, { tz: TZ, limite: 8, periodo: 'tarde', porDia: 3 });
    expect(r).toHaveLength(8);
    expect(r.every((h) => Number(hora(h).slice(0, 2)) >= 13)).toBe(true);
    // 3 por dia espalhados (13:00, o meio 15:30, 17:30), 3 dias → 9, cortado em 8 por rodadas.
    const porDia = new Map<string, string[]>();
    for (const h of r) {
      const d = rotuloDoHorario(h.inicio, TZ).slice(0, 20);
      porDia.set(d, [...(porDia.get(d) ?? []), hora(h)]);
    }
    expect(Array.from(porDia.values())[0]).toEqual(['13:00', '15:30', '17:30']);
    expect(porDia.size).toBe(3);
  });

  it('"manhã" exclui o meio-dia', () => {
    const r = selecionarHorarios(todos, { tz: TZ, limite: 20, periodo: 'manha', porDia: 20 });
    expect(r.every((h) => Number(hora(h).slice(0, 2)) < 12)).toBe(true);
  });

  it('horário desejado 15:00: o mais próximo de cada dia primeiro (rodadas), depois o segundo; saída cronológica', () => {
    const r = selecionarHorarios(todos, { tz: TZ, limite: 4, horarioDesejadoMinutos: 15 * 60, porDia: 2 });
    // Rodada 1: 15:00 dos 3 dias; rodada 2: 14:30 do primeiro dia. Ordenado no tempo.
    expect(r.map(hora)).toEqual(['14:30', '15:00', '15:00', '15:00']);
    expect(r[0].inicio < r[1].inicio && r[1].inicio < r[2].inicio).toBe(true);
  });

  it('sem pedido: 2 de manhã + 2 à tarde de cada um dos 3 próximos dias', () => {
    const r = selecionarHorarios([...todos, ...grade('2026-10-06')], { tz: TZ, limite: 12, quotaPorPeriodo: { manha: 2, tarde: 2 }, diasMaximos: 3 });
    expect(r).toHaveLength(12);
    const dias = new Set(r.map((h) => rotuloDoHorario(h.inicio, TZ).slice(0, 20)));
    expect(dias.size).toBe(3);
    expect(r.slice(0, 4).map(hora)).toEqual(['08:00', '11:30', '13:00', '17:30']);
  });

  it('sem pedido com os 4 períodos: quem só atende à noite (ou só ao meio-dia) também recebe opções', () => {
    const quota = { manha: 2, meio_dia: 1, tarde: 2, noite: 2 };
    const faixa = (dia: string, de: number, ate: number) =>
      Array.from({ length: (ate - de) * 2 }, (_, i) => {
        const h = de + Math.floor(i / 2);
        return { inicio: sp(`${dia}T${String(h).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}:00`) };
      });
    const dias = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];

    const noite = selecionarHorarios(dias.flatMap((d) => faixa(d, 19, 22)), { tz: TZ, limite: 12, quotaPorPeriodo: quota, porDia: 4, diasMaximos: 3 });
    expect(noite.map(hora)).toEqual(['19:00', '21:30', '19:00', '21:30', '19:00', '21:30']);

    const meioDia = selecionarHorarios(dias.flatMap((d) => faixa(d, 12, 13)), { tz: TZ, limite: 12, quotaPorPeriodo: quota, porDia: 4, diasMaximos: 3 });
    expect(meioDia.map(hora)).toEqual(['12:00', '12:00', '12:00']);
  });

  it('sem pedido: com manhã, meio-dia e tarde o dia é aparado ESPALHANDO — o fim da tarde não some', () => {
    const quota = { manha: 2, meio_dia: 1, tarde: 2, noite: 2 };
    const r = selecionarHorarios(todos, { tz: TZ, limite: 12, quotaPorPeriodo: quota, porDia: 4, diasMaximos: 3 });
    expect(r).toHaveLength(12);
    expect(r.slice(0, 4).map(hora)).toEqual(['08:00', '11:30', '13:00', '17:30']);
  });

  it('limite corta em rodadas: um de cada dia antes do segundo de qualquer dia', () => {
    const r = selecionarHorarios(todos, { tz: TZ, limite: 3, porDia: 3 });
    expect(r.map((h) => rotuloDoHorario(h.inicio, TZ))).toEqual([
      'quinta-feira, 01/10 às 08:00',
      'sexta-feira, 02/10 às 08:00',
      'segunda-feira, 05/10 às 08:00',
    ]);
  });
});

describe('resolverDia e janela do dia', () => {
  // AGORA = quarta 30/09/2026 10:00 em São Paulo.
  it('entende ISO, dd/mm, hoje, amanhã, depois de amanhã e nome do dia (o PRÓXIMO)', () => {
    expect(resolverDia('2026-10-14', AGORA, TZ)).toBe('2026-10-14');
    expect(resolverDia('2026-02-31', AGORA, TZ)).toBeNull();
    expect(resolverDia('14/10', AGORA, TZ)).toBe('2026-10-14');
    expect(resolverDia('05/01', AGORA, TZ)).toBe('2027-01-05'); // já passou neste ano
    expect(resolverDia('hoje', AGORA, TZ)).toBe('2026-09-30');
    expect(resolverDia('amanhã', AGORA, TZ)).toBe('2026-10-01');
    expect(resolverDia('Amanha', AGORA, TZ)).toBe('2026-10-01');
    expect(resolverDia('depois de amanhã', AGORA, TZ)).toBe('2026-10-02');
    expect(resolverDia('quinta', AGORA, TZ)).toBe('2026-10-01');
    expect(resolverDia('terça-feira', AGORA, TZ)).toBe('2026-10-06');
    expect(resolverDia('quarta', AGORA, TZ)).toBe('2026-10-07'); // hoje é quarta: a próxima
    expect(resolverDia('sabado', AGORA, TZ)).toBe('2026-10-03');
    expect(resolverDia('lixo', AGORA, TZ)).toBeNull();
    expect(resolverDia('', AGORA, TZ)).toBeNull();
  });

  it('a janela do dia civil começa à meia-noite do fuso e termina na do dia seguinte', () => {
    const j = janelaDoDiaCivil('2026-10-01', TZ);
    expect(j.inicio.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(j.fim.toISOString()).toBe('2026-10-02T03:00:00.000Z');
    expect(somarDiasCivis('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('validarHorarios', () => {
  it('limpa, ordena e recusa faixa invertida ou sobreposta', () => {
    const ok = validarHorarios({ '1': [{ inicio: '13:00', fim: '18:00' }, { inicio: '09:00', fim: '12:00' }] });
    expect(ok.erros).toEqual([]);
    expect(ok.horarios['1'].map((f) => f.inicio)).toEqual(['09:00', '13:00']);

    expect(validarHorarios({ '1': [{ inicio: '12:00', fim: '09:00' }] }).erros[0]).toMatch(/depois do início/);
    expect(validarHorarios({ '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '11:00', fim: '13:00' }] }).erros[0]).toMatch(/sobrepõem/);
    expect(validarHorarios({ '9': [] }).erros[0]).toMatch(/inválido/);
    expect(validarHorarios([]).erros[0]).toMatch(/objeto/);
  });

  it('dia sem faixa some do resultado', () => {
    expect(validarHorarios({ '1': [], '2': [{ inicio: '09:00', fim: '10:00' }] }).horarios).toEqual({
      '2': [{ inicio: '09:00', fim: '10:00' }],
    });
  });
});
