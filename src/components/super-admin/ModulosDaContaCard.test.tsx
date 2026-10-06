import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModulosDaContaCard } from './ModulosDaContaCard';

const { update, toastOk } = vi.hoisted(() => ({ update: vi.fn(), toastOk: vi.fn() }));

vi.mock('@/services', () => ({ accountsCloudOrBackend: { update } }));
vi.mock('sonner', () => ({ toast: { success: toastOk, error: vi.fn() } }));

describe('ModulosDaContaCard', () => {
  beforeEach(() => {
    update.mockReset().mockResolvedValue({});
    toastOk.mockReset();
  });

  it('envia { modulos } com o que ficou ligado e avisa "Módulos salvos"', async () => {
    const onSalvo = vi.fn();
    render(<ModulosDaContaCard accountId="c1" modulos={['extracao', 'disparos']} onSalvo={onSalvo} />);

    const salvar = screen.getByRole('button', { name: 'Salvar módulos' });
    expect((salvar as HTMLButtonElement).disabled).toBe(true); // nada mudou

    fireEvent.click(screen.getByRole('switch', { name: 'Módulo E-mails' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Módulo Disparos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar módulos' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('c1', { modulos: ['extracao', 'emails'] });
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Módulos salvos'));
    expect(onSalvo).toHaveBeenCalledWith(['extracao', 'emails']);
  });

  it('o núcleo não tem interruptor', () => {
    render(<ModulosDaContaCard accountId="c1" modulos={[]} />);
    expect(screen.getByText('núcleo · sempre ligado')).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(6);
  });

  it('conta sem `modulos` (servidor antigo) aparece com tudo ligado', () => {
    render(<ModulosDaContaCard accountId="c1" />);
    for (const s of screen.getAllByRole('switch')) {
      expect(s.getAttribute('aria-checked')).toBe('true');
    }
  });
});
