// App root component with authentication and routing – sync test
// Toaster: usamos APENAS Sonner. O Radix `<Toaster />` foi removido para
// eliminar a duplicação de landmarks `region` (Notifications F8 + alt+T)
// no DOM. O hook `useToast()` em `@/hooks/use-toast` agora é um adapter
// que delega para o Sonner, preservando compat com 20+ call sites.
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useBackend } from "@/config/backend.config";
import { createAppQueryClient } from "@/lib/query-client";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";

// Auth providers
import { AuthProvider as SupabaseAuthProvider, useAuth } from "@/contexts/AuthContext";
import { BackendAuthProvider } from "@/contexts/AuthContext.backend";

// Select the correct provider based on backend flag
const AuthProvider = useBackend ? BackendAuthProvider : SupabaseAuthProvider;

import { FinanceProvider } from "@/contexts/FinanceContext";
import { TagProvider } from "@/contexts/TagContext";
import { ProductProvider } from "@/contexts/ProductContext";
import { CalendarProvider } from "@/contexts/CalendarContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Pages
import LoginPage from "./pages/LoginPage";
import UnauthorizedPage from "./pages/UnauthorizedPage";

// Super Admin
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import SuperAdminDashboard from "./pages/super-admin/SuperAdminDashboard";
import SuperAdminAccountsPage from "./pages/super-admin/SuperAdminAccountsPage";
import SuperAdminAccountDetailPage from "./pages/super-admin/SuperAdminAccountDetailPage";
import SuperAdminApiKeysPage from "./pages/super-admin/SuperAdminApiKeysPage";
import SuperAdminUsersPage from "./pages/super-admin/SuperAdminUsersPage";
import SuperAdminSystemSettingsPage from "./pages/super-admin/SuperAdminSystemSettingsPage";

// Admin
import AdminLayout from "./layouts/AdminLayout";
import AdminKanbanPage from "./pages/admin/AdminKanbanPage";
import AdminLeadsPage from "./pages/admin/AdminLeadsPage";
import AdminSalesPage from "./pages/admin/AdminSalesPage";

import AdminFinancePage from "./pages/admin/AdminFinancePage";
import AdminProductsPage from "./pages/admin/AdminProductsPage";
import AdminAgendaPage from "./pages/admin/AdminAgendaPage";
import AdminExtracaoPage from "./pages/admin/AdminExtracaoPage";
import AdminEmailsPage from "./pages/admin/AdminEmailsPage";
import AdminWhatsappTemplatesPage from "./pages/admin/AdminWhatsappTemplatesPage";
import AdminIntegracoesPage from "./pages/admin/AdminIntegracoesPage";
import AdminOptOutsPage from "./pages/admin/AdminOptOutsPage";

// Atendimento (T-022)
import AdminChatPage from "./pages/admin/AdminChatPage";
import AdminChatDashboardPage from "./pages/admin/AdminChatDashboardPage";
import AdminInboxesPage from "./pages/admin/AdminInboxesPage";
import AdminTeamsPage from "./pages/admin/AdminTeamsPage";
import AdminCannedResponsesPage from "./pages/admin/AdminCannedResponsesPage";
import AdminSLAPoliciesPage from "./pages/admin/AdminSLAPoliciesPage";
import AdminCustomAttributesPage from "./pages/admin/AdminCustomAttributesPage";

// CRITICAL #3: QueryClient com handlers default de erro (toast em 5xx/network).
// Detalhes em src/lib/query-client.ts.
const queryClient = createAppQueryClient();

// Hook montado uma unica vez no boot. Precisa estar DENTRO do BrowserRouter
// (caso futuras versoes usem useNavigate/useLocation), mas pode ficar fora
// do AuthProvider — status de rede e independente de auth. Encapsulamos
// num componente filho pra usar hooks no topo da App sem quebrar a regra
// "hooks dentro de componentes".
function NetworkStatusWatcher() {
  useNetworkStatus();
  return null;
}

// Wrapper component to provide contexts with accountId and userId from AuthContext
// TagProvider must be outside FinanceProvider because FinanceContext uses TagContext
//
// L-CROSS-2: antes usávamos `account?.id || 'acc-1'` como fallback durante a
// hidratação do AuthContext. O id mock 'acc-1' vazava pra TODAS as queries
// (TagProvider, FinanceProvider, ProductProvider, CalendarProvider), que então
// disparavam fetches `?accountId=acc-1` — no melhor caso 404, no pior caso
// retornavam dados da conta errada se 'acc-1' existisse de fato em outra
// instância. Agora passamos `?? null` e cada provider tem guard pra não
// disparar query enquanto o accountId não for resolvido.
function AdminFinanceWrapper({ children }: { children: React.ReactNode }) {
  const { account, user } = useAuth();
  const accountId = account?.id ?? null;
  const userId = user?.id ?? null;
  return (
    <TagProvider accountId={accountId}>
      <FinanceProvider accountId={accountId}>
        <ProductProvider accountId={accountId}>
          <CalendarProvider accountId={accountId} userId={userId}>
            {children}
          </CalendarProvider>
        </ProductProvider>
      </FinanceProvider>
    </TagProvider>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <BrowserRouter>
          <AuthProvider>
            <Sonner />
            <NetworkStatusWatcher />
          <Routes>
            {/* Public Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />

            {/* Super Admin Routes */}
            <Route path="/super-admin" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminDashboard /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/accounts" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminAccountsPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/accounts/:accountId" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminAccountDetailPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/accounts/:accountId/api-keys" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminApiKeysPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/users" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminUsersPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/system-settings" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminSystemSettingsPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />

            {/* Admin Routes */}
            <Route path="/admin" element={<Navigate to="/admin/chat" replace />} />
            <Route path="/admin/kanban" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminKanbanPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/leads" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminLeadsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/sales" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminSalesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            
            <Route path="/admin/finance" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminFinancePage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/products" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminProductsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/agenda" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminAgendaPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/prospeccao" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminExtracaoPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/emails" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminEmailsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/whatsapp-templates" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminWhatsappTemplatesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/integracoes" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminIntegracoesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/opt-outs" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminOptOutsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />

            {/* Atendimento (T-022) */}
            <Route path="/admin/chat" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminChatPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/chat/dashboard" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminChatDashboardPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/inboxes" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminInboxesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/teams" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminTeamsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/canned-responses" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminCannedResponsesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/sla-policies" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminSLAPoliciesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/custom-attributes" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminCustomAttributesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />

            {/* Agent Routes */}
            <Route path="/agent" element={<ProtectedRoute allowedRoles={['agent', 'admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminKanbanPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />

            {/* Default redirect */}
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
