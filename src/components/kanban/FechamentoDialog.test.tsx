/**
 * "Quanto fechou?" — o que o diálogo envia (e o que NÃO envia).
 * Regra de ouro: "Fechou sem valor" nunca chama onRegistrar (= nunca vira PATCH).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FechamentoDialog } from './FechamentoDialog';
import { lerValorEmReais } from '@/utils/valorEmReais';
import type { Product } from '@/types/crm';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

const servicos: Product[] = [
  {
    id: 's1',
    account_id: 'a',
    nome: 'Limpeza de pele',
    valor_padrao: 200,
    metodos_pagamento: [],
    convenios_aceitos: [],
    ativo: true,
    created_at: '',
    updated_at: '',
  },
];

function abrir(extra: Partial<React.ComponentProps<typeof FechamentoDialog>> = {}) {
  const onRegistrar = vi.fn().mockResolvedValue(undefined);
  const onSemValor = vi.fn();
  render(
    <FechamentoDialog
      open
      onOpenChange={vi.fn()}
      nomeDoLead="Maria"
      servicos={servicos}
      onRegistrar={onRegistrar}
      onSemValor={onSemValor}
      {...extra}
    />
  );
  return { onRegistrar, onSemValor };
}

describe('lerValorEmReais', () => {
  it.each([
    ['1.500,50', 1500.5],
    ['300', 300],
    ['R$ 99,9', 99.9],
    ['1500.5', 1500.5],
    ['1.500', 1500],
    ['', null],
    ['abc', null],
  ])('%s -> %s', (texto, esperado) => {
    expect(lerValorEmReais(texto)).toBe(esperado);
  });
});

describe('FechamentoDialog', () => {
  it('Registrar começa desabilitado e habilita com valor > 0', () => {
    abrir();
    const registrar = screen.getByRole('button', { name: 'Registrar' });
    expect(registrar).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Valor (R$)'), { target: { value: '350,00' } });
    expect(registrar).toBeEnabled();
  });

  it('Registrar envia o valor em número, sem serviço quando nenhum foi escolhido', async () => {
    const { onRegistrar } = abrir();
    fireEvent.change(screen.getByLabelText('Valor (R$)'), { target: { value: '1.200,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));
    await waitFor(() => expect(onRegistrar).toHaveBeenCalledWith({ valor: 1200.5 }));
  });

  it('"Fechou sem valor" não chama onRegistrar', () => {
    const { onRegistrar, onSemValor } = abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Fechou sem valor' }));
    expect(onSemValor).toHaveBeenCalledTimes(1);
    expect(onRegistrar).not.toHaveBeenCalled();
  });

  it('sem serviços cadastrados, o campo de serviço nem aparece', () => {
    abrir({ servicos: [] });
    expect(screen.queryByText('Serviço (opcional)')).not.toBeInTheDocument();
  });
});
