import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LeadCard } from './LeadCard';
import type { Contact, Tag } from '@/types/crm';

const etapa = (papel: Tag['papel']): Tag => ({
  id: 't1',
  account_id: 'a',
  funnel_id: 'f',
  name: 'Fechado',
  slug: 'fechado',
  type: 'stage',
  color: '#F0A532',
  ordem: 9,
  papel,
  ativo: true,
  created_at: '',
});

const lead = (fechamento: Contact['fechamento']) => ({
  id: 'c1',
  account_id: 'a',
  nome: 'Maria',
  telefone: null,
  email: null,
  origem: 'whatsapp' as const,
  fechamento,
  stage_id: 't1',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
});

function renderizar(l: ReturnType<typeof lead>, papel: Tag['papel'], extra = {}) {
  const props = { onClick: vi.fn(), onDragStart: vi.fn(), onInformarValor: vi.fn(), ...extra };
  render(<LeadCard lead={l} stage={etapa(papel)} {...props} />);
  return props;
}

describe('LeadCard — fechamento', () => {
  it('com valor mostra "Fechou R$ X em dd/mm"', () => {
    renderizar(lead({ valor: 1500, em: '2026-10-05T15:00:00Z' }), 'fechamento');
    expect(screen.getByText(/Fechou/)).toHaveTextContent(/R\$\s?1\.500,00 em 05\/10/);
  });

  it('sem valor mostra o chip "informe o valor", que abre o diálogo sem abrir o card', () => {
    const props = renderizar(lead({ valor: null, em: '2026-10-05T15:00:00Z' }), 'fechamento');
    fireEvent.click(screen.getByRole('button', { name: /informe o valor/i }));
    expect(props.onInformarValor).toHaveBeenCalledTimes(1);
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it('fora da etapa de fechamento o card é comum', () => {
    renderizar(lead({ valor: null, em: '2026-10-05T15:00:00Z' }), null);
    expect(screen.queryByText(/informe o valor/i)).not.toBeInTheDocument();
  });

  it('lead que nunca fechou não mostra nada', () => {
    renderizar(lead(null), 'fechamento');
    expect(screen.queryByText(/Fechou/)).not.toBeInTheDocument();
  });

  it('sem valor e com venda anterior, o chip diz "nova venda: informe o valor"', () => {
    const props = renderizar(lead({ valor: null, em: '2026-10-05T10:00:00Z', anterior: { valor: 200, em: '2026-09-01T10:00:00Z' } }), 'fechamento');
    fireEvent.click(screen.getByRole('button', { name: /nova venda: informe o valor/ }));
    expect(props.onInformarValor).toHaveBeenCalledTimes(1);
  });

  it('sem valor e sem venda anterior, o chip segue "informe o valor"', () => {
    renderizar(lead({ valor: null, em: '2026-10-05T10:00:00Z' }), 'fechamento');
    expect(screen.queryByText(/nova venda/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /informe o valor/ })).toBeInTheDocument();
  });

  it('fechamento null (venda cancelada): nenhum chip', () => {
    renderizar(lead(null), 'fechamento');
    expect(screen.queryByRole('button', { name: /informe o valor/ })).not.toBeInTheDocument();
  });
});
