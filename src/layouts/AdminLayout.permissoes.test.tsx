/**
 * Menu do admin para AGENTE, com o usePermissions de verdade.
 *
 * Trava: o item "Dashboard" (/admin/chat/dashboard) aparece para quem tem a
 * permissão `dashboard` e some para quem não tem; Chat aparece sempre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminLayout from './AdminLayout';

const estado = vi.hoisted(() => ({
  permissions: ['dashboard'] as string[],
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u-agente',
      nome: 'Ana Agente',
      email: 'ana@clinica.com',
      role: 'agent',
      account_id: 'a1',
      permissions: estado.permissions,
    },
    account: { id: 'a1', nome: 'Clínica', status: 'active', modulos: ['extracao', 'disparos'] },
    logout: vi.fn(),
    isImpersonating: false,
    exitImpersonation: vi.fn(),
  }),
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

function sidebarDesktop() {
  const aside = document.querySelector('aside.hidden.lg\\:flex') as HTMLElement;
  return within(aside);
}

function renderizar() {
  return render(
    <MemoryRouter initialEntries={['/admin/chat']}>
      <AdminLayout>
        <div>conteudo</div>
      </AdminLayout>
    </MemoryRouter>,
  );
}

describe('AdminLayout — permissões do agente', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("agente com ['dashboard'] vê Chat e Dashboard, e não vê Kanban/Leads", () => {
    estado.permissions = ['dashboard'];
    renderizar();
    const nav = sidebarDesktop();
    expect(nav.getByText('Chat')).toBeTruthy();
    expect(nav.getByText('Dashboard')).toBeTruthy();
    expect(nav.queryByText('Kanban')).toBeNull();
    expect(nav.queryByText('Leads')).toBeNull();
  });

  it("agente com ['kanban'] não vê Dashboard", () => {
    estado.permissions = ['kanban'];
    renderizar();
    const nav = sidebarDesktop();
    expect(nav.getByText('Kanban')).toBeTruthy();
    expect(nav.queryByText('Dashboard')).toBeNull();
  });
});
