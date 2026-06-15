# N8N Flow Builder

Página web standalone (HTML + CSS + JS puro, sem build, sem servidor) que **gera o JSON do fluxo n8n SDR já customizado por cliente**. Você preenche um formulário, escolhe um template de prompt da galeria, e baixa o JSON pronto pra importar no n8n.

> **Tudo client-side.** As credenciais (Chatwoot token, Evolution API key, webhook secret) ficam em memória do navegador — nunca trafegam pra servidor nenhum, nunca são persistidas em disco.

---

## Como usar (operação)

1. Acessar a URL do builder (após deploy) ou abrir `index.html` localmente (também funciona em `file://`).
2. **Seção 1:** clicar num template de prompt (SDR Consultivo, Suporte, Agendamento, Recuperação, Em Branco).
3. **Seção 2:** preencher as variáveis do template (`{{company_name}}`, `{{persona_name}}` etc.).
4. **Seção 3:** preencher os 10 campos de credenciais e integrações do cliente.
5. **Seção 4:** clicar em **"Gerar e baixar JSON"** ou **"Copiar JSON"** pro clipboard.
6. No n8n: **Workflows → ⋮ → Import from File** → seleciona o JSON baixado. Ou **Cmd+V** se copiou.
7. No n8n, **vincular credenciais** (Postgres, Redis, OpenAI) pelos IDs nomeados em `Setup_Instructions1`.
8. **Ativar** o workflow e configurar o webhook no Chatwoot.

---

## O que o builder substitui no template

Cada JSON gerado tem **3 famílias de substituição**:

### 1. Nó `config1` (10 campos)

| Campo | Origem |
|---|---|
| `chatwoot_url` | form |
| `chatwoot_token` (sensível) | form |
| `chatwoot_account_id` | form |
| `evolution_url` | form |
| `evolution_apikey` (sensível) | form |
| `evolution_instance` | form (default "Amanda") |
| `mcp_endpoint` | form |
| `debounce_seconds` | form (default 20) |
| `backend_url` | form |
| `backend_webhook_secret` (sensível) | form |

### 2. Nó `MCP Client1`
- `parameters.endpointUrl` recebe o mesmo `mcp_endpoint` do `config1` (não usa expressão).

### 3. Prompts dos AI Agents
- `AI Agent` (classificador) → `parameters.options.systemMessage`
- `AI Agent8` (respondedor) → `parameters.options.systemMessage`

Os prompts da galeria têm variáveis `{{company_name}}`, `{{persona_name}}` etc. que são interpoladas no momento da geração.

**Não toca em mais nada** — credenciais (OpenAI, Postgres, Redis) ficam vinculadas por ID no n8n do tenant.

---

## Galeria de prompts incluída

| ID | Nome | Uso |
|---|---|---|
| `sdr-consultivo-b2b` | SDR Consultivo B2B | Diagnóstico + qualificação por faturamento + agendamento (base MyChooice, com fluxo completo de reagendamento) |
| `suporte-faq` | Suporte / FAQ Inteligente | Atende dúvidas operacionais, escala pra humano em cobrança/jurídico |
| `agendamento-simples` | Agendamento Simples | Foca em marcar reunião, sem qualificação profunda |
| `recuperacao-lead` | Recuperação de Lead Frio | Reativação com tom leve, sem cobrança |
| `em-branco` | Em branco | Escrever o prompt do zero |

Cada template tem variáveis específicas (form da seção 2). Os prompts são editáveis também no próprio builder (seção 1 → "Ver/editar os prompts"), e depois ajustáveis no próprio n8n.

---

## Rodando localmente (dev)

Não precisa de build, npm, nada. Abre o `index.html` no navegador:

```sh
open tools/n8n-flow-builder/index.html
# ou
python3 -m http.server -d tools/n8n-flow-builder 8000
# depois: http://localhost:8000
```

---

## Deploy no EasyPanel

O builder é um **app separado** do CRM principal. Roteiro:

