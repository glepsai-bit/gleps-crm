# Whitelabel Gleps IA — T-014

> Documento consolidado da branch `whitelabel/gleps-ia`. Fonte única de verdade.
> Quem entra nesta branch lê este arquivo PRIMEIRO. Detalhes operacionais no [handoff-log](.claude/team/handoff-log.md#2026-06-15-whitelabel-gleps-ia).

---

## Identidade

| Item | Valor |
|---|---|
| Nome da marca | **Gleps IA** |
| Slogan | "A inteligência comercial que seu negócio precisa." |
| Domínio alvo | `crm.gleps.com.br` |
| Branch | `whitelabel/gleps-ia` |
| Base | `origin/main` (commit `08a1651`) |

### Paleta

| Token | Hex | HSL (Tailwind format) | Uso |
|---|---|---|---|
| Roxo Escuro | `#22003D` | `273 100% 12%` | Sidebar / fundos profundos |
| **Roxo Principal** | `#5B3DF5` | `250 90% 60%` | `--primary` |
| **Roxo Claro** | `#8A6CFF` | `252 100% 71%` | `--accent` |
| Branco | `#FFFFFF` | `0 0% 100%` | Texto sobre roxo |

### Logo

- Formato: PNG (cliente entregou via chat)
- Destino: `public/favicon.png` (substituir o atual do GoodLeads)
- Visual: marca geométrica "g" + letras estilizadas, fundo roxo escuro, elementos em roxo principal/claro/branco
- Se Front precisar de SVG, pode gerar a partir do PNG ou pedir ao usuário

---

## Arquitetura do deploy (NÃO compartilha nada com GoodLeads)

```
GoodLeads (existente)          Gleps IA (este whitelabel)
───────────────────────       ────────────────────────────
goodleads.mychooice.com        crm.gleps.com.br
  ├── frontend                   ├── frontend (esta branch)
  ├── backend Express            ├── backend Express PRÓPRIO
  ├── postgres (DB próprio)      ├── postgres PRÓPRIO
  └── redis                      └── redis PRÓPRIO

Mesma VPS — services independentes no EasyPanel.
Cada um com docker-compose próprio, env vars próprias, volumes próprios.
```

---

## Divisão de trabalho

### Front-end (responsável: @frontend)
Apenas identidade visual. Lista exata de arquivos no [handoff](.claude/team/handoff-log.md#2026-06-15-whitelabel-gleps-ia). Resumo:
- `src/index.css` — paleta roxa nas CSS vars
- `src/pages/LoginPage.tsx` — nome + slogan + gradient roxo
- `src/layouts/AdminLayout.tsx` / `SuperAdminLayout.tsx` — nome
- `src/components/email/EmailPreviewDialog.tsx` — nome
- `index.html` — title + theme-color + meta
- `public/favicon.*` — logo Gleps IA

### Dev Principal (responsável: @dev-principal, eu)
- `backend/src/controllers/email.controller.ts` (linhas 356, 370, 394) — strings `GoodLeads CRM` → `Gleps IA CRM`
- `backend/src/services/sendgrid.service.ts` (linhas 120, 124, 127, 130, 157) — idem
- `backend/src/services/email-ai.service.ts` (linha 41) — system prompt da IA
- `backend/src/services/email.service.ts` (linha 557) — fromName fallback
- `docker-compose.yml` — `FRONTEND_URL` default `https://crm.gleps.com.br`
- **Novo arquivo `docker-compose.gleps-ia.yml`** (ou `.env.gleps-ia.example`) — template de deploy do EasyPanel pro Gleps IA (DB próprio, JWT secret próprio, etc)
- Documentar processo de seed inicial da `account` raiz do Gleps IA (super_admin + primeiro admin)

### QA (responsável: @qa)
Validação visual + funcional após Front + Dev terminarem. Critérios:
1. Smoke test do backend isolado (DB próprio funciona, login do seed funciona, multi-tenant intacto)
2. UI sem nenhuma string "GoodLeads" remanescente em telas
3. Logo aparece corretamente em todas as resoluções (sidebar, favicon do navegador, tela de login)
4. E-mails de teste com remetente "Gleps IA CRM"
5. Não-regressão: roda `qa:smoke` 42/45 esperado (3 falhas Chatwoot esperadas em local sem creds)
6. Métricas/Chatwoot/n8n: nenhuma referência cruzada ao banco GoodLeads

---

## Ordem de execução recomendada

1. **Dev Principal coloca o logo em `public/favicon.png`** assim que o usuário enviar o arquivo (status: ⏳ pendente entrega no filesystem)
2. **Dev Principal faz a parte de backend** (strings + docker-compose + env template) — pode rodar em paralelo com Front
3. **Front-end faz a parte de UI** (paleta + nome + slogan)
4. **QA valida** (visual + funcional + smoke)
5. **Usuário autoriza push** da branch
6. **Usuário configura no EasyPanel:**
   - Novo service Compose, branch `whitelabel/gleps-ia`, `docker-compose.gleps-ia.yml` (se a gente partir esse arquivo) OU `docker-compose.yml` com env vars sobrescritas no painel
   - DNS `crm.gleps.com.br` → IP da VPS (apontar antes do HTTPS)
   - Domínio + Let's Encrypt no service
7. **Pós-deploy:** rodar seed do super_admin no banco Gleps IA (instrução vai no doc final do Dev Principal)

---

## Status do logo (BLOQUEIO ATUAL)

⏳ **Aguardando arquivo no filesystem.**

O usuário enviou o PNG via chat mas o Dev Principal só consegue commitar arquivos que existam no disco. Opções pro usuário:
- **(a)** Salvar o PNG em `~/Desktop/gleps-ia-logo.png` e me avisar — eu copio pra `public/favicon.png` e gero variações (`.ico` se possível)
- **(b)** Salvar direto em `/tmp/crm-whitelabel-gleps-ia/public/favicon.png` (substituindo o existente) — eu commito direto
- **(c)** Me passar uma URL pública do logo — eu baixo via `curl` (menos seguro)

Recomendado: **(a)**. Assim que chegar, faço o commit dedicado do asset.
