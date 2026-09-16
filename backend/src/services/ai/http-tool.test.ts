/**
 * T-036 — a ferramenta HTTP do agente.
 *
 * O que está sob teste é sobretudo CONTENÇÃO. Uma ferramenta que o modelo
 * decide chamar, com valores que o modelo escreveu, apontando para uma URL que
 * o admin configurou, é três superfícies de erro empilhadas.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ssrf-guard', () => ({ safeFetch: safeFetchMock }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  lerHttpTools,
  definicaoDaHttpTool,
  executarHttpTool,
  type HttpToolConfig,
} from './http-tool';

const resposta = (body: string, ok = true, status = 200) =>
  ({ ok, status, text: async () => body }) as Response;

const vagas = (over: Partial<HttpToolConfig> = {}): HttpToolConfig => ({
  nome: 'consultar_vagas',
  quandoUsar: 'Use quando o lead perguntar por horários disponíveis.',
  metodo: 'GET',
  url: 'https://api.pacto.com.br/aulas?data={{data}}&turno={{turno}}',
  parametros: [
    { nome: 'data', descricao: 'Dia em AAAA-MM-DD', tipo: 'texto' },
    { nome: 'turno', descricao: 'Período', tipo: 'opcoes', opcoes: ['manha', 'tarde'] },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  safeFetchMock.mockResolvedValue(resposta('[{"hora":"06:00","vagas":4}]'));
});

describe('o que vira ferramenta', () => {
  it('aceita a configurada corretamente', () => {
    expect(lerHttpTools([vagas()])).toHaveLength(1);
  });

  it('descarta sem nome, sem URL ou sem "quando usar"', () => {
    const ruins = [
      { ...vagas(), nome: '' },
      { ...vagas(), url: '' },
      { ...vagas(), quandoUsar: '' },
      // Nome com espaço/maiúscula: o modelo não conseguiria chamar.
      { ...vagas(), nome: 'Consultar Vagas' },
    ];
    expect(lerHttpTools(ruins)).toHaveLength(0);
  });

  it('a descrição que o modelo lê é o "quando usar"', () => {
    const d = definicaoDaHttpTool(vagas());
    expect(d.description).toContain('horários disponíveis');
    expect(d.name).toBe('consultar_vagas');
  });

  it('parâmetro de opções vira enum — o modelo não inventa valor', () => {
    const props = definicaoDaHttpTool(vagas()).parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.turno.enum).toEqual(['manha', 'tarde']);
  });
});

describe('a chamada', () => {
  it('preenche a URL com o que o modelo respondeu', async () => {
    await executarHttpTool(vagas(), { data: '2026-09-18', turno: 'manha' });
    expect(safeFetchMock.mock.calls[0][0]).toBe(
      'https://api.pacto.com.br/aulas?data=2026-09-18&turno=manha'
    );
  });

  it('ESCAPA o valor na URL — texto do modelo com & quebraria a query', async () => {
    await executarHttpTool(vagas(), { data: 'a&b=c', turno: 'manha' });
    expect(safeFetchMock.mock.calls[0][0]).toContain('data=a%26b%3Dc');
  });

  it('devolve o corpo ao modelo', async () => {
    const r = await executarHttpTool(vagas(), { data: 'x', turno: 'manha' });
    expect(r).toContain('06:00');
  });

  it('corta resposta gigante — o modelo se perde e o custo dispara', async () => {
    safeFetchMock.mockResolvedValue(resposta('x'.repeat(50_000)));
    const r = await executarHttpTool(vagas(), { data: 'x', turno: 'manha' });
    expect(r.length).toBeLessThanOrEqual(4000);
  });

  it('manda cabeçalho de autenticação configurado', async () => {
    await executarHttpTool(vagas({ cabecalhos: { Authorization: 'Bearer abc' } }), {
      data: 'x',
      turno: 'manha',
    });
    expect(safeFetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer abc' });
  });

  it('POST leva corpo preenchido', async () => {
    await executarHttpTool(
      vagas({ metodo: 'POST', url: 'https://api.x.com/agendar', corpo: '{"dia":"{{data}}"}' }),
      { data: '2026-09-18', turno: 'manha' }
    );
    expect(safeFetchMock.mock.calls[0][1].body).toBe('{"dia":"2026-09-18"}');
  });
});

describe('quando dá errado', () => {
  it('parâmetro obrigatório faltando não vira chamada', async () => {
    const r = await executarHttpTool(vagas(), { turno: 'manha' });
    expect(r).toContain('Faltou informar: data');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('erro HTTP informa o status — 404 e 500 pedem respostas diferentes', async () => {
    safeFetchMock.mockResolvedValue(resposta('não encontrado', false, 404));
    const r = await executarHttpTool(vagas(), { data: 'x', turno: 'manha' });
    expect(r).toContain('404');
  });

  it('rede caída NÃO derruba o atendimento', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:8080'));
    const r = await executarHttpTool(vagas(), { data: 'x', turno: 'manha' });
    expect(r).toContain('vai confirmar');
  });

  it('e não vaza detalhe de rede para o modelo', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:8080'));
    const r = await executarHttpTool(vagas(), { data: 'x', turno: 'manha' });
    // O modelo repassaria ao lead. Endereço interno não é assunto dele.
    expect(r).not.toContain('10.0.0.1');
    expect(r).not.toContain('ECONNREFUSED');
  });

  it('endereço interno é barrado pelo guarda que já existe', async () => {
    safeFetchMock.mockRejectedValue(new Error('SSRF bloqueado: endereço privado'));
    const r = await executarHttpTool(vagas({ url: 'http://169.254.169.254/latest/meta-data' }), {
      data: 'x',
      turno: 'manha',
    });
    expect(r).toContain('Não consegui consultar');
    expect(r).not.toContain('SSRF');
  });
});
