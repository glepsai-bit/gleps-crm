// Auto-gerado pelo n8n-flow-builder. NAO editar manualmente.
// Origem: tools/n8n-flow-builder/template.js (cópia sanitizada do n8n_flow_ia.json)
window.N8N_TEMPLATE = {
  "name": "N8N Flow Builder Template",
  "nodes": [
    {
      "parameters": {
        "content": "## SDR-Principal+CRM v7 — Produção VPS (CRM GoodLeads)\n\n**Arquitetura final alinhada ao CRM em produção:**\n\n🎯 **Roteamento por evento** (Switch_Evento):\n• `message_created` → fluxo de IA (classificador → respondedor)\n• `conversation_resolved` → log de resolução humana\n\n🤖 **Dual-Agent:**\n1. **Classificador** (Agent_1): identifica `etapa` do funil GoodLeads (novo-lead/em-contato/agendado/em-negociacao/fechado/perdido) e detecta `transferir_para_humano`.\n2. **Respondedor** (Agent_2): gera resposta + decide `resolver_conversa`. Tem acesso a Postgres Chat Memory + MCP Calendar.\n\n📊 **Logs de resolução (HTTP → backend Express VPS):**\n• Resolução por IA: `2_Log_Resolution_AI_HTTP` → POST {backend_url}/api/chatwoot/log-resolution com `resolved_by='ai'`, `ai_participated=true`\n• Resolução humana (webhook conversation_resolved): `Log_Resolution_Human_HTTP` → POST {backend_url}/api/chatwoot/log-resolution com `resolved_by='human'`, `agent_id` do assignee, `ai_participated` derivado de `custom_attributes.ai_responded`\n• Idempotência: `ON CONFLICT (account_id, conversation_id) DO NOTHING` (migration 0003)\n• JOIN: `accounts.chatwoot_account_id = $1::text` mapeia ID Chatwoot → UUID interno\n\n🔄 **Transbordo real:**\nMark_handoff → Buscar_Agentes → Sortear_Agente (online aleatório) → Atribuir_Agente\n\n📦 **Setup obrigatório:**\n• Credencial Postgres VPS (mesma do `Postgres Chat Memory1`) nos 2 nodes Postgres novos\n• Preencher `config`: chatwoot_token, evolution_apikey, evolution_instance, mcp_endpoint\n• Chatwoot: webhook único apontando para `/webhook/sdr-goodleads-completo` com eventos `Message Created` + `Conversation Resolved`",
        "height": 752,
        "width": 720
      },
      "type": "n8n-nodes-base.stickyNote",
      "position": [
        -5632,
        -400
      ],
      "typeVersion": 1,
      "id": "aae1f63a-df0f-45fc-b653-6b72d51b0d13",
      "name": "Header1"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "b17df0d8-1f1b-4d45-8478-ce24663cfcf2",
              "name": "chatwoot_url",
              "value": "",
              "type": "string"
            },
            {
              "id": "6c6e6653-1d70-4856-8588-511787e50205",
              "name": "chatwoot_token",
              "value": "",
              "type": "string"
            },
            {
              "id": "a46c85f1-9fe8-4520-9ae9-2c4675681f04",
              "name": "chatwoot_account_id",
              "value": "",
              "type": "string"
            },
            {
              "id": "eed2701d-beb2-44ea-84d2-05e2de71dd13",
              "name": "evolution_url",
              "value": "",
              "type": "string"
            },
            {
              "id": "e5658599-d37d-44c2-9ec9-c973b445f461",
              "name": "evolution_apikey",
              "value": "",
              "type": "string"
            },
            {
              "id": "822be99c-dcce-4d10-9946-59ae5f222b56",
              "name": "mcp_endpoint",
              "value": "",
              "type": "string"
            },
            {
              "id": "4122c024-fe20-43bb-9003-6f85e4a8bca5",
              "name": "debounce_seconds",
              "value": 20,
              "type": "number"
            },
            {
              "id": "pg-info",
              "name": "_postgres_info",
              "value": "IMPORTANTE: o backend precisa estar redeployado com a rota POST /api/chatwoot/log-resolution. Verifique GET /api/health.",
              "type": "string"
            },
            {
              "id": "backend-url-prod-0001",
              "name": "backend_url",
              "value": "",
              "type": "string"
            },
            {
              "id": "backend-webhook-secret-0001",
              "name": "backend_webhook_secret",
              "value": "",
              "type": "string"
            },
            {
              "id": "cd95e91b-7948-4801-93f7-1fa744c67360",
              "name": "type_message",
              "value": "={{ $json.body.messages[0].content_type }}",
              "type": "string"
            },
            {
              "id": "bc973a1c-e724-48bc-8eac-5f7eebcf2708",
              "name": "content_message",
              "value": "={{ $json.body.messages[0].content }}",
              "type": "string"
            },
            {
              "id": "c5417247-3caf-454c-b4db-df2e83079811",
              "name": "name",
              "value": "={{ $json.body.messages[0].sender.name }}",
              "type": "string"
            },
            {
              "id": "d695c211-465f-4d85-bcb5-3ef328c66cba",
              "name": "remotejid",
              "value": "={{ $json.body.messages[0].sender.identifier }}",
              "type": "string"
            },
            {
              "id": "aab35ac4-acee-4243-83ed-3229b1803c77",
              "name": "clean_number",
              "value": "={{ $json.body.messages[0].sender.phone_number }}",
              "type": "string"
            },
            {
              "id": "8fe4523a-259b-45b6-8488-3789c981ac0e",
              "name": "conversation_id",
              "value": "={{ $json.body.messages[0].conversation_id }}",
              "type": "number"
            },
            {
              "id": "5064937d-5fb1-46e1-a46c-2a2b22e06028",
              "name": "account_id",
              "value": "={{ $json.body.messages[0].account_id }}",
              "type": "number"
            },
            {
              "id": "6063fc1c-fc67-4977-b029-b6260b7c7126",
              "name": "isAudio",
              "value": "={{$json.body.messages[0].attachments?.[0]?.file_type === 'audio'}}",
              "type": "boolean"
            },
            {
              "id": "9174d54c-950c-447a-833b-f043147abcec",
              "name": "audioUrl",
              "value": "={{$json.body.messages[0].attachments?.[0]?.data_url || ''}}",
              "type": "string"
            },
            {
              "id": "4a661237-76f9-4e43-bd05-b0d21fd464b4",
              "name": "message",
              "value": "={{$json.body.messages[0].content || ''}}",
              "type": "string"
            },
            {
              "id": "7ff144ec-d371-4520-aff2-c23c29d00cbe",
              "name": "messageType",
              "value": "={{$json.body.messages[0].attachments?.[0]?.file_type || 'text'}}",
              "type": "string"
            },
            {
              "id": "e065156c-1c02-4b41-b574-0e3a0b9b9a91",
              "name": "body",
              "value": "={{$json.body}}",
              "type": "object"
            },
            {
              "id": "416c10b1-e332-4905-b2a3-94017bd975e7",
              "name": "evolution_instance",
              "value": "Amanda",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        -4656,
        -64
      ],
      "id": "90e615eb-d694-4d29-aa91-8b34e4beb36d",
      "name": "config1"
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "sdr-goodleads-completo",
        "options": {}
      },
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2.1,
      "position": [
        -4880,
        -64
      ],
      "id": "dd2a7ea8-0400-42a3-8dce-1403d4919ecc",
      "name": "webhook_chatwoot1",
      "webhookId": "7f7e1c39-c5ae-478b-b14f-13a7918f328f"
    },
    {
      "parameters": {
        "jsCode": "const data = $input.first().json;\n\nreturn [{\n  json: {\n    ...data,\n\n    body: data.body,\n\n    type_message: data.body.messages?.[0]?.content_type || \"text\",\n    content_message: data.body.messages?.[0]?.content || \"\",\n    name: data.body.messages?.[0]?.sender?.name || \"\",\n    remotejid: data.body.messages?.[0]?.sender?.identifier || \"\",\n    clean_number: data.body.messages?.[0]?.sender?.phone_number || \"\",\n    conversation_id: data.body.messages?.[0]?.conversation_id || null,\n    account_id: data.body.messages?.[0]?.account_id || null,\n\n    isAudio: data.body.messages?.[0]?.attachments?.[0]?.file_type === \"audio\",\n    audioUrl: data.body.messages?.[0]?.attachments?.[0]?.data_url || \"\",\n\n    message: data.body.messages?.[0]?.content || \"\",\n    messageType: data.body.messages?.[0]?.attachments?.[0]?.file_type || \"text\"\n  }\n}];"
      },
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -4160,
        -80
      ],
      "id": "747fab71-b734-4444-abee-9c6929f3dfff",
      "name": "Detectar_Tipo1"
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "7326a3e3-e6da-4470-9da3-09305440919a",
              "leftValue": "={{ [\"fechado\",\"perdido\",\"desinteressado\"].some(l => ($json.labels || []).includes(l)).toString() }}",
              "rightValue": "true",
              "operator": {
                "type": "string",
                "operation": "notEquals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        -3936,
        -80
      ],
      "id": "40c17551-be1c-4105-9d6f-277e2324315c",
      "name": "If_NaoEncerrado1"
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "ebc7d9b9-a73e-48d8-82fe-9219e6c840d5",
              "leftValue": "={{ (($json.body && $json.body.conversation && $json.body.conversation.custom_attributes && ($json.body.conversation.custom_attributes.human_active === true || $json.body.conversation.custom_attributes.handoff_to_human === true || $json.body.conversation.custom_attributes.human_intervened === true || $json.body.conversation.custom_attributes.resolved_by === \"human\")) || ($json.body && $json.body.conversation && $json.body.conversation.additional_attributes && ($json.body.conversation.additional_attributes.human_active === true || $json.body.conversation.additional_attributes.handoff_to_human === true || $json.body.conversation.additional_attributes.human_intervened === true || $json.body.conversation.additional_attributes.resolved_by === \"human\"))).toString() }}",
              "rightValue": "true",
              "operator": {
                "type": "string",
                "operation": "equals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        -3936,
        -176
      ],
      "id": "7258a8b7-c500-41cd-94b8-b1a55eb59c00",
      "name": "If_Humano_Atendendo1"
    },
    {
      "parameters": {},
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        -3488,
        224
      ],
      "id": "6e2b0010-b772-4505-864f-55ce5198cd61",
      "name": "Skip_Humano_Atendendo1"
    },
    {
      "parameters": {
        "rules": {
          "values": [
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "2d675ff5-bb31-4957-851e-63cdb098ad3c",
                    "leftValue": "={{ $json.messageType }}",
                    "rightValue": "text",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              },
              "renameOutput": true,
              "outputKey": "texto"
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "f094830f-1739-43b3-bf97-089941c5db49",
                    "leftValue": "={{ $json.messageType }}",
                    "rightValue": "audio",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              },
              "renameOutput": true,
              "outputKey": "audio"
            }
          ]
        },
        "options": {
          "fallbackOutput": "extra"
        }
      },
      "type": "n8n-nodes-base.switch",
      "typeVersion": 3.2,
      "position": [
        -3808,
        -272
      ],
      "id": "ee4fbed4-986c-4bdb-a1c6-23ff60da3fd7",
      "name": "Switch_Tipo1"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "8576385c-d9f8-4324-b040-b0d4cf3183f6",
              "name": "id_phone",
              "value": "={{ (() => { const raw = String($json.remotejid || $json.clean_number || '').trim(); if (!raw) return ''; if (raw.includes('@')) return raw.replace(/\\s+/g, ''); const digits = raw.replace(/\\D/g, ''); return digits ? `${digits}@s.whatsapp.net` : ''; })() }}",
              "type": "string"
            },
            {
              "id": "6e3a980b-f98c-46d3-bd23-3d271808c96d",
              "name": "name_user",
              "value": "={{ $json.name }}",
              "type": "string"
            },
            {
              "id": "97d93902-e515-48fe-8f52-6f9effd1acfc",
              "name": "message",
              "value": "={{ $json.content_message }}",
              "type": "string"
            },
            {
              "id": "cfd78338-fb59-43f4-9b32-d52f38f8358c",
              "name": "conversation_id",
              "value": "={{ $json.conversation_id }}",
              "type": "string"
            },
            {
              "id": "1331df6c-8a83-4a80-a328-f66ad6d3fcbd",
              "name": "account_id",
              "value": "={{ $json.account_id }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        -3536,
        -352
      ],
      "id": "12f6cc39-d1bd-4ce8-9c02-d5f94fd4e0a4",
      "name": "output_texto1"
    },
    {
      "parameters": {
        "resource": "audio",
        "operation": "transcribe",
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.openAi",
      "typeVersion": 1.8,
      "position": [
        -3024,
        -96
      ],
      "id": "0a22cd0c-11fd-45c3-a193-979599dce3ba",
      "name": "Transcreve_Audio1",
      "credentials": {
        "openAiApi": {
          "id": "GpBWdVYDiomPaE9Y",
          "name": "ApiKeyGoodleads"
        }
      }
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "93b0b02f-2120-42ac-89bc-ec096a18c994",
              "name": "id_phone",
              "value": "={{ (() => { const raw = String($('Detectar_Tipo1').item.json.remotejid || $('Detectar_Tipo1').item.json.clean_number || '').trim(); if (!raw) return ''; if (raw.includes('@')) return raw.replace(/\\s+/g, ''); const digits = raw.replace(/\\D/g, ''); return digits ? `${digits}@s.whatsapp.net` : ''; })() }}",
              "type": "string"
            },
            {
              "id": "85d6e5f2-06d5-47fe-ba18-c2659db0ce72",
              "name": "name_user",
              "value": "={{ $('Detectar_Tipo1').item.json.name || '' }}",
              "type": "string"
            },
            {
              "id": "46a6c55f-b751-4222-a1b2-96dbf6f67c04",
              "name": "message",
              "value": "=Transcrição do áudio: {{ $json.text }}",
              "type": "string"
            },
            {
              "id": "ac7be971-7fd7-4cd4-8b84-83436856804d",
              "name": "conversation_id",
              "value": "={{ $('Detectar_Tipo1').item.json.conversation_id }}",
              "type": "string"
            },
            {
              "id": "3ebca2f9-cd5e-4d2b-824a-d7564fba57ca",
              "name": "account_id",
              "value": "={{ $('Detectar_Tipo1').item.json.account_id }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        -2736,
        -112
      ],
      "id": "4ffac760-daa0-4118-99f0-2518c215623f",
      "name": "output_audio1"
    },
    {
      "parameters": {},
      "type": "n8n-nodes-base.merge",
      "typeVersion": 3,
      "position": [
        -2512,
        -176
      ],
      "id": "e04fc9e2-6f02-42e7-bd6a-c147f8b9fc4d",
      "name": "Mensagem_Completa1"
    },
    {
      "parameters": {
        "operation": "push",
        "list": "={{ $json.id_phone }}",
        "messageData": "={{ $json.message }}",
        "tail": true
      },
      "type": "n8n-nodes-base.redis",
      "typeVersion": 1,
      "position": [
        -2304,
        -176
      ],
      "id": "52866d02-07f7-4bb9-abee-77ca0b2e41a4",
      "name": "Redis_Push1",
      "credentials": {
        "redis": {
          "id": "JmZi3xoz800AFN12",
          "name": "Redis account"
        }
      }
    },
    {
      "parameters": {
        "amount": "={{ $('config1').item.json.debounce_seconds }}"
      },
      "type": "n8n-nodes-base.wait",
      "typeVersion": 1.1,
      "position": [
        -2080,
        -176
      ],
      "id": "1a33d9e8-d16f-4e6c-8160-9a1972597c9f",
      "name": "Wait_Debounce1",
      "webhookId": "ff9c8b52-8f7e-4e23-98a8-81c9c5118981"
    },
    {
      "parameters": {
        "operation": "get",
        "key": "={{ $json.id_phone }}",
        "options": {}
      },
      "type": "n8n-nodes-base.redis",
      "typeVersion": 1,
      "position": [
        -1856,
        -176
      ],
      "id": "50c06621-b94b-484a-bf1b-87c7e8597cad",
      "name": "Redis_Get1",
      "credentials": {
        "redis": {
          "id": "JmZi3xoz800AFN12",
          "name": "Redis account"
        }
      }
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "60e65fe5-e28a-412e-99a5-8f5d557c58b7",
              "leftValue": "={{ $('Redis_Get1').last().json.propertyName.slice(-1)[0] }}",
              "rightValue": "={{ $('Wait_Debounce1').item.json.message }}",
              "operator": {
                "type": "string",
                "operation": "equals",
                "name": "filter.operator.equals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        -1600,
        -176
      ],
      "id": "28c882d1-7682-4437-9e68-9f9f38c21826",
      "name": "If_Ultima_Mensagem1"
    },
    {
      "parameters": {},
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        -1392,
        32
      ],
      "id": "42ff6f39-812c-491a-9efb-7285b0504e6f",
      "name": "Aguarda_Proxima1"
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT\n  message\nFROM (\n  SELECT\n    id,\n    message::text AS message\n  FROM\n    n8n_chat_histories\n  WHERE\n    (\n      regexp_replace(BTRIM(COALESCE(session_id, '')), '[[:space:]]+', '', 'g') =\n      regexp_replace(BTRIM(COALESCE('{{ $json.id_phone }}', '')), '[[:space:]]+', '', 'g')\n    )\n    OR (\n      regexp_replace(split_part(BTRIM(COALESCE(session_id, '')), '@', 1), '[^0-9]', '', 'g') =\n      regexp_replace(split_part(BTRIM(COALESCE('{{ $json.id_phone }}', '')), '@', 1), '[^0-9]', '', 'g')\n    )\n  ORDER BY\n    id DESC\n  LIMIT 6\n) sub\nORDER BY\n  id ASC;\n",
        "options": {
          "queryReplacement": "={{ $json.id_phone }}"
        }
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [
        -768,
        -288
      ],
      "id": "f0da2f12-093f-43e4-9a44-0a9f222a2547",
      "name": "Buscar_Historico1",
      "alwaysOutputData": true,
      "credentials": {
        "postgres": {
          "id": "jlyTJz3dDT39up9x",
          "name": "Postgres account"
        }
      }
    },
    {
      "parameters": {
        "jsonSchemaExample": "{\n  \"etapa\": \"em-contato\",\n  \"transferir_para_humano\": false,\n  \"confianca\": 0.92,\n  \"historico\":\"\",\n  \"mensagem_original\": \"Olá, queria saber mais\"\n}"
      },
      "type": "@n8n/n8n-nodes-langchain.outputParserStructured",
      "typeVersion": 1.2,
      "position": [
        704,
        368
      ],
      "id": "6c3f5571-7478-4283-a137-693713eef065",
      "name": "Output_Parser1"
    },
    {
      "parameters": {
        "jsCode": "function cleanText(text) {\n  if (!text) return '';\n\n  return String(text)\n    // normaliza tracos\n    .replace(/[–—]/g, '-')\n    // normaliza aspas\n    .replace(/[‘’]/g, \"'\")\n    .replace(/[“”]/g, '\"')\n    // remove caracteres de controle invisiveis (isso sim da problema)\n    .replace(/[\u0000-\u001f]/g, '')\n    // quebra de linha ok, mas vamos padronizar\n    .replace(/\\n+/g, ' ')\n    .trim();\n}\n\n// corrige \"palavra.Palavra\" -> \"palavra. Palavra\" (fim de frase + maiuscula)\nfunction fixSentenceSpacing(text) {\n  if (!text) return '';\n  return String(text)\n    .replace(/([.!?])([A-ZÀ-Ý])/g, '$1 $2') // espaco apos . ? ! antes de maiuscula\n    .replace(/\\s{2,}/g, ' ')                 // colapsa espacos duplicados\n    .trim();\n}\n\n// extrai o primeiro e-mail de um texto (vazio se nao houver)\nfunction extrairEmail(text) {\n  if (!text) return '';\n  const m = String(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);\n  return m ? m[0].toLowerCase() : '';\n}\n\nreturn items.map(item => {\n  const o = item.json.output || item.json || {};\n\n  const transferir =\n    o.transferir_para_humano === true ||\n    o.transferir_para_humano === 'true';\n\n  const resolver_raw =\n    o.resolver_conversa === true ||\n    o.resolver_conversa === 'true';\n\n  let resolver = transferir ? false : resolver_raw;\n  let etapa = cleanText(o.etapa_final || o.etapa || 'novo-lead');\n  let mensagem = fixSentenceSpacing(cleanText(o.mensagem_de_resposta || ''));\n\n  // GUARD E1 (anti e-mail inventado): so ATIVA se houver o campo email_capturado\n  // no item (no de captura por regex ligado). Sem esse campo, nao bloqueia nada\n  // (fail-open: nao quebra o fluxo de quem ainda nao montou a Camada A).\n  const temCaptura = ('email_capturado' in item.json) || ('email_capturado' in o);\n  if (temCaptura) {\n    const emailCapturado = extrairEmail(item.json.email_capturado || o.email_capturado || '');\n    const confirmouAgendamento = etapa === 'agendado' && resolver_raw === true;\n    const emailNaMensagem = extrairEmail(mensagem);\n    const semEmailReal = !emailCapturado;\n    const emailNaoBate = emailNaMensagem && emailCapturado && emailNaMensagem !== emailCapturado;\n    if (confirmouAgendamento && (semEmailReal || emailNaoBate)) {\n      // bloqueia a confirmacao fake e devolve a vez pro agente coletar o e-mail\n      mensagem = 'Show! Pra fechar o agendamento certinho, me confirma teu melhor e-mail?';\n      resolver = false;\n      etapa = 'agendado';\n    }\n  }\n\n  return {\n    json: {\n      etapa: etapa,\n      mensagem_original: cleanText(o.mensagem_original || ''),\n      mensagem_de_resposta: mensagem,\n      transferir_para_humano: transferir,\n      resolver_conversa: resolver\n    }\n  };\n});"
      },
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1616,
        -288
      ],
      "id": "7b4e5c6d-9f3a-437e-ad04-c58563a80815",
      "name": "Normaliza_Output1"
    },
    {
      "parameters": {
        "rules": {
          "values": [
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "8d15354b-3dd0-4d65-9d01-2c2b3783628f",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "novo-lead",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "f11ecd67-a248-4211-8dd9-bf856780d7a3",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "em-atendimento",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "b9dda99b-57a3-4b54-ba4d-5b0c725e915b",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "aguardando-resposta",
                    "operator": {
                      "type": "string",
                      "operation": "equals",
                      "name": "filter.operator.equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "e10aee67-e049-4f74-90a6-be267c09b85e",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "agendado",
                    "operator": {
                      "type": "string",
                      "operation": "equals",
                      "name": "filter.operator.equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "243b5323-7a76-4ba0-9617-07dadfeee2d2",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "convertido",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "d973d28e-251b-4ff2-a0c8-a396464e5197",
                    "leftValue": "={{ $json.etapa }}",
                    "rightValue": "perdido",
                    "operator": {
                      "type": "string",
                      "operation": "equals",
                      "name": "filter.operator.equals"
                    }
                  }
                ],
                "combinator": "and"
              }
            }
          ]
        },
        "options": {
          "fallbackOutput": "extra"
        }
      },
      "type": "n8n-nodes-base.switch",
      "typeVersion": 3.2,
      "position": [
        1872,
        -368
      ],
      "id": "236af8b1-e3ba-418b-8932-7b7c0db4cc6b",
      "name": "Switch_Etapa1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"novo-lead\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2816,
        -720
      ],
      "id": "84e58de7-1cc4-4e4d-98c0-22c48292d99c",
      "name": "Label_novo-lead6"
    },
    {
      "parameters": {
        "numberInputs": 6
      },
      "type": "n8n-nodes-base.merge",
      "typeVersion": 3,
      "position": [
        3680,
        -368
      ],
      "id": "4d5ed031-bbc9-4b4c-9909-e10a67f4d6b3",
      "name": "Merge_Labels1",
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/messages",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"content\": \"{{ $('Normaliza_Output1').item.json.mensagem_de_resposta }}\",\n  \"message_type\": \"outgoing\",\n  \"private\": false\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        4288,
        -304
      ],
      "id": "0029e0e9-75d9-4317-9478-b3d93010ada0",
      "name": "Responde_Mensagem1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/custom_attributes",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"custom_attributes\": { \"ai_responded\": true }\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        4480,
        -304
      ],
      "id": "b059659e-34a4-45fc-9140-a041dbfff926",
      "name": "Mark_ai_responded1"
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "8c2e74ee-8757-4d79-9ae1-6cb2425183b7",
              "leftValue": "={{ $('Normaliza_Output1').item.json.transferir_para_humano }}",
              "rightValue": true,
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        5152,
        -304
      ],
      "id": "ad6c62c1-d421-4217-9417-699179d78c71",
      "name": "If_Transferir1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').item.json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').item.json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').item.json.conversation_id }}/custom_attributes",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').item.json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"custom_attributes\": { \"handoff_to_human\": true, \"human_active\": true }\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        5392,
        -512
      ],
      "id": "adebe875-3d74-45dc-bd44-300455c5519e",
      "name": "Mark_handoff1"
    },
    {
      "parameters": {
        "url": "={{ $('config1').item.json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').item.json.account_id }}/agents",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').item.json.chatwoot_token }}"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        5616,
        -512
      ],
      "id": "52ba6e2e-b65a-45cc-80f6-ff771319b0d3",
      "name": "Buscar_Agentes1"
    },
    {
      "parameters": {
        "jsCode": "const agents = $input.all().map(item => item.json);\n\n// Apenas online\nconst onlineAgents = agents.filter(\n  agent => agent.availability_status === 'online'\n);\n\n// Ninguém online\nif (onlineAgents.length === 0) {\n  return [{\n    json: {\n      has_agent: false,\n      assignee_id: null,\n      assignee_name: null\n    }\n  }];\n}\n\n// Apenas um online\nif (onlineAgents.length === 1) {\n  const chosen = onlineAgents[0];\n\n  return [{\n    json: {\n      has_agent: true,\n      assignee_id: chosen.id,\n      assignee_name: chosen.name\n    }\n  }];\n}\n\n// Vários online → sorteio\nconst chosen = onlineAgents[\n  Math.floor(Math.random() * onlineAgents.length)\n];\n\nreturn [{\n  json: {\n    has_agent: true,\n    assignee_id: chosen.id,\n    assignee_name: chosen.name\n  }\n}];"
      },
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        5824,
        -512
      ],
      "id": "7ba0e103-39b4-46fc-b14d-d52fd13c2408",
      "name": "Sortear_Agente1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').item.json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').item.json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').item.json.conversation_id }}/assignments",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').item.json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"assignee_id\": {{ $json.assignee_id || 0 }}\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        6400,
        -688
      ],
      "id": "b03e8faf-8696-4f0d-b027-f332c2e67e15",
      "name": "Atribuir_Agente1"
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "8199b730-accf-40e4-a3c0-d67ebec0fa4d",
              "leftValue": "={{ $('Normaliza_Output1').item.json.resolver_conversa }}",
              "rightValue": true,
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        5312,
        -112
      ],
      "id": "9a43f8b6-6154-4b95-93a6-0130783872dc",
      "name": "If_Resolver1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/custom_attributes",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"custom_attributes\": { \"resolved_by\": \"ai\" }\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        5616,
        -112
      ],
      "id": "9b8e7cac-23f7-4a54-9c7b-1399cbfcf741",
      "name": "1_Mark_resolved_by_ai1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/toggle_status",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"status\": \"resolved\"\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        6048,
        -112
      ],
      "id": "bf33ffdb-df40-4c40-8145-a79d5c3308d3",
      "name": "3_Resolver_Conversa1"
    },
    {
      "parameters": {},
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        -3728,
        144
      ],
      "id": "57b3e7c0-8470-4232-862f-0d9a42303269",
      "name": "Conversa_Encerrada_Skip1"
    },
    {
      "parameters": {
        "jsonSchemaExample": "{\n  \"mensagem_de_resposta\": \"Olá! Como posso te ajudar?\",\n  \"resolver_conversa\": false,\n  \"transferir_para_humano\": false,\n  \"etapa_final\": \"novo-lead\",\n  \"mensagem_original\": \"oi\"\n}\n"
      },
      "type": "@n8n/n8n-nodes-langchain.outputParserStructured",
      "typeVersion": 1.2,
      "position": [
        1440,
        -64
      ],
      "id": "9e9c3627-7107-4c7c-990e-9f2f3c3c2087",
      "name": "Output_Parser_Resposta1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.backend_url }}/api/chatwoot/log-resolution",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Content-Type",
              "value": "application/json"
            },
            {
              "name": "x-webhook-secret",
              "value": "={{ $('config1').first().json.backend_webhook_secret }}"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"chatwoot_account_id\": \"{{ $('Mensagem_Final+variaveis').first().json.account_id || $('config1').item.json.chatwoot_account_id }}\",\n  \"conversation_id\": {{ $('Mensagem_Final+variaveis').first().json.conversation_id }},\n  \"resolved_by\": \"ai\",\n  \"resolution_type\": \"explicit\",\n  \"ai_participated\": true\n}",
        "options": {
          "response": {
            "response": {
              "neverError": true,
              "responseFormat": "json"
            }
          },
          "timeout": 15000
        }
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        5824,
        -112
      ],
      "id": "c36c26ce-3510-43c2-aaa9-a8373140e5ac",
      "name": "2_Log_Resolution_AI_HTTP1"
    },
    {
      "parameters": {
        "rules": {
          "values": [
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "msg-rule",
                    "leftValue": "={{$json.body.event}}",
                    "rightValue": "automation_event.message_created",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              },
              "renameOutput": true,
              "outputKey": "message_created"
            },
            {
              "conditions": {
                "options": {
                  "caseSensitive": true,
                  "leftValue": "",
                  "typeValidation": "strict",
                  "version": 2
                },
                "conditions": [
                  {
                    "id": "res-rule",
                    "leftValue": "={{ $json.body.event }}",
                    "rightValue": "automation_event.conversation_updated",
                    "operator": {
                      "type": "string",
                      "operation": "equals"
                    }
                  }
                ],
                "combinator": "and"
              },
              "renameOutput": true,
              "outputKey": "conversation_resolved"
            }
          ]
        },
        "options": {}
      },
      "id": "5c6a411c-0a46-4466-9615-a3718aab71ac",
      "name": "Switch_Evento1",
      "type": "n8n-nodes-base.switch",
      "typeVersion": 3.2,
      "position": [
        -4448,
        -64
      ]
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "humano-cond",
              "leftValue": "={{ ($json.body.conversation && $json.body.conversation.custom_attributes && $json.body.conversation.custom_attributes.resolved_by) || '' }}",
              "rightValue": "ai",
              "operator": {
                "type": "string",
                "operation": "notEquals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "47db57be-c27b-45c5-8425-b3315475b4d5",
      "name": "If_Humano_Fechou1",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        -4336,
        192
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').item.json.backend_url }}/api/chatwoot/log-resolution",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Content-Type",
              "value": "application/json"
            },
            {
              "name": "x-webhook-secret",
              "value": "={{ $('config1').item.json.backend_webhook_secret }}"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"chatwoot_account_id\": \"{{ $('config1').item.json.chatwoot_account_id }}\",\n  \"conversation_id\":{{ $('webhook_chatwoot1').item.json.body.id }} ,\n  \"resolved_by\": \"human\",\n  \"resolution_type\": \"explicit\",\n  \"agent_id\": {{ $json.body?.meta?.assignee?.id || $json.meta?.assignee?.id || $json.assignee_id || 0 }},\n  \"ai_participated\": {{ ($json.body?.custom_attributes?.ai_responded === true || $json.custom_attributes?.ai_responded === true) ? true : false }}\n}\n",
        "options": {
          "response": {
            "response": {
              "neverError": true,
              "responseFormat": "json"
            }
          },
          "timeout": 15000
        }
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -3984,
        160
      ],
      "id": "5bb8106d-a57c-42ac-9307-0913df5512ed",
      "name": "Log_Resolution_Human_HTTP1"
    },
    {
      "parameters": {},
      "id": "fd673b48-0577-453b-b4bd-081a61de8c44",
      "name": "Skip (IA já logou)1",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        -3984,
        400
      ]
    },
    {
      "parameters": {
        "content": "## 🆕 Roteamento por evento\n\n**Switch_Evento** separa:\n- `message_created` → fluxo SDR (IA conversa, classifica, responde)\n- `conversation_resolved` → loga resolução\n\n**If_Humano_Fechou**: se `custom_attributes.resolved_by != 'ai'`, então humano fechou → grava `resolved_by=human` na tabela `resolution_logs`.\n\n⚠️ **Configurar no Chatwoot**: ative os eventos `Message Created` **E** `Conversation Resolved` no webhook.",
        "height": 360,
        "width": 644,
        "color": 4
      },
      "id": "d5f71f21-6a4d-4e4d-9417-8114ccb3103e",
      "name": "Note_Roteamento_Evento1",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [
        -5632,
        -768
      ]
    },
    {
      "parameters": {
        "content": "## ⚙️ Setup obrigatório após importar\n\n1. **Credencial Postgres VPS**: nos nodes\n   • `Buscar_Historico`\n   • `2_Log_Resolution_AI_Postgres`\n   • `Log_Resolution_Human_Postgres`\n   • `Postgres Chat Memory1`\n   selecione a mesma credencial Postgres da VPS\n\n2. **Node `config`**: preencher `chatwoot_token`, `evolution_apikey`, `evolution_instance`\n\n3. **Chatwoot Webhook** (Settings → Integrations → Webhooks):\n   • URL: `https://<seu-n8n>/webhook/sdr-goodleads-completo`\n   • Eventos: ☑ Message Created  ☑ Conversation Resolved",
        "height": 360,
        "width": 728
      },
      "type": "n8n-nodes-base.stickyNote",
      "position": [
        -5632,
        368
      ],
      "typeVersion": 1,
      "id": "e743361d-06cf-49eb-b0bb-8354719a346c",
      "name": "Setup_Instructions1"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').item.json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').item.json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').item.json.conversation_id }}/toggle_status",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').item.json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"status\": \"open\"\n}",
        "options": {}
      },
      "id": "540744aa-46db-4f71-8396-616213454866",
      "name": "Abrir_Conversa_Humano1",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        6816,
        -512
      ]
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "has-agent-cond",
              "leftValue": "={{ $json.has_agent }}",
              "rightValue": true,
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "3dfaafd1-2206-476a-8898-bd4e74211645",
      "name": "If_Has_Agent1",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        6064,
        -512
      ]
    },
    {
      "parameters": {
        "operation": "deleteTable",
        "schema": {
          "__rl": true,
          "mode": "list",
          "value": "public"
        },
        "table": {
          "__rl": true,
          "value": "n8n_chat_histories",
          "mode": "list",
          "cachedResultName": "n8n_chat_histories"
        },
        "deleteCommand": "delete",
        "where": {
          "values": [
            {
              "column": "session_id",
              "value": ""
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [
        -224,
        -560
      ],
      "id": "993233d4-7eb2-4e86-b685-09c1ea00ebcd",
      "name": "Delete table or rows",
      "alwaysOutputData": true,
      "credentials": {
        "postgres": {
          "id": "jlyTJz3dDT39up9x",
          "name": "Postgres account"
        }
      }
    },
    {
      "parameters": {
        "promptType": "define",
        "text": "={\n  \"mensagem_atual\": \"{{ $('Mensagem_Final+variaveis').first().json.msg }}\",\n  \"historico\": {{ $('retorna histórico formatado').first().json.history }},\n  \"contato\": {\n    \"nome\": \"{{ $('Mensagem_Final+variaveis').first().json.name_user }}\",\n    \"telefone\": \"{{ $('Mensagem_Final+variaveis').first().json.id_phone }}\"\n  }\n}",
        "hasOutputParser": true,
        "options": {
          "systemMessage": "PLACEHOLDER_CLASSIFIER"
        }
      },
      "type": "@n8n/n8n-nodes-langchain.agent",
      "typeVersion": 2,
      "position": [
        176,
        -288
      ],
      "id": "9d46157b-bd24-4f0d-98e5-56e2653abc20",
      "name": "AI Agent"
    },
    {
      "parameters": {
        "model": {
          "__rl": true,
          "value": "gpt-5.4-mini",
          "mode": "list",
          "cachedResultName": "gpt-5.4-mini"
        },
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi",
      "typeVersion": 1.2,
      "position": [
        176,
        -48
      ],
      "id": "e545ee2f-3c7b-4a65-a23f-bf382daea432",
      "name": "OpenAI Chat Model",
      "credentials": {
        "openAiApi": {
          "id": "GpBWdVYDiomPaE9Y",
          "name": "ApiKeyGoodleads"
        }
      }
    },
    {
      "parameters": {
        "promptType": "define",
        "text": "=Hoje é {{ $now.weekdayLong }}, dia {{ $now.setZone('America/Sao_Paulo').format('dd-MM-yyyy HH:mm') }}.\n\nNome do lead: {{ $('Mensagem_Final+variaveis').first().json.name_user }}\nE-mail do lead já capturado nesta conversa: {{ $json.output.email_capturado && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test($json.output.email_capturado) ? $json.output.email_capturado : 'ainda não capturado — peça e confirme antes de criar o evento' }}\nMensagem original do lead: {{ $json.output.mensagem_original }}\nHistórico recente da conversa: {{ $json.output.historico }}",
        "hasOutputParser": true,
        "options": {
          "systemMessage": "PLACEHOLDER_RESPONDER"
        }
      },
      "type": "@n8n/n8n-nodes-langchain.agent",
      "typeVersion": 3,
      "position": [
        976,
        -288
      ],
      "id": "6432e113-cff2-4931-9cc9-2c0fd89a9c8c",
      "name": "AI Agent8"
    },
    {
      "parameters": {
        "model": {
          "__rl": true,
          "value": "gpt-5.4-mini",
          "mode": "list",
          "cachedResultName": "gpt-5.4-mini"
        },
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi",
      "typeVersion": 1.2,
      "position": [
        960,
        16
      ],
      "id": "09a65aa9-5562-4084-b8dd-097eeb8d37ad",
      "name": "OpenAI Chat Model10",
      "credentials": {
        "openAiApi": {
          "id": "GpBWdVYDiomPaE9Y",
          "name": "ApiKeyGoodleads"
        }
      }
    },
    {
      "parameters": {
        "sessionIdType": "customKey",
        "sessionKey": "={{ $('Mensagem_Final+variaveis').first().json.id_phone }}",
        "contextWindowLength": 10
      },
      "type": "@n8n/n8n-nodes-langchain.memoryPostgresChat",
      "typeVersion": 1.3,
      "position": [
        1088,
        -16
      ],
      "id": "aa7f27a7-a21d-4eb8-b7e3-fa68533b8481",
      "name": "Postgres Chat Memory1",
      "credentials": {
        "postgres": {
          "id": "jlyTJz3dDT39up9x",
          "name": "Postgres account"
        }
      }
    },
    {
      "parameters": {
        "endpointUrl": "",
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.mcpClientTool",
      "typeVersion": 1.2,
      "position": [
        1280,
        0
      ],
      "id": "21319b45-35e6-43bd-9132-e0030f35ddb2",
      "name": "MCP Client1"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "53e2b53d-fef7-4950-be81-6803d062facd",
              "name": "output.etapa",
              "value": "={{ $json.output.etapa }}",
              "type": "string"
            },
            {
              "id": "b39fce23-b429-49d4-bc77-6c9a1e8ae1fa",
              "name": "output.transferir_para_humano",
              "value": "={{ $json.output.transferir_para_humano }}",
              "type": "boolean"
            },
            {
              "id": "ab700823-abfa-4b37-a44e-6571846241db",
              "name": "output.confianca",
              "value": "={{ $json.output.confianca }}",
              "type": "number"
            },
            {
              "id": "8d6faf3d-2329-454d-a77b-e3e30b26b26d",
              "name": "output.historico",
              "value": "={{ $json.output.historico }}",
              "type": "string"
            },
            {
              "id": "30e10c7b-644c-40dd-b0b9-49cee27e746d",
              "name": "output.mensagem_original",
              "value": "={{ $('Mensagem_Final+variaveis').first().json.msg }}",
              "type": "string"
            },
            {
              "id": "ea8dca47-00a7-4cf2-9067-ff9ea04e1378",
              "name": "output.email_capturado",
              "value": "={{ $('retorna histórico formatado').first().json.email_capturado }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        624,
        -288
      ],
      "id": "6dfd1614-cf85-40f0-9736-554259bee5d2",
      "name": "Variaveis de interesse"
    },
    {
      "parameters": {
        "jsCode": "// Formata as mensagens de forma resiliente e segura para o Postgres\nconst historyItems = $json.history_items;\n\nif (!Array.isArray(historyItems) || historyItems.length === 0) {\n  return [{ json: { history: '' } }];\n}\n\nconst safeString = (value) => {\n  if (value === null || value === undefined) return '';\n  if (typeof value === 'string') return value;\n  try {\n    return JSON.stringify(value);\n  } catch {\n    return String(value);\n  }\n};\n\nconst extractContent = (value) => {\n  if (value === null || value === undefined) return '';\n  let content = value;\n\n  if (typeof value !== 'string') {\n    content = safeString(value);\n  } else {\n    try {\n      const parsed = JSON.parse(value);\n      if (parsed?.output) {\n        content = parsed.output.mensagem_de_resposta || parsed.output.message || safeString(parsed.output);\n      } else if (parsed?.content) {\n        content = safeString(parsed.content);\n      }\n    } catch {\n      // Texto puro\n    }\n  }\n\n  // --- MELHORIA: ANTI-BOLA DE NEVE ---\n  // Se o conteúdo já possui o marcador de histórico, removemos o resto para não duplicar na memória\n  if (typeof content === 'string' && content.includes('Histórico recente:')) {\n    content = content.split('Histórico recente:')[0].trim();\n  }\n\n  return content;\n};\n\nconst formattedHistory = historyItems\n  .map((item) => {\n    if (!item) return null;\n    let role = '';\n    let content = '';\n\n    if (item.message) {\n      let parsedMessage = item.message;\n      if (typeof parsedMessage === 'string') {\n        try { parsedMessage = JSON.parse(parsedMessage); } catch { parsedMessage = null; }\n      }\n      if (parsedMessage?.type) {\n        role = parsedMessage.type === 'ai' ? 'IA' : 'Humano';\n        content = extractContent(parsedMessage.content);\n      }\n    } else if (item.type) {\n      role = item.type === 'ai' ? 'IA' : 'Humano';\n      content = extractContent(item.content);\n    }\n\n    if (role && content) {\n      // --- MELHORIA: ESCAPE PARA POSTGRES ---\n      // Substitui barras invertidas simples por duplas para evitar erro de Unicode escape\n      // e remove quebras de linha excessivas\n      const cleanContent = content.toString().replace(/\\\\/g, '\\\\\\\\').replace(/\\n+/g, ' ');\n      return `${role}: ${cleanContent}`;\n    }\n\n    return null;\n  })\n  .filter(Boolean)\n  .join('\\n');\n\n  const _msgAtual = $('Mensagem_Final+variaveis').first().json.msg || '';\nconst _textosLead = [_msgAtual];\n(historyItems || []).forEach((it) => {\n  let pm = it && it.message;\n  if (typeof pm === 'string') { try { pm = JSON.parse(pm); } catch { pm = null; } }\n  if (pm && pm.type && pm.type !== 'ai') {\n    _textosLead.push(typeof pm.content === 'string' ? pm.content : JSON.stringify(pm.content || ''));\n  }\n});\nconst _m = _textosLead.join(' ').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);\nconst email_capturado = _m ? _m[0].toLowerCase() : '';\n\nreturn [{ \n  json: { \n    history: formattedHistory \n  } \n}];"
      },
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -288,
        -288
      ],
      "id": "26d9c21c-b276-4483-8e7d-6b707a1b2697",
      "name": "retorna histórico formatado"
    },
    {
      "parameters": {
        "jsCode": "// Pega todos os itens que chegam do nó Postgres\nconst allItems = $items();\n\n// Retorna um ÚNICO item novo.\n// Este item contém uma propriedade 'history_items' que é um array\n// com os dados de todos os itens originais.\nreturn [{\n  json: {\n    history_items: allItems.map(item => item.json)\n  }\n}];"
      },
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -544,
        -288
      ],
      "id": "43102951-c54f-471c-a054-212ef7b27de3",
      "name": "pega um item do historico"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "51d96166-f812-4ae3-9168-2e64c640a7de",
              "name": "msg",
              "value": "={{ $json.message }}",
              "type": "string"
            },
            {
              "id": "c8bfa90d-5099-49f4-8e76-23b1cb3a4a16",
              "name": "id_phone",
              "value": "={{ (() => { const raw = String($('Mensagem_Completa1').item.json.id_phone || '').trim(); if (!raw) return ''; if (raw.includes('@')) return raw.replace(/\\s+/g, ''); const digits = raw.replace(/\\D/g, ''); return digits ? `${digits}@s.whatsapp.net` : ''; })() }}",
              "type": "string"
            },
            {
              "id": "4225fd40-b233-4391-9878-b30ee6e66275",
              "name": "conversation_id",
              "value": "={{ $('Mensagem_Completa1').item.json.conversation_id }}",
              "type": "string"
            },
            {
              "id": "6bc6b84f-8157-492a-b57e-6326d1b9ec5a",
              "name": "account_id",
              "value": "={{ $('Mensagem_Completa1').item.json.account_id }}",
              "type": "string"
            },
            {
              "id": "738f23d2-0f76-4e64-a844-d1d015258ceb",
              "name": "name_user",
              "value": "={{ $('Mensagem_Completa1').item.json.name_user }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        -1008,
        -288
      ],
      "id": "117fc85d-e64b-413f-ae1c-cdfa5f73a515",
      "name": "Mensagem_Final+variaveis"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "3678dd0a-182a-47a8-b150-78b1bd8034cd",
              "name": "name_user",
              "value": "={{ $('config1').item.json.name }}",
              "type": "string"
            },
            {
              "id": "b7845a18-5172-4981-86ef-029ddf0bc63d",
              "name": "id_phone",
              "value": "={{ $('config1').item.json.body.meta.sender.identifier }}",
              "type": "string"
            },
            {
              "id": "eec3bca1-dfe9-4243-ac12-5682b7b6894d",
              "name": "inputType",
              "value": "=text",
              "type": "string"
            },
            {
              "id": "e6eb4a38-0813-446f-ba7a-d29e12b7bcd4",
              "name": "message",
              "value": "={{ $json.propertyName }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [
        -1408,
        -416
      ],
      "id": "32bb25d3-3243-4b83-8a42-d662726d660c",
      "name": "output_texto4"
    },
    {
      "parameters": {
        "operation": "delete",
        "key": "={{ $('Mensagem_Completa1').item.json.id_phone }}"
      },
      "type": "n8n-nodes-base.redis",
      "typeVersion": 1,
      "position": [
        -1120,
        -544
      ],
      "id": "1af2b147-3946-4f2d-834d-290955352142",
      "name": "Redis1",
      "credentials": {
        "redis": {
          "id": "JmZi3xoz800AFN12",
          "name": "Redis account"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"em-atendimento\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2816,
        -496
      ],
      "id": "22b3f949-3243-440b-8b60-e6bb028d5239",
      "name": "Label_em Atendimento"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"aguardando-resposta\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2800,
        -160
      ],
      "id": "29da1b90-9486-4df1-9c74-e7152321cef0",
      "name": "Label_Aguardando Resposta"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"agendado\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2816,
        -336
      ],
      "id": "5f53782c-49fe-4b69-a262-f77a91323550",
      "name": "Label_ Agendado"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"convertido\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2800,
        0
      ],
      "id": "7f79199f-9f1f-481b-8e7d-50b7476483f8",
      "name": "Label_ Convertido"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/labels",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"labels\": [\"perdido\"]}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2800,
        128
      ],
      "id": "7be8c5aa-5270-4b6d-8b54-452a0c3ec482",
      "name": "Label_ Perdido"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('config1').first().json.chatwoot_url }}/api/v1/accounts/{{ $('Mensagem_Final+variaveis').first().json.account_id }}/conversations/{{ $('Mensagem_Final+variaveis').first().json.conversation_id }}/messages",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "api_access_token",
              "value": "={{ $('config1').first().json.chatwoot_token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"content\": \"{{ $('Normaliza_Output1').item.json.mensagem_de_resposta }}\",\n  \"message_type\": \"outgoing\",\n  \"private\": false\n}",
        "options": {}
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2800,
        272
      ],
      "id": "2fc2a078-04ec-440b-94ea-d0007e7c97b1",
      "name": "Responde_Mensagem"
    },
    {
      "parameters": {
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.outputParserAutofixing",
      "typeVersion": 1,
      "position": [
        480,
        144
      ],
      "id": "ea26529d-9835-478d-b2f7-a391c3ee8c6f",
      "name": "Auto-fixing Output Parser1"
    },
    {
      "parameters": {
        "model": {
          "__rl": true,
          "value": "gpt-5.4-mini",
          "mode": "list",
          "cachedResultName": "gpt-5.4-mini"
        },
        "builtInTools": {},
        "options": {}
      },
      "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi",
      "typeVersion": 1.3,
      "position": [
        368,
        352
      ],
      "id": "ab30abf0-8590-49ef-9560-ebb0b0d7daf6",
      "name": "OpenAI Chat Model1",
      "credentials": {
        "openAiApi": {
          "id": "GpBWdVYDiomPaE9Y",
          "name": "ApiKeyGoodleads"
        }
      }
    },
    {
      "parameters": {
        "url": "={{ $json.audioUrl }}",
        "options": {
          "response": {
            "response": {
              "responseFormat": "file"
            }
          }
        }
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.4,
      "position": [
        -3360,
        -112
      ],
      "id": "168b5db8-babe-4057-b9a2-cb7668d552e9",
      "name": "HTTP Request"
    },
    {
      "parameters": {
        "operation": "upsert",
        "schema": {
          "__rl": true,
          "mode": "list",
          "value": "public"
        },
        "table": {
          "__rl": true,
          "value": "followup_tempo_sem_resposta",
          "mode": "list",
          "cachedResultName": "followup_tempo_sem_resposta"
        },
        "columns": {
          "mappingMode": "defineBelow",
          "value": {
            "is_closed": false,
            "last_interaction": "2026-06-13T02:41:11",
            "session_id": "={{ $('webhook_chatwoot1').item.json.body.messages[0].sender.identifier }}"
          },
          "matchingColumns": [
            "session_id"
          ],
          "schema": [
            {
              "id": "id",
              "displayName": "id",
              "required": false,
              "defaultMatch": true,
              "display": true,
              "type": "number",
              "canBeUsedToMatch": true,
              "removed": true
            },
            {
              "id": "last_interaction",
              "displayName": "last_interaction",
              "required": false,
              "defaultMatch": false,
              "display": true,
              "type": "dateTime",
              "canBeUsedToMatch": false,
              "removed": false
            },
            {
              "id": "session_id",
              "displayName": "session_id",
              "required": true,
              "defaultMatch": false,
              "display": true,
              "type": "string",
              "canBeUsedToMatch": true,
              "removed": false
            },
            {
              "id": "is_closed",
              "displayName": "is_closed",
              "required": false,
              "defaultMatch": false,
              "display": true,
              "type": "boolean",
              "canBeUsedToMatch": false,
              "removed": false
            },
            {
              "id": "follow_up_stage",
              "displayName": "follow_up_stage",
              "required": false,
              "defaultMatch": false,
              "display": true,
              "type": "string",
              "canBeUsedToMatch": false,
              "removed": true
            }
          ],
          "attemptToConvertTypes": false,
          "convertFieldsToString": false
        },
        "options": {}
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [
        4832,
        -304
      ],
      "id": "97f1f389-1a28-4c0e-91fb-9af20782a65e",
      "name": "Insert or update rows in a table",
      "credentials": {
        "postgres": {
          "id": "jlyTJz3dDT39up9x",
          "name": "Postgres account"
        }
      }
    },
    {
      "parameters": {
        "content": "## 🆕 T-012 — Circuit breaker (humano ativo)\n\nO node `If_Humano_Atendendo1` lê os `custom_attributes` da conversa e ABORTA o fluxo da IA se algum destes for `true`:\n- `human_active` (backend T-011 seta quando humano responde sem clicar Assumir)\n- `handoff_to_human` (Mark_handoff1 seta quando IA decide transferir)\n- `human_intervened`\n- `resolved_by === \"human\"`\n\nFallback duplicado para `additional_attributes`.\n\nQuando o cliente reabrir uma conversa (status resolved → open), o backend T-011 limpa todos os `custom_attributes` via PATCH na API do Chatwoot — IA volta a responder normalmente no próximo ciclo.",
        "height": 360,
        "width": 480,
        "color": 4
      },
      "id": "53045518-8afc-4726-bfc0-78025cb9e2c4",
      "name": "Note_CircuitBreaker_T012",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [
        -3936,
        -560
      ]
    }
  ],
  "pinData": {},
  "connections": {
    "config1": {
      "main": [
        [
          {
            "node": "Switch_Evento1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "webhook_chatwoot1": {
      "main": [
        [
          {
            "node": "config1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Detectar_Tipo1": {
      "main": [
        [
          {
            "node": "If_NaoEncerrado1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_NaoEncerrado1": {
      "main": [
        [
          {
            "node": "If_Humano_Atendendo1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Conversa_Encerrada_Skip1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Switch_Tipo1": {
      "main": [
        [
          {
            "node": "output_texto1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "HTTP Request",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "output_texto1": {
      "main": [
        [
          {
            "node": "Mensagem_Completa1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Transcreve_Audio1": {
      "main": [
        [
          {
            "node": "output_audio1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "output_audio1": {
      "main": [
        [
          {
            "node": "Mensagem_Completa1",
            "type": "main",
            "index": 1
          }
        ]
      ]
    },
    "Mensagem_Completa1": {
      "main": [
        [
          {
            "node": "Redis_Push1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Redis_Push1": {
      "main": [
        [
          {
            "node": "Wait_Debounce1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Wait_Debounce1": {
      "main": [
        [
          {
            "node": "Redis_Get1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Redis_Get1": {
      "main": [
        [
          {
            "node": "If_Ultima_Mensagem1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Ultima_Mensagem1": {
      "main": [
        [
          {
            "node": "output_texto4",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Aguarda_Proxima1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Buscar_Historico1": {
      "main": [
        [
          {
            "node": "pega um item do historico",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Output_Parser1": {
      "ai_outputParser": [
        [
          {
            "node": "Auto-fixing Output Parser1",
            "type": "ai_outputParser",
            "index": 0
          }
        ]
      ]
    },
    "Normaliza_Output1": {
      "main": [
        [
          {
            "node": "Switch_Etapa1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Switch_Etapa1": {
      "main": [
        [
          {
            "node": "Label_novo-lead6",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Label_em Atendimento",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Label_Aguardando Resposta",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Label_ Agendado",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Label_ Convertido",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Label_ Perdido",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Responde_Mensagem",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Label_novo-lead6": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Merge_Labels1": {
      "main": [
        [
          {
            "node": "Responde_Mensagem1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Responde_Mensagem1": {
      "main": [
        [
          {
            "node": "Mark_ai_responded1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Mark_ai_responded1": {
      "main": [
        [
          {
            "node": "Insert or update rows in a table",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Transferir1": {
      "main": [
        [
          {
            "node": "Mark_handoff1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "If_Resolver1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Mark_handoff1": {
      "main": [
        [
          {
            "node": "Buscar_Agentes1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Buscar_Agentes1": {
      "main": [
        [
          {
            "node": "Sortear_Agente1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Sortear_Agente1": {
      "main": [
        [
          {
            "node": "If_Has_Agent1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Atribuir_Agente1": {
      "main": [
        [
          {
            "node": "Abrir_Conversa_Humano1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Resolver1": {
      "main": [
        [
          {
            "node": "1_Mark_resolved_by_ai1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "1_Mark_resolved_by_ai1": {
      "main": [
        [
          {
            "node": "2_Log_Resolution_AI_HTTP1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Output_Parser_Resposta1": {
      "ai_outputParser": [
        [
          {
            "node": "AI Agent8",
            "type": "ai_outputParser",
            "index": 0
          }
        ]
      ]
    },
    "2_Log_Resolution_AI_HTTP1": {
      "main": [
        [
          {
            "node": "3_Resolver_Conversa1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Switch_Evento1": {
      "main": [
        [
          {
            "node": "Detectar_Tipo1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "If_Humano_Fechou1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Humano_Fechou1": {
      "main": [
        [
          {
            "node": "Log_Resolution_Human_HTTP1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Skip (IA já logou)1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Has_Agent1": {
      "main": [
        [
          {
            "node": "Atribuir_Agente1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Abrir_Conversa_Humano1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "AI Agent": {
      "main": [
        [
          {
            "node": "Variaveis de interesse",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "OpenAI Chat Model": {
      "ai_languageModel": [
        [
          {
            "node": "AI Agent",
            "type": "ai_languageModel",
            "index": 0
          }
        ]
      ]
    },
    "AI Agent8": {
      "main": [
        [
          {
            "node": "Normaliza_Output1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "OpenAI Chat Model10": {
      "ai_languageModel": [
        [
          {
            "node": "AI Agent8",
            "type": "ai_languageModel",
            "index": 0
          }
        ]
      ]
    },
    "Postgres Chat Memory1": {
      "ai_memory": [
        [
          {
            "node": "AI Agent8",
            "type": "ai_memory",
            "index": 0
          }
        ]
      ]
    },
    "MCP Client1": {
      "ai_tool": [
        [
          {
            "node": "AI Agent8",
            "type": "ai_tool",
            "index": 0
          }
        ]
      ]
    },
    "Variaveis de interesse": {
      "main": [
        [
          {
            "node": "AI Agent8",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "retorna histórico formatado": {
      "main": [
        [
          {
            "node": "AI Agent",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "pega um item do historico": {
      "main": [
        [
          {
            "node": "retorna histórico formatado",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Mensagem_Final+variaveis": {
      "main": [
        [
          {
            "node": "Buscar_Historico1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "output_texto4": {
      "main": [
        [
          {
            "node": "Redis1",
            "type": "main",
            "index": 0
          },
          {
            "node": "Mensagem_Final+variaveis",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Label_em Atendimento": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 1
          }
        ]
      ]
    },
    "Label_Aguardando Resposta": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 2
          }
        ]
      ]
    },
    "Label_ Agendado": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 3
          }
        ]
      ]
    },
    "Label_ Convertido": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 4
          }
        ]
      ]
    },
    "Label_ Perdido": {
      "main": [
        [
          {
            "node": "Merge_Labels1",
            "type": "main",
            "index": 5
          }
        ]
      ]
    },
    "Responde_Mensagem": {
      "main": [
        [
          {
            "node": "Mark_ai_responded1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Auto-fixing Output Parser1": {
      "ai_outputParser": [
        [
          {
            "node": "AI Agent",
            "type": "ai_outputParser",
            "index": 0
          }
        ]
      ]
    },
    "OpenAI Chat Model1": {
      "ai_languageModel": [
        [
          {
            "node": "Auto-fixing Output Parser1",
            "type": "ai_languageModel",
            "index": 0
          }
        ]
      ]
    },
    "HTTP Request": {
      "main": [
        [
          {
            "node": "Transcreve_Audio1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Insert or update rows in a table": {
      "main": [
        [
          {
            "node": "If_Transferir1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "If_Humano_Atendendo1": {
      "main": [
        [
          {
            "node": "Skip_Humano_Atendendo1",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Switch_Tipo1",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": true,
  "settings": {
    "executionOrder": "v1",
    "binaryMode": "separate"
  },
  "versionId": "14848e49-2d56-46dd-b281-ec4e3d74d068",
  "meta": {
    "templateCredsSetupCompleted": true,
    "instanceId": "ea67bf2b30169b7af3c0c1aa0a636991c2fe04298daa0d6c7b84054a949fffd5"
  },
  "id": "QnR0IlnWc1Ig4IqI",
  "tags": []
};
