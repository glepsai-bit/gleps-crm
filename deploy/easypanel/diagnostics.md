# GLEPS CRM - Diagnóstico Rápido (EasyPanel)

Use este guia para resolver problemas em até 3 minutos.

---

## Fluxo de Diagnóstico

```
1. "Service is not reachable" → Vá para Seção A
2. "Tela branca / não carrega" → Vá para Seção B
3. "Login falha / CORS error" → Vá para Seção C
4. "Backend em loop de restart" → Vá para Seção D
```

---

## Seção A: "Service is not reachable"

**Causa mais comum**: EasyPanel não consegue alcançar a porta do serviço.

1. **Verifique o mapeamento de domínio**:
   - O domínio está mapeado para o serviço `frontend`?
   - A porta configurada é `80`?
   - ⚠️ NÃO mapeie o domínio para o `backend` diretamente.

2. **Verifique se o frontend está rodando**:
   - Vá nos logs do serviço `frontend` no EasyPanel
   - Procure por erros do Nginx
   - Se o Nginx não iniciou, verifique a variável `BACKEND_UPSTREAM`

3. **Verifique se o backend está saudável**:
   - Vá nos logs do serviço `backend`
   - Procure por `🚀 Server running on port 3000`
   - Se não aparece, vá para a Seção D

---

## Seção B: Tela branca / não carrega

1. **Abra o DevTools do navegador** (F12 → Console)
2. **Erros de JS?** → O build do frontend pode ter falhado. Faça rebuild.
3. **Erros 404?** → O Nginx não está servindo os arquivos estáticos. Verifique se o build foi copiado para `/usr/share/nginx/html`.
4. **Sem erros?** → Pode ser cache. Limpe cache do navegador ou teste em aba anônima.

---

## Seção C: Login falha / CORS error

1. **Verifique no DevTools** → Network → Request de login
2. **Erro CORS?** → A variável `CORS_ORIGINS` ou `FRONTEND_URL` está incorreta
   - Deve ser a URL exata do domínio, COM `https://`, SEM barra final
   - Exemplo correto: `https://360.seudominio.com.br`
   - Exemplo errado: `http://360.seudominio.com.br/`

3. **Erro 502/504?** → Backend não está respondendo
   - Verifique logs do backend
   - Verifique se `BACKEND_UPSTREAM` está correto (default: `backend:3000`)

4. **Erro 401?** → Credenciais incorretas ou JWT mal configurado
   - Verifique se `JWT_SECRET` tem no mínimo 32 caracteres

---

## Seção D: Backend em loop de restart

1. **Verifique os logs do backend** no EasyPanel

2. **"Cannot connect to database"**:
   - O serviço `postgres` está rodando e healthy?
   - As variáveis `DB_USER`, `DB_PASSWORD`, `DB_NAME` estão corretas?
   - O backend depende do postgres via `depends_on` + healthcheck

3. **"Invalid environment variables"**:
   - Alguma variável obrigatória está faltando
   - Verifique especialmente: `JWT_SECRET` (min 32 chars), `REFRESH_TOKEN_SECRET` (min 32 chars), `DATABASE_URL` (auto-gerada pelo compose)

4. **Prisma migration error**:
   - Pode ser schema incompatível com banco existente
   - Solução: delete o volume `postgres_data` e rebuilde (⚠️ perde dados)

5. **Timeout no healthcheck**:
   - O `start_period` é 60s para dar tempo de migrations + seed
   - Se seu banco é grande, aumente para 120s no compose

---

## Comandos Úteis (via terminal SSH na VPS)

```bash
# Ver status dos containers
docker compose -f deploy/easypanel/docker-compose.yml ps

# Ver logs do backend (últimas 50 linhas)
docker compose -f deploy/easypanel/docker-compose.yml logs backend --tail 50

# Ver logs do frontend
docker compose -f deploy/easypanel/docker-compose.yml logs frontend --tail 50

# Testar health do backend (de dentro da rede Docker)
docker compose -f deploy/easypanel/docker-compose.yml exec frontend wget -qO- http://backend:3000/api/health

# Testar health do frontend
docker compose -f deploy/easypanel/docker-compose.yml exec frontend wget -qO- http://localhost:80/health

# Rebuild completo (após mudanças)
docker compose -f deploy/easypanel/docker-compose.yml build --no-cache
docker compose -f deploy/easypanel/docker-compose.yml up -d

# Reset total (⚠️ PERDE DADOS DO BANCO)
docker compose -f deploy/easypanel/docker-compose.yml down -v
docker compose -f deploy/easypanel/docker-compose.yml up -d --build
```

---

## Checklist de Validação Final

- [ ] `postgres` está `healthy`
- [ ] `backend` está `healthy` (pode levar até 60s)
- [ ] `frontend` está `healthy`
- [ ] Domínio mapeado para `frontend:80` no EasyPanel
- [ ] `https://seudominio.com.br` abre tela de login
- [ ] `https://seudominio.com.br/health` retorna "OK"
- [ ] Login funciona sem erro CORS
