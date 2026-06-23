import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export interface WhatsappTemplate {
  id: string;
  name: string;
  content: string;
  category: string;
  createdAt: string;
}

function normalize(t: any): WhatsappTemplate {
  return {
    id: t.id,
    name: t.name,
    content: t.content,
    category: t.category ?? 'custom',
    createdAt: t.createdAt ?? t.created_at ?? new Date().toISOString(),
  };
}

export async function listTemplates(): Promise<WhatsappTemplate[]> {
  const res = await apiClient.get<any>(API_ENDPOINTS.WHATSAPP_TEMPLATES.LIST);
  const data = (res as any).data ?? res;
  return (Array.isArray(data) ? data : []).map(normalize);
}

export async function createTemplate(payload: {
  name: string;
  content: string;
  category?: string;
}): Promise<WhatsappTemplate> {
  const res = await apiClient.post<any>(API_ENDPOINTS.WHATSAPP_TEMPLATES.CREATE, payload);
  const data = (res as any).data ?? res;
  return normalize(data);
}

export async function updateTemplate(
  id: string,
  payload: { name?: string; content?: string; category?: string }
): Promise<WhatsappTemplate> {
  const res = await apiClient.patch<any>(API_ENDPOINTS.WHATSAPP_TEMPLATES.UPDATE(id), payload);
  const data = (res as any).data ?? res;
  return normalize(data);
}

export async function deleteTemplate(id: string): Promise<void> {
  await apiClient.delete(API_ENDPOINTS.WHATSAPP_TEMPLATES.DELETE(id));
}
