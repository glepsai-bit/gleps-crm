import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seed FitPark — estrutura sem dados fakes');

  const superHash = await bcrypt.hash('Admin@123', 12);
  const adminHash = await bcrypt.hash('Admin@123', 12);

  // 1 super-admin
  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@fitpark.com' },
    update: { passwordHash: superHash, status: 'active' },
    create: {
      email: 'superadmin@fitpark.com',
      nome: 'Super Admin FitPark',
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
      nome: 'FitPark Academia',
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
    { name: 'Novo Lead', slug: 'novo-lead', color: '#10B981', ordem: 0 },
    { name: 'Em Contato', slug: 'em-contato', color: '#F97316', ordem: 1 },
    { name: 'Avaliação Agendada', slug: 'avaliacao-agendada', color: '#3B82F6', ordem: 2 },
    { name: 'Matrícula', slug: 'matricula', color: '#10B981', ordem: 3 },
    { name: 'Aluno Ativo', slug: 'aluno-ativo', color: '#22C55E', ordem: 4 },
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
    where: { email: 'admin@fitpark.com' },
    update: { passwordHash: adminHash, status: 'active', accountId },
    create: {
      email: 'admin@fitpark.com',
      nome: 'Admin FitPark',
      passwordHash: adminHash,
      role: 'admin',
      status: 'active',
      accountId,
      permissions: [],
    },
  });
  console.log('Admin conta:', admin.email);

  console.log('\nLOGIN:');
  console.log('  Super Admin: superadmin@fitpark.com / Admin@123');
  console.log('  Admin Conta: admin@fitpark.com / Admin@123');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
