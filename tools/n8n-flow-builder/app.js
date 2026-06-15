// GoodLeads Flow Builder — logica vanilla JS, client-side puro.
// Sem framework, sem build, sem dependencia externa. Roda em file:// e em servidor estatico.

(function () {
  'use strict';

  // ============================================
  // Estado em memoria (campos sensiveis NUNCA vao pra sessionStorage)
  // ============================================
  const SENSITIVE = new Set(['chatwoot_token', 'evolution_apikey', 'backend_webhook_secret']);
  // Os outros campos podem viver na sessionStorage por conveniencia (some ao fechar a aba).
  const PERSIST_KEY = 'n8n_flow_builder_state_v1';

  let selectedTemplateId = null;
  let varValues = {}; // {company_name: '...', persona_name: '...'}

  // ============================================
  // DOM helpers
  // ============================================
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  };

  // ============================================
  // Galeria de prompts
  // ============================================
  function renderGallery() {
    const container = $('gallery');
    container.innerHTML = '';
    for (const item of window.PROMPT_GALLERY) {
      const node = el('div', {
        class: 'gallery-item',
        'data-id': item.id,
        onclick: () => selectTemplate(item.id),
      },
        el('h3', {}, item.name),
        el('p', {}, item.description),
      );
      container.appendChild(node);
    }
  }

  function selectTemplate(id) {
    selectedTemplateId = id;
    const item = window.PROMPT_GALLERY.find(g => g.id === id);
    if (!item) return;

    // Visual: marcar selecionado
    document.querySelectorAll('.gallery-item').forEach(n => {
      n.classList.toggle('selected', n.dataset.id === id);
    });

    // Preview dos prompts
    $('classifier-preview').value = item.classifier;
    $('responder-preview').value = item.responder;

    // Render do form de variaveis
    renderVars(item.variables);

    persistState();
  }

  function renderVars(vars) {
    const form = $('vars-form');
    form.innerHTML = '';

    if (!vars || vars.length === 0) {
      $('vars-card').hidden = true;
      return;
    }
    $('vars-card').hidden = false;

    for (const v of vars) {
      const wrap = el('div', {});
      const label = el('label', { for: `var-${v.key}` },
        v.label,
        v.required ? el('span', { class: 'req' }, ' *') : null,
      );
      const input = el('input', {
        type: 'text',
        id: `var-${v.key}`,
        placeholder: v.placeholder || '',
        autocomplete: 'off',
        oninput: (e) => {
          varValues[v.key] = e.target.value;
          persistState();
        },
      });
      input.value = varValues[v.key] || '';
      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
    }
  }

  // ============================================
  // Interpolacao de {{vars}} no prompt
  // ============================================
  function interpolate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
      return vars[key] != null ? vars[key] : m; // mantem placeholder se nao tiver valor
    });
  }

  // ============================================
  // Coleta de valores do form
  // ============================================
  function readConfigFields() {
    const fields = [
      'chatwoot_url', 'chatwoot_token', 'chatwoot_account_id',
      'evolution_url', 'evolution_apikey', 'evolution_instance',
      'mcp_endpoint', 'debounce_seconds',
      'backend_url', 'backend_webhook_secret',
    ];
    const out = {};
    for (const f of fields) {
      const v = $(f).value;
      out[f] = (f === 'debounce_seconds') ? Number(v || 20) : v;
    }
    return out;
  }

  // ============================================
  // Validacao
  // ============================================
  function validate(config) {
    const errors = [];
    if (!selectedTemplateId) errors.push('Selecione um template de prompt na seção 1.');

    if (!config.chatwoot_url) errors.push('chatwoot_url é obrigatório.');
    if (!config.chatwoot_token) errors.push('chatwoot_token é obrigatório.');
    if (!config.chatwoot_account_id) errors.push('chatwoot_account_id é obrigatório.');
    if (!config.mcp_endpoint) errors.push('mcp_endpoint é obrigatório.');
    if (!config.backend_url) errors.push('backend_url é obrigatório.');
    if (!config.backend_webhook_secret) errors.push('backend_webhook_secret é obrigatório (segurança do webhook).');

    // URL sanity
    for (const k of ['chatwoot_url', 'mcp_endpoint', 'backend_url', 'evolution_url']) {
      if (config[k] && !/^https?:\/\//.test(config[k])) {
        errors.push(`${k} deve começar com http:// ou https://.`);
      }
    }

    // Variaveis required do template
    if (selectedTemplateId) {
      const tpl = window.PROMPT_GALLERY.find(g => g.id === selectedTemplateId);
      for (const v of (tpl.variables || [])) {
        if (v.required && !varValues[v.key]) {
          errors.push(`Variável "${v.label}" é obrigatória.`);
        }
      }
    }

    return errors;
  }

  function showValidation(errors) {
    const box = $('validation');
    if (errors.length === 0) {
      box.className = 'validation ok';
      box.textContent = '✓ Tudo certo. Pronto pra gerar.';
    } else {
      box.className = 'validation error';
      box.innerHTML = '<strong>Corrija antes de gerar:</strong><br>• ' + errors.join('<br>• ');
    }
  }

  // ============================================
  // Geracao do JSON
  // ============================================
  function buildFlow(config) {
    // Deep clone do template (evita mutar o original em memoria)
    const flow = JSON.parse(JSON.stringify(window.N8N_TEMPLATE));

    // 1. Atualizar config1 (10 campos)
    const cfg = flow.nodes.find(n => n.name === 'config1');
    const assignments = cfg.parameters.assignments.assignments;
    const CONFIG_KEYS = new Set([
      'chatwoot_url', 'chatwoot_token', 'chatwoot_account_id',
      'evolution_url', 'evolution_apikey', 'evolution_instance',
      'mcp_endpoint', 'debounce_seconds',
      'backend_url', 'backend_webhook_secret',
    ]);
    for (const a of assignments) {
      if (CONFIG_KEYS.has(a.name)) {
        a.value = config[a.name];
      }
    }

    // 2. Atualizar MCP Client1 (endpointUrl precisa do mesmo mcp_endpoint)
    const mcp = flow.nodes.find(n => n.name === 'MCP Client1');
    if (mcp) mcp.parameters.endpointUrl = config.mcp_endpoint;

    // 3. Substituir systemMessages dos 2 AI Agents
    const tpl = window.PROMPT_GALLERY.find(g => g.id === selectedTemplateId);
    const classifierFinal = interpolate($('classifier-preview').value || tpl.classifier, varValues);
    const responderFinal = interpolate($('responder-preview').value || tpl.responder, varValues);

    const aiAgent = flow.nodes.find(n => n.name === 'AI Agent');
    if (aiAgent) aiAgent.parameters.options.systemMessage = classifierFinal;

    const aiAgent8 = flow.nodes.find(n => n.name === 'AI Agent8');
    if (aiAgent8) aiAgent8.parameters.options.systemMessage = responderFinal;

    // 4. Renomear o workflow pra deixar claro qual cliente é
    const slug = (config.chatwoot_url || 'cliente')
      .replace(/^https?:\/\//, '').split('/')[0].split('.')[0]
      .toLowerCase().replace(/[^a-z0-9-]/g, '-');
    flow.name = `n8n SDR (${slug}) — gerado pelo builder`;

    return flow;
  }

  // ============================================
  // Acoes: Gerar / Copiar / Limpar
  // ============================================
  function generate(downloadAfter) {
    const config = readConfigFields();
    const errors = validate(config);
    showValidation(errors);
    if (errors.length > 0) return null;

    const flow = buildFlow(config);
    const json = JSON.stringify(flow, null, 2);
    $('json-preview').textContent = json;
    return json;
  }

  function download(json) {
    const config = readConfigFields();
    const slug = (config.chatwoot_url || 'cliente')
      .replace(/^https?:\/\//, '').split('/')[0].split('.')[0]
      .toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const filename = `n8n-sdr-${slug}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  async function copyToClipboard(json) {
    try {
      await navigator.clipboard.writeText(json);
      const box = $('validation');
      box.className = 'validation ok';
      box.textContent = '✓ JSON copiado pro clipboard. Cola direto no n8n.';
    } catch (e) {
      alert('Não consegui copiar pro clipboard. Use o botão "Gerar e baixar JSON" e abre o arquivo.');
    }
  }

  function clearAll() {
    if (!confirm('Limpar todo o formulário? (templates de prompt e campos)')) return;
    document.querySelectorAll('input, textarea').forEach(i => {
      if (i.type === 'number') i.value = i.defaultValue || '';
      else if (i.id === 'evolution_instance') i.value = 'Amanda';
      else if (i.id === 'debounce_seconds') i.value = '20';
      else i.value = '';
    });
    document.querySelectorAll('.gallery-item.selected').forEach(n => n.classList.remove('selected'));
    selectedTemplateId = null;
    varValues = {};
    $('vars-card').hidden = true;
    $('json-preview').textContent = 'Clique em "Gerar" pra preencher.';
    $('validation').className = 'validation';
    $('validation').textContent = '';
    sessionStorage.removeItem(PERSIST_KEY);
  }

  // ============================================
  // Persistência (sessionStorage) — só campos NÃO sensíveis
  // ============================================
  function persistState() {
    const config = readConfigFields();
    const safe = {};
    for (const [k, v] of Object.entries(config)) {
      if (!SENSITIVE.has(k)) safe[k] = v;
    }
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify({
      config: safe,
      selectedTemplateId,
      varValues,
    }));
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      for (const [k, v] of Object.entries(state.config || {})) {
        if ($(k) && !SENSITIVE.has(k)) $(k).value = v;
      }
      if (state.selectedTemplateId) {
        varValues = state.varValues || {};
        selectTemplate(state.selectedTemplateId);
      }
    } catch (_) { /* ignore */ }
  }

  // ============================================
  // Bootstrap
  // ============================================
  document.addEventListener('DOMContentLoaded', () => {
    renderGallery();
    loadState();

    // Auto-save dos campos não-sensíveis a cada digitação
    document.querySelectorAll('input, textarea').forEach(i => {
      i.addEventListener('input', persistState);
    });

    $('btn-generate').addEventListener('click', () => {
      const json = generate(true);
      if (json) download(json);
    });
    $('btn-copy').addEventListener('click', async () => {
      const json = generate(false);
      if (json) await copyToClipboard(json);
    });
    $('btn-clear').addEventListener('click', clearAll);
  });
})();
