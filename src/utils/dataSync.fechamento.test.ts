import { describe, it, expect } from 'vitest';
import { mergeContacts } from './dataSync';

describe('mergeContacts — fechamento', () => {
  const base = { id: 'c1', updated_at: '2026-10-01T10:00:00Z', nome: 'Rafael' };

  it('pega o fechamento novo mesmo com updated_at igual (a venda não mexe no contato)', () => {
    const antes = [{ ...base, fechamento: { valor: null, em: '2026-10-06T05:00:00Z' } }];
    const depois = [{ ...base, fechamento: { valor: 350, em: '2026-10-06T05:00:00Z' } }];
    const r = mergeContacts(antes, depois);
    expect(r.data[0].fechamento).toEqual({ valor: 350, em: '2026-10-06T05:00:00Z' });
  });

  it('mantém o objeto quando nada mudou', () => {
    const antes = [{ ...base, fechamento: null }];
    const r = mergeContacts(antes, [{ ...base, fechamento: null }]);
    expect(r.data[0]).toBe(antes[0]);
  });
});
