import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Seed Gleps (originalmente seed-fitpark.ts da Variação-FitPark).
 * Mantido o nome de arquivo pra preservar histórico de import; identidade
 * agora é 100% Gleps (admin@gleps.com.br, Account "Gleps").
 */
const prisma = new PrismaClient();

async function main() {
  console.log('Seed Gleps — estrutura sem dados fakes');

  const superHash = await bcrypt.hash('Admin@123', 12);
  const adminHash = await bcrypt.hash('Admin@123', 12);

  // 1 super-admin
  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@gleps.com.br' },
    update: { passwordHash: superHash, status: 'active' },
    create: {
      email: 'superadmin@gleps.com.br',
      nome: 'Super Admin Gleps',
      passwordHash: superHash,
      role: 'super_admin',
      status: 'active',
      permissions: [],
    },
  });
  console.log('Super admin:', superAdmin.email);

  // 1 account modelo
  const accountId = '00000000-0000-0000-0000-000000000001';
  const account = await prisma.account.upsert({
    where: { id: accountId },
    update: {},
    create: {
      id: accountId,
      nome: 'Gleps',
      plano: 'Premium',
      status: 'active',
      limiteUsuarios: 50,
      timezone: 'America/Sao_Paulo',
      monthlyExtractionLimit: 5000,
      monthlyEmailLimit: 30000,
      dailyEmailLimit: 1000,
    },
  });
  console.log('Account:', account.nome);

  // Funil padrão + stages
  const funnel = await prisma.funnel.upsert({
    where: { accountId_slug: { accountId, slug: 'principal' } },
    update: {},
    create: { accountId, name: 'Funil Principal', slug: 'principal', isDefault: true },
  });
  const stages = [
    { name: 'Novo Lead', slug: 'novo-lead', color: '#5B3DF5', ordem: 0 },
    { name: 'Em Contato', slug: 'em-contato', color: '#8A6CFF', ordem: 1 },
    { name: 'Reunião Agendada', slug: 'reuniao-agendada', color: '#3B82F6', ordem: 2 },
    { name: 'Proposta Enviada', slug: 'proposta-enviada', color: '#5B3DF5', ordem: 3 },
    { name: 'Cliente Ativo', slug: 'cliente-ativo', color: '#22C55E', ordem: 4 },
    { name: 'Inativo', slug: 'inativo', color: '#EF4444', ordem: 5 },
  ];
  for (const s of stages) {
    await prisma.tag.upsert({
      where: { accountId_slug: { accountId, slug: s.slug } },
      update: {},
      create: { accountId, funnelId: funnel.id, name: s.name, slug: s.slug, type: 'stage', color: s.color, ordem: s.ordem, ativo: true },
    });
  }
  console.log('Funil + 6 stages criados');

  // 1 admin pra conta
  const admin = await prisma.user.upsert({
    where: { email: 'admin@gleps.com.br' },
    update: { passwordHash: adminHash, status: 'active', accountId },
    create: {
      email: 'admin@gleps.com.br',
      nome: 'Admin Gleps',
      passwordHash: adminHash,
      role: 'admin',
      status: 'active',
      accountId,
      permissions: [],
    },
  });
  console.log('Admin conta:', admin.email);

  console.log('\nLOGIN:');
  console.log('  Super Admin: superadmin@gleps.com.br / Admin@123');
  console.log('  Admin Conta: admin@gleps.com.br / Admin@123');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
