import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App.tsx";
import "./index.css";

// PISTA A — Sentry error tracking (frontend).
// Guardado por VITE_SENTRY_DSN. Se ausente, nada é inicializado — app
// continua funcionando normalmente. tracesSampleRate=0.1 (10%) mantém
// overhead de tracing baixo em prod.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  });
}

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary
    fallback={
      <div style={{ padding: 24, fontFamily: "system-ui", color: "#111" }}>
        <h2>Algo deu errado.</h2>
        <p>Recarregue a página. Se o problema persistir, contate o suporte.</p>
      </div>
    }
  >
    <App />
  </Sentry.ErrorBoundary>
);
