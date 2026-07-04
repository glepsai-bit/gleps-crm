/**
 * Express app minimo pros testes (sem socket, sem cron, sem helmet/CSP).
 * Replica os middlewares essenciais do server.ts pra exercitar routes
 * de verdade via supertest.
 *
 * NAO usar em producao — isolado pra contexto de teste.
 */

import express from 'express';
import cors from 'cors';
import routes from '../routes';
import { errorHandler, notFoundHandler } from '../middlewares/error.middleware';

export function createTestApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(
    express.json({
      limit: '24mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '24mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', test: true });
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
