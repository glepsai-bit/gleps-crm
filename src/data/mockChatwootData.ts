import { ChatwootAgent } from '@/types/crm';

/**
 * Mock data simulando resposta da API do Chatwoot
 * GET /api/v1/accounts/{account_id}/agents
 */
export const mockChatwootAgents: ChatwootAgent[] = [
  {
    id: 101,
    name: 'Ana Paula Costa',
    email: 'ana@clinica.com',
    role: 'agent',
    availability_status: 'online',
    thumbnail: null,
  },
  {
    id: 102,
    name: 'Pedro Oliveira',
    email: 'pedro@clinica.com',
    role: 'agent',
    availability_status: 'offline',
    thumbnail: null,
  },
  {
    id: 103,
    name: 'Dr. Carlos Silva',
    email: 'carlos@clinica.com',
    role: 'administrator',
    availability_status: 'online',
    thumbnail: null,
  },
  {
    id: 104,
    name: 'Maria Santos',
    email: 'maria@clinica.com',
    role: 'agent',
    availability_status: 'busy',
    thumbnail: null,
  },
  {
    id: 105,
    name: 'João Ferreira',
    email: 'joao@clinica.com',
    role: 'agent',
    availability_status: 'offline',
    thumbnail: null,
  },
];
