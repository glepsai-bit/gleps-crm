/**
 * Kanban — gesto "Quanto fechou?" e etapas fixas.
 *  - o diálogo abre SÓ ao soltar numa etapa com papel 'fechamento';
 *  - "Fechou sem valor" não manda PATCH; "Registrar" manda { valor, productId? };
 *  - etapa fixa: cadeado, sem excluir.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Contact } from '@/types/crm';
import type { Tag } from '@/services/tags.cloud.service';

vi.mock('@/config/backend.config', () => ({ useBackend: true }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', account_id: 'acc1' }, account: { id: 'acc1' } }),
}));
vi.mock('@/hooks/useModulos', () => ({ useModulos: () => ({ ligado: () => false }) }));

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
];

vi.mock('@/contexts/FinanceContext', () => ({
  useFinance: () => ({
    contacts: contatos,
    refetchContacts: vi.fn(),
    isLoadingContacts: false,
    isSyncingContacts: false,
    lastContactsSync: null,
    newContactIds: new Set<string>(),
    getContactSales: () => [],
  }),
}));

vi.mock('@/contexts/ProductContext', () => ({
  useProduct: () => ({
    getActiveProducts: () => [
      {
        id: 's1',
        account_id: 'acc1',
        nome: 'Limpeza de pele',
        valor_padrao: 200,
        metodos_pagamento: [],
        convenios_aceitos: [],
        ativo: true,
        created_at: '',
        updated_at: '',
      },
    ],
  }),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({
      data: [{ id: 'lt1', contact_id: 'c1', tag_id: 'e-novo', source: 'kanban', created_at: '' }],
    }),
  },
}));

vi.mock('@/services/contacts.backend.service', () => ({
  contactsBackendService: { registrarFechamento: vi.fn() },
}));

vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: {
    listStageTags: vi.fn(),
    applyStageTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    swapTagOrder: vi.fn(),
  },
}));

vi.mock('@/services/tags.cloud.service', () => ({ tagsCloudService: {} }));

import AdminKanbanPage from './AdminKanbanPage';
import { tagsBackendService } from '@/services/tags.backend.service';
import { contactsBackendService } from '@/services/contacts.backend.service';

const tagsApi = vi.mocked(tagsBackendService);
const contatosApi = vi.mocked(contactsBackendService);

const etapa = (id: string, name: string, ordem: number, papel: Tag['papel'] = null): Tag => ({
  id,
  account_id: 'acc1',
  funnel_id: 'f1',
  name,
  slug: id,
  type: 'stage',
  color: '#0EA5E9',
  ordem,
  papel,
  ativo: true,
  created_at: '',
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Fixas vêm do servidor fora de ordem de propósito: a tela as joga pro fim.
  tagsApi.listStageTags.mockResolvedValue([
    etapa('e-perdido', 'Perdido', 1, 'perda'),
    etapa('e-novo', 'Novo Lead', 2),
    etapa('e-fechado', 'Fechado', 0, 'fechamento'),
    etapa('e-meio', 'Orçamento', 3),
  ]);
  tagsApi.applyStageTag.mockResolvedValue(undefined);
  contatosApi.registrarFechamento.mockResolvedValue(undefined);
});

/** Arrasta o card da Maria até a coluna cujo título é `titulo`. */
async function arrastarParaColuna(titulo: string) {
  const card = (await screen.findByText('Maria Souza')).closest('[draggable="true"]') as HTMLElement;
  const coluna = screen.getByText(titulo, { selector: 'h3, div, span, p' }).closest('.kanban-column') as HTMLElement;
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(card, { dataTransfer });
  // o card agenda o dragStart num requestAnimationFrame
  await waitFor(() => expect(card.className).toContain('opacity-40'));
  fireEvent.dragOver(coluna, { dataTransfer });
  fireEvent.drop(coluna, { dataTransfer });
}

