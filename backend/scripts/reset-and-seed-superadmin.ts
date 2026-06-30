/**
 * RESET TOTAL DO BANCO + CRIAR APENAS 1 SUPER ADMIN
 *
 * USO (no console do EasyPanel, dentro do container backend):
 *
 *   # Defaults (admin@gleps.com.br / Admin@123 / Super Admin)
 *   CONFIRM=YES npx tsx scripts/reset-and-seed-superadmin.ts
 *
 *   # Custom:
 *   CONFIRM=YES \
 *   SUPER_ADMIN_EMAIL=voce@exemplo.com \
 *   SUPER_ADMIN_PASSWORD='SuaSenha@2026' \
 *   SUPER_ADMIN_NAME='Seu Nome' \
 *   npx tsx scripts/reset-and-seed-superadmin.ts
 *
 * O script DROPA todo o schema, recria via migrations e cria UM unico
 * super_admin. Falha se CONFIRM != 'YES' (proteção contra rodar por engano).
 */
import { execSync } from 'node:child_process';
import { PrismaClient, type UserRole, type UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

async function main() {
  if (process.env.CONFIRM !== 'YES') {
    console.error(
      '❌ CONFIRM=YES nao foi passado. Este script APAGA TODOS OS DADOS.'
    );
    console.error('   Para confirmar, rode: CONFIRM=YES npx tsx scripts/reset-and-seed-superadmin.ts');
    process.exit(1);
  }

  const email = (process.env.SUPER_ADMIN_EMAIL ?? 'admin@gleps.com.br').toLowerCase().trim();
  const password = process.env.SUPER_ADMIN_PASSWORD ?? 'Admin@123';
  const nome = process.env.SUPER_ADMIN_NAME ?? 'Super Admin';

  console.log('\n⚠️  RESET TOTAL DO BANCO');
  console.log('   Database:', process.env.DATABASE_URL?.replace(/:[^:@]*@/, ':****@'));
  console.log('   Super admin a ser criado:', email);
  console.log('');

  console.log('🗑️  Droppando schema e re-aplicando migrations...');
  try {
    execSync('npx prisma migrate reset --force --skip-seed', {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    console.error('❌ Falha no prisma migrate reset:', err);
    process.exit(1);
  }

  console.log('\n✅ Schema zerado e migrations aplicadas.');
  console.log('👤 Criando unico super_admin:', email);

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.create({
      data: {
        email,
        nome,
        passwordHash,
        role: 'super_admin' as UserRole,
        status: 'active' as UserStatus,
        permissions: [],
      },
    });

    const totalUsers = await prisma.user.count();
    const totalAccounts = await prisma.account.count();

    console.log('\n🎉 PRONTO');
    console.log('   Users no DB:', totalUsers);
    console.log('   Accounts no DB:', totalAccounts);
    console.log('   ');
    console.log('   ✅ Login:');
    console.log('      Email:', email);
    console.log('      Senha:', password);
    console.log('');
    console.log('   Agora voce pode logar em https://360.gleps.com.br/login');
    console.log('   e comecar do zero. Criar contas, agentes, etc.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
