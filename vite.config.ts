import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Check both loadEnv (reads .env files) and process.env (Docker ENV)
  const useBackend = env.VITE_USE_BACKEND === 'true' || process.env.VITE_USE_BACKEND === 'true';

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
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