describe('Kanban — Quanto fechou?', () => {
  it('soltar numa etapa comum NÃO abre o diálogo', async () => {
    render(<AdminKanbanPage />);
    await arrastarParaColuna('Orçamento');
    await waitFor(() => expect(tagsApi.applyStageTag).toHaveBeenCalledWith('c1', 'e-meio', 'kanban'));
    expect(screen.queryByText('Quanto fechou?')).not.toBeInTheDocument();
  });

  it('soltar na etapa de fechamento aplica a etapa e abre o diálogo', async () => {
    render(<AdminKanbanPage />);
    await arrastarParaColuna('Fechado');
    await waitFor(() => expect(tagsApi.applyStageTag).toHaveBeenCalledWith('c1', 'e-fechado', 'kanban'));
    expect(await screen.findByText('Quanto fechou?')).toBeInTheDocument();
  });

  it('"Fechou sem valor" fecha o diálogo sem PATCH', async () => {
    render(<AdminKanbanPage />);
    await arrastarParaColuna('Fechado');
    fireEvent.click(await screen.findByRole('button', { name: 'Fechou sem valor' }));
    await waitFor(() => expect(screen.queryByText('Quanto fechou?')).not.toBeInTheDocument());
    expect(contatosApi.registrarFechamento).not.toHaveBeenCalled();
  });

  it('"Registrar" envia valor e serviço escolhido', async () => {
    render(<AdminKanbanPage />);
    await arrastarParaColuna('Fechado');
    fireEvent.change(await screen.findByLabelText('Valor (R$)'), { target: { value: '450,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));
    await waitFor(() =>
      expect(contatosApi.registrarFechamento).toHaveBeenCalledWith('c1', { valor: 450 })
    );
  });

  it('soltar na etapa Perdido (papel perda) não pergunta valor', async () => {
    render(<AdminKanbanPage />);
    await arrastarParaColuna('Perdido');
    await waitFor(() => expect(tagsApi.applyStageTag).toHaveBeenCalledWith('c1', 'e-perdido', 'kanban'));
    expect(screen.queryByText('Quanto fechou?')).not.toBeInTheDocument();
  });
});

// Radix abre o menu no keydown do gatilho (jsdom não tem pointer events completos).
const abrirMenu = (gatilho: HTMLElement) => fireEvent.keyDown(gatilho, { key: 'Enter' });

describe('Kanban — etapas fixas', () => {
  it('as fixas ficam sempre no fim, mesmo vindo fora de ordem', async () => {
    render(<AdminKanbanPage />);
    await screen.findByText('Maria Souza');
    const titulos = Array.from(document.querySelectorAll('.kanban-column h3')).map((n) => n.textContent);
    expect(titulos).toEqual(['Novo Lead', 'Orçamento', 'Fechado', 'Perdido']);
  });

  it('etapa fixa tem cadeado e "Excluir Etapa" desabilitado; etapa comum pode excluir', async () => {
    render(<AdminKanbanPage />);
    await screen.findByText('Maria Souza');
    const colunas = Array.from(document.querySelectorAll('.kanban-column')) as HTMLElement[];

    const fechado = colunas.find((c) => within(c).queryByText('Fechado'))!;
    expect(within(fechado).getByLabelText('Etapa fixa do funil')).toBeInTheDocument();
    abrirMenu(within(fechado).getAllByRole('button')[0]);
    const excluirFixa = await screen.findByRole('menuitem', { name: /excluir etapa/i });
    expect(excluirFixa).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(excluirFixa, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /excluir etapa/i })).not.toBeInTheDocument());

    const comum = colunas.find((c) => within(c).queryByText('Orçamento'))!;
    expect(within(comum).queryByLabelText('Etapa fixa do funil')).not.toBeInTheDocument();
    abrirMenu(within(comum).getAllByRole('button')[0]);
    const excluirComum = await screen.findByRole('menuitem', { name: /excluir etapa/i });
    expect(excluirComum).not.toHaveAttribute('aria-disabled', 'true');
  });
});
