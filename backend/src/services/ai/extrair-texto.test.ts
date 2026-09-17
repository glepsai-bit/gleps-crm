/**
 * Extração de texto (PDF, Word, HTML) pra base de conhecimento.
 *
 * O que importa aqui: arquivo sem texto NUNCA vira texto vazio silencioso — é
 * erro 422 com instrução; e o HTML sai na forma que o chunker entende (linhas
 * de tabela consecutivas, itens de lista em linha própria, lixo fora).
 */

import { describe, it, expect } from 'vitest';
import {
  extrairPdf,
  extrairDocx,
  extrairHtml,
  decodificarEntidades,
  DocumentoIlegivelError,
  MIN_CARACTERES_PDF,
} from './extrair-texto';
import { pdfMinimo, PDF_LINHAS_PRECOS, docxMinimo } from '../../test/fixtures-documentos';

describe('extrairPdf', () => {
  it('PDF com texto devolve o conteúdo das páginas, sem marcador de página', async () => {
    const texto = await extrairPdf(pdfMinimo(PDF_LINHAS_PRECOS));

    expect(texto).toContain('Plano Essencial custa R$ 500 por mes.');
    expect(texto).toContain('Atendimento de segunda a sexta.');
    // pdf-parse intercala "-- 1 of 1 --" em `text`; isso não é conteúdo.
    expect(texto).not.toMatch(/-- \d+ of \d+ --/);
  });

  it('PDF sem texto (escaneado) é 422 com instrução, não string vazia', async () => {
    const err = await extrairPdf(pdfMinimo([])).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as DocumentoIlegivelError).statusCode).toBe(422);
    expect((err as Error).message).toContain('PDF sem texto (provavelmente escaneado)');
  });

  it('PDF com só um rodapé curto conta como sem texto', async () => {
    const curto = 'Pag 1'; // bem abaixo do mínimo
    expect(curto.replace(/\s/g, '').length).toBeLessThan(MIN_CARACTERES_PDF);
    await expect(extrairPdf(pdfMinimo([curto]))).rejects.toBeInstanceOf(DocumentoIlegivelError);
  });

  it('bytes que não são PDF viram 422 legível, não exceção crua da lib', async () => {
    const err = await extrairPdf(Buffer.from('isto nao e um pdf')).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as Error).message).toContain('Não consegui ler este PDF');
  });
});

describe('extrairDocx', () => {
  it('Word .docx devolve os parágrafos, com acento preservado', async () => {
    const texto = await extrairDocx(docxMinimo());

    expect(texto).toContain('Horário de atendimento: 8h às 18h.');
    expect(texto).toContain('Plano Premium inclui consultoria.');
    // Parágrafos separados por linha em branco — é o que o chunker respeita.
    expect(texto.split('\n\n')).toHaveLength(2);
  });

  it('arquivo que não é .docx (zip inválido) é 422 explicando o formato', async () => {
    const err = await extrairDocx(Buffer.from('nao e zip')).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as Error).message).toContain('.docx');
  });
});

describe('extrairHtml', () => {
  const pagina = `
    <html><head><title>Planos</title>
      <style>p { color: red }</style>
      <script>window.alert("nao me leia")</script>
    </head><body>
      <nav><a href="/">Home</a><a href="/planos">Planos</a></nav>
      <header>Barra do site</header>
      <h1>Planos &amp; Pre&ccedil;os</h1>
      <p>O plano <b>Essencial</b> custa R$&nbsp;500.<br>Cobran&#231;a mensal.</p>
      <h2>Inclui</h2>
      <ul>
        <li>Suporte</li>
        <li>Treino</li>
      </ul>
      <table>
        <thead><tr><th>Plano</th><th>Mensal</th><th>Anual</th></tr></thead>
        <tbody>
          <tr><td>Essencial</td><td>500</td><td>5000</td></tr>
          <tr><td>Pro</td><td>890</td><td>8900</td></tr>
        </tbody>
      </table>
      <footer>© Empresa — rodapé</footer>
    </body></html>`;

  it('descarta script, style, nav, header e footer', () => {
    const texto = extrairHtml(pagina);

    expect(texto).not.toContain('color: red');
    expect(texto).not.toContain('nao me leia');
    expect(texto).not.toContain('Home');
    expect(texto).not.toContain('Barra do site');
    expect(texto).not.toContain('rodapé');
  });

  it('títulos e parágrafos saem como parágrafos próprios, com entidades decodificadas', () => {
    const texto = extrairHtml(pagina);
    const paragrafos = texto.split('\n\n');

    expect(paragrafos[0]).toBe('Planos & Preços');
    expect(paragrafos[1]).toBe('O plano Essencial custa R$ 500.\nCobrança mensal.');
    expect(paragrafos[2]).toBe('Inclui');
  });

  it('lista vira "- item" em linhas consecutivas', () => {
    const texto = extrairHtml(pagina);
    expect(texto).toContain('- Suporte\n- Treino');
  });

  it('tabela vira uma linha por registro com " | " — e as linhas ficam JUNTAS', () => {
    // Se thead/tbody abrissem parágrafo, o cabeçalho ficaria separado das
    // linhas e o chunker não enxergaria a tabela.
    const texto = extrairHtml(pagina);
    expect(texto).toContain('Plano | Mensal | Anual\nEssencial | 500 | 5000\nPro | 890 | 8900');
  });

  it('página sem conteúdo devolve string vazia (quem chama decide o 422)', () => {
    expect(extrairHtml('<html><head><script>x()</script></head><body></body></html>')).toBe('');
  });

  it('respeita quebras dentro de <pre> e colapsa espaço fora', () => {
    const texto = extrairHtml('<p>a   b\n   c</p><pre>linha 1\n  linha 2</pre>');
    expect(texto).toBe('a b c\n\nlinha 1\nlinha 2');
  });
});

describe('decodificarEntidades', () => {
  it('nomeadas, decimais e hexadecimais', () => {
    expect(decodificarEntidades('a &amp; b &lt; c &#233; &#xE7; &nbsp;x')).toBe('a & b < c é ç  x');
  });

  it('entidade desconhecida fica como está', () => {
    expect(decodificarEntidades('&naoexiste; &#99999999;')).toBe('&naoexiste; &#99999999;');
  });
});
