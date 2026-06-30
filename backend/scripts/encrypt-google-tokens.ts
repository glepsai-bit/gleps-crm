/**
 * Backfill: criptografa todos os GoogleCalendarToken existentes que ainda
 * estão em plaintext (sem prefixo `v1:`).
 *
 * Uso:
 *   ENCRYPTION_KEY=<hex64> npx tsx backend/scripts/encrypt-google-tokens.ts
 *
 * Idempotente: tokens já criptografados são pulados.
 * Não logga os valores em claro — apenas userId + status.
 */
import { PrismaClient } from '@prisma/client';
import { encrypt, isEncrypted } from '../src/utils/encryption';

const prisma = new PrismaClient();

async function main() {
  const tokens = await prisma.googleCalendarToken.findMany({
    select: { id: true, userId: true, accessToken: true, refreshToken: true },
  });

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const t of tokens) {
    try {
      const accessIsEnc = isEncrypted(t.accessToken);
      const refreshIsEnc = isEncrypted(t.refreshToken);

      if (accessIsEnc && refreshIsEnc) {
        skipped++;
        continue;
      }

      const data: { accessToken?: string; refreshToken?: string } = {};
      if (!accessIsEnc && t.accessToken) data.accessToken = encrypt(t.accessToken);
      if (!refreshIsEnc && t.refreshToken) data.refreshToken = encrypt(t.refreshToken);

      if (Object.keys(data).length > 0) {
        await prisma.googleCalendarToken.update({
          where: { id: t.id },
          data,
        });
        migrated++;
        console.log(`[encrypt-google-tokens] migrated user=${t.userId} id=${t.id}`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(
        `[encrypt-google-tokens] FAIL user=${t.userId} id=${t.id} →`,
        (err as Error).message
      );
    }
  }

  console.log('---');
  console.log(`Total tokens: ${tokens.length}`);
  console.log(`Migrated:     ${migrated}`);
  console.log(`Skipped:      ${skipped}`);
  console.log(`Errors:       ${errors}`);
}

main()
  .catch((err) => {
    console.error('[encrypt-google-tokens] fatal:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
