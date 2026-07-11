/**
 * AVATAR STORAGE — foto de perfil do contato persistida localmente.
 *
 * A Evolution devolve URLs do CDN do WhatsApp (pps/mmg.whatsapp.net) que
 * EXPIRAM em minutos/horas. Gravar essa URL em Contact.profilePicUrl fazia a
 * foto "funcionar" por alguns minutos e depois quebrar — na prática ninguém
 * via avatar no CRM. Aqui baixamos os bytes assim que a URL é obtida e
 * servimos localmente via GET /api/contacts/:id/avatar (autenticado).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { safeFetch } from '../utils/ssrf-guard';
import { attachmentStorageService } from './attachment-storage.service';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // fotos de perfil são ~5-100KB

class AvatarStorageService {
  private relativePath(accountId: string, contactId: string): string {
    return path.join(accountId, 'avatars', `${contactId}.jpg`);
  }

  absolutePath(accountId: string, contactId: string): string {
    return attachmentStorageService.resolveAbsolutePath(
      this.relativePath(accountId, contactId)
    );
  }

  /**
   * Baixa a foto do CDN e grava em disco. Retorna a URL local estável
   * (com cache-buster) ou null em falha. Nunca lança.
   */
  async persistFromCdn(
    accountId: string,
    contactId: string,
    cdnUrl: string
  ): Promise<string | null> {
    try {
      const res = await safeFetch(cdnUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`CDN respondeu ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) {
        throw new Error(`tamanho inválido: ${buf.length} bytes`);
      }
      const abs = this.absolutePath(accountId, contactId);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      // v= força o browser a revalidar quando a foto muda (24h TTL upstream).
      return `/api/contacts/${contactId}/avatar?v=${Date.now()}`;
    } catch (err) {
      logger.warn('[avatar-storage] falha ao persistir foto do CDN', {
        accountId,
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Stat do avatar em disco; null quando não existe. */
  async stat(
    accountId: string,
    contactId: string
  ): Promise<{ absolutePath: string; byteLength: number } | null> {
    try {
      const abs = this.absolutePath(accountId, contactId);
      const s = await fs.stat(abs);
      if (s.size === 0) return null;
      return { absolutePath: abs, byteLength: s.size };
    } catch {
      return null;
    }
  }
}

export const avatarStorageService = new AvatarStorageService();
