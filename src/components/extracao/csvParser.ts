/**
 * Lightweight CSV parser + BR phone normalizer.
 * Supports comma, semicolon, tab delimiters. Handles quoted values.
 */

export interface CsvRow {
  [key: string]: string;
}

export interface ParsedLeadRow {
  nome: string;
  telefone: string;
  rawIndex: number;
  valid: boolean;
  reason?: string;
}

const NAME_KEYS = ['nome', 'name', 'cliente', 'contato', 'contact', 'razao_social', 'razão social'];
const PHONE_KEYS = ['telefone', 'phone', 'celular', 'whatsapp', 'fone', 'tel', 'numero', 'número'];

function detectDelimiter(line: string): string {
  const counts = [
    { d: ';', c: (line.match(/;/g) || []).length },
    { d: ',', c: (line.match(/,/g) || []).length },
    { d: '\t', c: (line.match(/\t/g) || []).length },
  ];
  counts.sort((a, b) => b.c - a.c);
  return counts[0].c > 0 ? counts[0].d : ',';
}

function parseLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(current.trim()); current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleaned.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter).map((h) => h.toLowerCase().trim());
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i], delimiter);
    const row: CsvRow = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

export function autoDetectColumn(headers: string[], candidates: string[]): string | null {
  for (const c of candidates) {
    const found = headers.find((h) => h === c || h.includes(c));
    if (found) return found;
  }
  return null;
}

export function detectColumns(headers: string[]) {
  return {
    name: autoDetectColumn(headers, NAME_KEYS),
    phone: autoDetectColumn(headers, PHONE_KEYS),
  };
}

/**
 * Normalize Brazilian phone to E.164 (+55XXXXXXXXXXX).
 * Accepts formats: (11) 91234-5678, 11912345678, +5511912345678, 5511912345678.
 * Returns null if invalid.
 */
export function normalizePhoneBR(raw: string): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Remove leading 0 (national trunk prefix)
  if (digits.startsWith('0')) digits = digits.slice(1);

  // If 10 or 11 digits → assume BR without country code
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits;
  }

  // Must start with 55 and be 12-13 digits total
  if (!digits.startsWith('55')) return null;
  if (digits.length < 12 || digits.length > 13) return null;

  return '+' + digits;
}

export function buildLeadsFromCsv(
  rows: CsvRow[],
  nameCol: string,
  phoneCol: string
): ParsedLeadRow[] {
  return rows.map((r, idx) => {
    const nome = (r[nameCol] || '').trim() || `Contato ${idx + 1}`;
    const rawPhone = (r[phoneCol] || '').trim();
    const normalized = normalizePhoneBR(rawPhone);
    if (!normalized) {
      return { nome, telefone: rawPhone, rawIndex: idx, valid: false, reason: 'Telefone inválido' };
    }
    return { nome, telefone: normalized, rawIndex: idx, valid: true };
  });
}
