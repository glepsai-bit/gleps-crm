/**
 * Menu do admin filtrado por módulos da conta.
 *
 * Trava: módulo desligado esconde o item; cache antigo sem `modulos` mostra
 * tudo (não esconder tela por cache velho); o filtro de permissão do agente
 * continua valendo; Configurações é recolhível e lembra o estado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminLayout from './AdminLayout';

const estado = vi.hoisted(() => ({
  account: { id: 'a1', nome: 'Clínica', status: 'active' } as { id: string; nome: string; status: string; modulos?: string[] },
  permitido: ((_: string) => true) as (r: string) => boolean,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    account: estado.account,
    logout: vi.fn(),
    isImpersonating: false,
    exitImpersonation: vi.fn(),
  }),
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ canAccessRoute: (r: string) => estado.permitido(r) }),
}));
vi.mock('@/hooks/usePushNotifications', () => ({ usePushNotifications: vi.fn() }));
vi.mock('@/services/socket.client', () => ({
  chatSocket: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendHeartbeat: vi.fn(),
    onMention: () => () => {},
  },
}));
vi.mock('@/services/agent-availability.backend.service', () => ({
  agentAvailabilityBackendService: {
    setMyStatus: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/services/messages.backend.service', () => ({
  messagesBackendService: { getMentions: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/api/client', () => ({ tokenManager: { getToken: () => null } }));
vi.mock('@/config/build.config', () => ({
  BUILD_COMMIT: 'teste',
  BUILD_LABEL: 'teste',
  BUILD_TITLE: 'teste',
}));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/branding/Logo', () => ({ Logo: () => null }));

// A sidebar desktop e a mobile renderizam o mesmo menu; olhamos só a desktop.
function sidebarDesktop() {
  const aside = document.querySelector('aside.hidden.lg\\:flex') as HTMLElement;
  return within(aside);
}

function renderizar(caminho = '/admin/chat') {
  return render(
    <MemoryRouter initialEntries={[caminho]}>
      <AdminLayout>
        <div>conteudo</div>
      </AdminLayout>
    </MemoryRouter>,
  );
}

describe('AdminLayout — módulos', () => {
  beforeEach(() => {
    localStorage.clear();
    estado.permitido = () => true;
  });

  it('esconde E-mails quando a conta não tem "emails" e mostra Extração/Disparos', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active', modulos: ['extracao', 'disparos'] };
    renderizar();
    const nav = sidebarDesktop();
    expect(nav.queryByText('E-mails')).toBeNull();
    expect(nav.queryByText('Discador')).toBeNull();
    expect(nav.queryByText('Vendas')).toBeNull();
    expect(nav.getByText('Extração')).toBeTruthy();
    expect(nav.getByText('Disparos')).toBeTruthy();
    expect(nav.getByText('Dashboard')).toBeTruthy();
    expect(nav.queryByText('Dashboard Chat')).toBeNull();
    expect(nav.queryByText('Produtos')).toBeNull();
    expect(nav.queryByText('Execuções')).toBeNull();
  });

  it('mostra E-mails quando "emails" está ligado', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active', modulos: ['extracao', 'disparos', 'emails'] };
    renderizar();
    expect(sidebarDesktop().getByText('E-mails')).toBeTruthy();
  });

  it('cache sem `modulos` mostra tudo', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active' };
    renderizar();
    const nav = sidebarDesktop();
    for (const t of ['E-mails', 'Discador', 'Vendas', 'Financeiro', 'Aquecimento', 'Extração', 'Disparos']) {
      expect(nav.getByText(t)).toBeTruthy();
    }
  });

  it('o filtro de permissão do agente continua valendo junto com o de módulo', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active', modulos: ['extracao', 'disparos'] };
    estado.permitido = (r) => r !== '/admin/leads' && r !== '/admin/prospeccao';
    renderizar();
    const nav = sidebarDesktop();
    expect(nav.queryByText('Leads')).toBeNull();
    expect(nav.queryByText('Extração')).toBeNull(); // permissão nega
    expect(nav.getByText('Disparos')).toBeTruthy();
  });

  it('Configurações começa recolhido, abre ao clicar e lembra no localStorage', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active', modulos: [] };
    const { unmount } = renderizar();
    expect(sidebarDesktop().queryByText('Inboxes')).toBeNull();
    fireEvent.click(sidebarDesktop().getByRole('button', { name: /Configurações/ }));
    expect(sidebarDesktop().getByText('Inboxes')).toBeTruthy();
    expect(sidebarDesktop().getByText('Integrações')).toBeTruthy();
    unmount();
    renderizar();
    expect(sidebarDesktop().getByText('Inboxes')).toBeTruthy();
  });

  it('abre Configurações sozinho quando a rota atual é uma delas', () => {
    estado.account = { id: 'a1', nome: 'C', status: 'active', modulos: [] };
    renderizar('/admin/teams');
    expect(sidebarDesktop().getByText('Times')).toBeTruthy();
  });
});
