import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RotaDeModulo } from './RotaDeModulo';

const estado = vi.hoisted(() => ({ modulos: undefined as string[] | undefined }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'a', nome: 'n', status: 'active', modulos: estado.modulos } }),
}));

function montar() {
  return render(
    <MemoryRouter initialEntries={['/admin/emails']}>
      <Routes>
        <Route path="/admin/chat" element={<div>chat</div>} />
        <Route
          path="/admin/emails"
          element={<RotaDeModulo modulo="emails"><div>tela de emails</div></RotaDeModulo>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RotaDeModulo', () => {
  it('desligado redireciona para o chat', () => {
    estado.modulos = ['extracao'];
    montar();
    expect(screen.getByText('chat')).toBeTruthy();
  });
  it('ligado mostra a tela', () => {
    estado.modulos = ['emails'];
    montar();
    expect(screen.getByText('tela de emails')).toBeTruthy();
  });
  it('cache sem modulos mostra a tela', () => {
    estado.modulos = undefined;
    montar();
    expect(screen.getByText('tela de emails')).toBeTruthy();
  });
});
