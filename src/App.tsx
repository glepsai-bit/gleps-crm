// App root component with authentication and routing – sync test
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useBackend } from "@/config/backend.config";

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
import SuperAdminUsersPage from "./pages/super-admin/SuperAdminUsersPage";

// Admin
import AdminLayout from "./layouts/AdminLayout";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminKanbanPage from "./pages/admin/AdminKanbanPage";
import AdminLeadsPage from "./pages/admin/AdminLeadsPage";
import AdminSalesPage from "./pages/admin/AdminSalesPage";

import AdminFinancePage from "./pages/admin/AdminFinancePage";
import AdminProductsPage from "./pages/admin/AdminProductsPage";
import AdminAgendaPage from "./pages/admin/AdminAgendaPage";
import AdminInsightsPage from "./pages/admin/AdminInsightsPage";
import AdminExtracaoPage from "./pages/admin/AdminExtracaoPage";
import AdminEmailsPage from "./pages/admin/AdminEmailsPage";

const queryClient = new QueryClient();

// Wrapper component to provide contexts with accountId and userId from AuthContext
// TagProvider must be outside FinanceProvider because FinanceContext uses TagContext
function AdminFinanceWrapper({ children }: { children: React.ReactNode }) {
  const { account, user } = useAuth();
  const accountId = account?.id || 'acc-1';
  const userId = user?.id || '';
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
    <TooltipProvider>
      <BrowserRouter>
        <AuthProvider>
          <Toaster />
          <Sonner />
          <Routes>
            {/* Public Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />

            {/* Super Admin Routes */}
            <Route path="/super-admin" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminDashboard /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/accounts" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminAccountsPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/accounts/:accountId" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminAccountDetailPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />
            <Route path="/super-admin/users" element={<ProtectedRoute requireSuperAdmin><SuperAdminLayout><ErrorBoundary><SuperAdminUsersPage /></ErrorBoundary></SuperAdminLayout></ProtectedRoute>} />

            {/* Admin Routes */}
            <Route path="/admin" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminDashboard /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/kanban" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminKanbanPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/leads" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminLeadsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/sales" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminSalesPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            
            <Route path="/admin/finance" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminFinancePage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/products" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminProductsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/agenda" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminAgendaPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/insights" element={<ProtectedRoute allowedRoles={['admin', 'super_admin', 'agent']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminInsightsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/prospeccao" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminExtracaoPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            <Route path="/admin/emails" element={<ProtectedRoute allowedRoles={['admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminEmailsPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />
            
            {/* Agent Routes */}
            <Route path="/agent" element={<ProtectedRoute allowedRoles={['agent', 'admin', 'super_admin']}><AdminFinanceWrapper><AdminLayout><ErrorBoundary><AdminKanbanPage /></ErrorBoundary></AdminLayout></AdminFinanceWrapper></ProtectedRoute>} />

            {/* Default redirect */}
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