### 1. DNS
Apontar um subdomínio (ex.: `builder.mychooice.com`) pro IP da VPS antes de salvar no EasyPanel.

> **Subdomínio separado é mandatório por segurança** — a página recebe tokens sensíveis no form. Isolamento de origin (Same-Origin Policy) impede que JS de outras origens leiam os tokens.

### 2. App novo no EasyPanel
- **Tipo:** Dockerfile (não Compose).
- **Source:** Git → mesmo repo do CRM.
- **Branch:** `main` (ou a branch desta entrega).
- **Build Path:** `tools/n8n-flow-builder` (subpasta).
- **Dockerfile:** `Dockerfile` (default).
- **Porta interna:** 80.

### 3. Domínio
- Domínio → `builder.mychooice.com` (ou seu subdomínio).
- **HTTPS automático** via Traefik/Let's Encrypt (EasyPanel resolve sozinho).

### 4. Deploy
Clique **Deploy**. O EasyPanel pega o repo, builda a imagem do Dockerfile (uma única stage com nginx:alpine), e Traefik roteia pro subdomínio.

### 5. Verificar
- `https://builder.mychooice.com/health` → "ok"
- `https://builder.mychooice.com/` → carrega a página

### Atualizar o builder
Toda vez que `tools/n8n-flow-builder/` for atualizada na main, basta clicar **Rebuild** no app do EasyPanel. Sem migração de estado, sem downtime do CRM principal.

---

## Atualizar o template do fluxo n8n

Quando o `docs/n8n_flow_ia.json` mudar (nova versão do fluxo n8n principal), regenerar o `template.js` local:

```sh
cd tools/n8n-flow-builder
node -e '
const fs = require("fs");
const flow = JSON.parse(fs.readFileSync("../../docs/n8n_flow_ia.json","utf8"));
// sanitiza tokens, telefones, prompts (vide commit T-013 inicial)
// ...
fs.writeFileSync("template.js","window.N8N_TEMPLATE=" + JSON.stringify(flow,null,2) + ";");
'
```

Ou simplesmente rodar o script de sanitização incluso no commit de origem (`T-013`). Sempre confirmar que tokens reais não foram parar no `template.js` antes de commitar.

---

## Atualizar a galeria de prompts

Adicionar novos templates em `prompts/gallery.js`:

```js
window.PROMPT_GALLERY = [
  // ... templates existentes
  {
    id: 'novo-template',
    name: 'Nome do Template',
    description: 'O que ele faz, quando usar',
    variables: [
      { key: 'company_name', label: 'Nome da empresa', placeholder: '...', required: true },
    ],
    classifier: '=## PERSONA\n...', // prompt do classificador
    responder:  '=# PERSONA\n...',   // prompt do respondedor
  },
];
```

Usar `{{variavel}}` no texto pra que o builder interpole com os valores do form.

---

## Segurança

| Item | Tratamento |
|---|---|
| Credenciais sensíveis (3 campos) | Memória apenas. Não vão pra `localStorage`/`sessionStorage`. Some ao fechar a aba. |
| Outros campos do form | `sessionStorage` (some ao fechar a aba). |
| Tracking / analytics | Nenhum. Sem requisições externas. |
| CSP | Restritiva (`default-src 'self'`, `connect-src 'self'`). |
| HSTS | `max-age=31536000; includeSubDomains` |
| HTTPS | Obrigatório (Traefik/Let's Encrypt) |
| `frame-ancestors` | `'none'` — impede iframing de outras origens |

---

## Arquivos

```
tools/n8n-flow-builder/
├── index.html             # UI
├── styles.css             # estilos (~150 linhas, dark)
├── app.js                 # lógica (~250 linhas, vanilla JS)
├── template.js            # JSON do n8n flow embutido (~87 KB, sanitizado)
├── prompts/
│   └── gallery.js         # galeria de prompts (~30 KB, 5 templates)
├── Dockerfile             # single-stage nginx:alpine
├── nginx.conf             # CSP, HSTS, gzip, headers de segurança
├── .dockerignore
└── README.md              # este arquivo
```
