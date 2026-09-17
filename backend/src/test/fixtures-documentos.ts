/**
 * Fixtures binárias pros testes de extração/upload da base de conhecimento.
 *
 * O PDF é montado à mão (objetos + xref) pra não depender de gerador: é o
 * menor PDF válido com uma fonte padrão e um stream de texto. O .docx é um
 * zip mínimo (Content_Types + rels + document.xml) gerado uma vez e gravado
 * em base64 — dois parágrafos, um com acento.
 */

/** PDF de uma página com as linhas dadas; sem linhas = página em branco (escaneado). */
export function pdfMinimo(linhas: string[]): Buffer {
  const conteudo = linhas.length
    ? `BT /F1 12 Tf 50 750 Td 14 TL ${linhas
        .map((l) => `(${l.replace(/[\\()]/g, '\\$&')}) Tj T*`)
        .join(' ')} ET`
    : '';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const PDF_LINHAS_PRECOS = [
  'Plano Essencial custa R$ 500 por mes.',
  'Plano Pro custa R$ 890 por mes e inclui suporte.',
  'Atendimento de segunda a sexta.',
];

/** .docx com "Horário de atendimento: 8h às 18h." e "Plano Premium inclui consultoria." */
export const DOCX_MINIMO_B64 =
  'UEsDBAoAAAAIACOmMV3MVIwQ4AAAAJwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUTukAIJekCyhJYlA+w7Eli4Zc8bil/z6QtXaDC0r6PM7rd+hC82GMhl2Ivb1UrBUaTrItTL9+3z829XA/d9isjCbZG6uVca34AIDNj0KRSxsjKmErQlZ9lgqzNh54QVm17BybFirE2demQQ/eEo975KjYH/j5hC3qS4vFkXFi91Dl7Z3RlHfbR/qI0Z4Li5NFDs8t0wwYJVwmL8jfgnHvlHYqzKN50qS86sAs+U7Fgk9kFTqr/a67cmcbRGbzkl7ZckkEiHjh4dVGCdvHnfjjOPXwDUEsDBAoAAAAAACOmMV0AAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAIACOmMV02V97cogAAABgBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRN6pCwNCqGkXhNQVlQNEiZtGNA8l4XV7MjBQxMBo+/dnuekedmY3isl4x2Fd1cDISa+M0xzOw3G1g65tTjSLXBJpMiGxsuIShynnsEdMciIrUuUDuTIZfbQilzJqDEJehCbc1PUW46cBS5P1ikPs1RrY8Az0j+3H0Ug6eHm15PKPE1+JIouoKXO4+6hQvdtVYQHbBhcvti9QSwMECgAAAAAAI6YxXQAAAAAAAAAAAAAAAAUAAAB3b3JkL1BLAwQKAAAACAAjpjFdtmb64sUAAAAeAQAAEQAAAHdvcmQvZG9jdW1lbnQueG1sbY/BasMwDIZfRfi+ON2hhJCkt7FjD90DuLbXCGzJyM6yvc36LH2xxoUxGLt8QujnkzQcPmOADy8ZmUa1a1oFniw7pMuo3k4vT506TMPaO7ZL9FRgy1Pu11HNpaRe62xnH01uOHnaZu8s0ZStlYteWVwStj7nTReDfm7bvY4GSVXlmd1XralCKsr0ynK7CjI4D6Z4cliXcg/dDLfvDLtubgZdk5XyYPorOQZDDEfxEZcISDYsCJYpL6GwoPnPoH/u0b+/TndQSwECFAAKAAAACAAjpjFdzFSMEOAAAACcAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAACOmMV0AAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAABEBAABfcmVscy9QSwECFAAKAAAACAAjpjFdNlfe3KIAAAAYAQAACwAAAAAAAAAAAAAAAAA1AQAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAAAjpjFdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAAAAAgAAd29yZC9QSwECFAAKAAAACAAjpjFdtmb64sUAAAAeAQAAEQAAAAAAAAAAAAAAAAAjAgAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAFwMAAAAA';

export function docxMinimo(): Buffer {
  return Buffer.from(DOCX_MINIMO_B64, 'base64');
}
