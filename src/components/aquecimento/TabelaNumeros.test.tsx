import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mobile = vi.hoisted(() => ({ valor: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.valor }));

import { TabelaNumeros } from './TabelaNumeros';
import type { NumeroAquecimento } from '@/services/aquecimento.backend.service';

const numero: NumeroAquecimento = {
  id: 'n1', inboxId: 'i1', inboxNome: 'Comercial', telefone: '5534988119078', status: 'aquecendo',
  dia: 7, modo: 'rampa', hoje: { planejadas: 10, enviadas: 4, recebidas: 3, disparos: 0 }, saude: 'boa',
  falhasSeguidas: 0, pausadoMotivo: null, pausadoEm: null, prontoEm: null, limiteDiario: 15, restantesHoje: 15,
};

function montar() {
  const acoes = { onAdicionar: vi.fn(), onAbrir: vi.fn(), onPausar: vi.fn(), onRetomar: vi.fn(), onRemover: vi.fn() };
  render(<TabelaNumeros numeros={[numero]} carregando={false} {...acoes} />);
  return acoes;
}

describe('TabelaNumeros', () => {
  beforeEach(() => { mobile.valor = false; });

  it('em tela larga, mostra a tabela', () => {
    montar();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('numeros-cartoes')).not.toBeInTheDocument();
  });

  it('abaixo de md, mostra cartões com as mesmas ações', () => {
    mobile.valor = true;
    const acoes = montar();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByTestId('numeros-cartoes')).toBeInTheDocument();
    expect(screen.getByText('dia 7 de 30')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(acoes.onPausar).toHaveBeenCalledWith(numero);
  });
});
