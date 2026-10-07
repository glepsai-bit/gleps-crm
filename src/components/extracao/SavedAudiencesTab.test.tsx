import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('@/config/backend.config', () => ({ useBackend: true }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
// toast estável: o componente o usa como dependência de useCallback.
const toastFalso = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastFalso }) }));
vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn(async () => [{ id: 'pub1', name: 'Reavaliação set', total_leads: 64, created_at: '2026-09-01T00:00:00Z' }]) },
}));

import { SavedAudiencesTab } from './SavedAudiencesTab';

function Local() {
  const l = useLocation();
  return <div data-testid="rota">{l.pathname}{l.search}</div>;
}

describe('SavedAudiencesTab', () => {
  it('"Disparar" leva ao Novo disparo com o público', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/prospeccao']}>
        <Routes>
          <Route path="/admin/prospeccao" element={<SavedAudiencesTab />} />
          <Route path="/admin/disparos" element={<Local />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Disparar/ }));
    expect(await screen.findByTestId('rota')).toHaveTextContent('/admin/disparos?publico=pub1');
  });

  it('não oferece mais CSV nem seleção do CRM aqui', async () => {
    render(<MemoryRouter><SavedAudiencesTab /></MemoryRouter>);
    await screen.findByText('Reavaliação set');
    expect(screen.queryByText(/Importar planilha/)).not.toBeInTheDocument();
  });
});
