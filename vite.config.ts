import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { execSync } from "node:child_process";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Check both loadEnv (reads .env files) and process.env (Docker ENV)
  const useBackend = env.VITE_USE_BACKEND === 'true' || process.env.VITE_USE_BACKEND === 'true';

  // MARCADOR DE BUILD.
  //
  // Existe porque "qual versão está no ar?" já custou horas de confusão: o app
  // do frontend e o do backend são publicados separados, e não havia nada na
  // tela que dissesse qual commit ela é. Comparar pixel com código não é
  // diagnóstico.
  //
  // O timestamp é o que importa — ele SEMPRE existe, mesmo sem git na imagem
  // alpine e sem o painel passar nada. O hash do commit é bônus.
  const gitSha = (() => {
    try {
      return execSync('git rev-parse --short HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  })();
  const buildCommit =
    process.env.VITE_COMMIT_SHA || process.env.SOURCE_COMMIT || gitSha || 'local';
  const buildTime = new Date().toISOString();

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        '/socket.io': {
          target: env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    plugins: [
      react(),
      mode === "development" && componentTagger(),
      {
        // No <head> também: permite conferir a versão em produção por curl,
        // sem abrir navegador nem depender de alguém descrever a tela.
        name: 'build-meta',
        transformIndexHtml: (html: string) =>
          html.replace(
            '</head>',
            `  <meta name="app-build" content="${buildCommit} ${buildTime}" />\n  </head>`
          ),
      },
    ].filter(Boolean),
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommit),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    resolve: {
      alias: [
        ...(useBackend
          ? [{ find: '@/integrations/supabase/client', replacement: path.resolve(__dirname, './src/integrations/supabase/client.backend-stub.ts') }]
          : []),
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
  };
});
