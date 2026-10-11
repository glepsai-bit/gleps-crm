/**
 * Leads — coluna "Etapa" vem da etapa real (tag de type=stage aplicada ao lead,
 * a mesma fonte do Kanban), com a bolinha da cor; "—" só quando não há etapa.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Contact } from '@/types/crm';

vi.mock('@/config/backend.config', () => ({ useBackend: true }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'acc1' } }),
}));

const contatos: Contact[] = [
  {
    id: 'c1',
    account_id: 'acc1',
    nome: 'Maria Souza',
    telefone: '11999990000',
    email: null,
    origem: 'whatsapp',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z',
  },
  {
    id: 'c2',
    account_id: 'acc1',
    nome: 'João Lima',
    telefone: '11988880000',
    email: null,
    origem: 'site',
    created_at: '2026-10-02T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
  },
];

vi.mock('@/contexts/FinanceContext', () => ({
  useFinance: () => ({
    contacts: contatos,
    updateContact: vi.fn(),
    refetchContacts: vi.fn(),
    isLoadingContacts: false,
  }),
}));

// Maria tem uma tag operacional ANTES da etapa: a etapa tem que ser achada mesmo assim.
vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({
      data: [
        { id: 'lt0', contact_id: 'c1', tag_id: 'op-vip', source: 'kanban', created_at: '' },
        { id: 'lt1', contact_id: 'c1', tag_id: 'e-orc', source: 'kanban', created_at: '' },
      ],
    }),
  },
}));

vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: {
    listStageTags: vi.fn().mockResolvedValue([
      { id: 'e-novo', account_id: 'acc1', funnel_id: 'f1', name: 'Novo Lead', slug: 'novo', type: 'stage', color: '#0EA5E9', ordem: 1, papel: null, ativo: true, created_at: '' },
      { id: 'e-orc', account_id: 'acc1', funnel_id: 'f1', name: 'Orçamento', slug: 'orc', type: 'stage', color: '#22C55E', ordem: 2, papel: null, ativo: true, created_at: '' },
    ]),
  },
}));
vi.mock('@/services/contacts.backend.service', () => ({ contactsBackendService: { deleteLead: vi.fn() } }));
vi.mock('@/services/contacts.cloud.service', () => ({ contactsCloudService: { deleteLead: vi.fn() } }));
vi.mock('@/components/leads/LeadProfileSheet', () => ({ LeadProfileSheet: () => null }));
vi.mock('@/components/kanban/CreateLeadDialog', () => ({
  CreateLeadDialog: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}));

import AdminLeadsPage from './AdminLeadsPage';

const linhaDe = (nome: string) =>
  screen.getAllByRole('row').find((r) => within(r).queryByText(nome)) as HTMLElement;

describe('Leads — coluna Etapa', () => {
  it('lead com etapa mostra o nome e a bolinha da cor; lead sem etapa mostra "—"', async () => {
    render(<AdminLeadsPage />);

    // tabela (>=md) — a etapa real chega depois do fetch
    const etapa = await screen.findAllByText('Orçamento');
    expect(etapa.length).toBeGreaterThan(0);

    const maria = linhaDe('Maria Souza');
    const nomeEtapa = within(maria).getByText('Orçamento');
    const bolinha = nomeEtapa.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(bolinha).not.toBeNull();
    expect(bolinha.style.backgroundColor).toBe('rgb(34, 197, 94)');
    expect(within(maria).queryByText('—')).toBeNull();
    expect(within(maria).queryByText('-')).toBeNull();

    const joao = linhaDe('João Lima');
    expect(within(joao).getByText('—')).toBeInTheDocument();
    expect(within(joao).queryByText('Novo Lead')).toBeNull();
    expect(within(joao).queryByText('Orçamento')).toBeNull();
  });
});
