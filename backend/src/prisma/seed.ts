import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Hash password for admin users
  const adminPasswordHash = await bcrypt.hash('Admin@123', 12);

  // ── Always ensure critical super admin users exist (idempotent) ──
  const criticalAdmins = [
    { email: 'superadmin@sistema.com', nome: 'Super Admin' },
    { email: 'admin@gleps.com.br', nome: 'Admin GLEPS' },
    { email: 'glepsai@gmail.com', nome: 'GLEPS AI Admin' },
    { email: 'admin@mychooice.com', nome: 'Admin MyChooice' },
  ];

  for (const admin of criticalAdmins) {
    await prisma.user.upsert({
      where: { email: admin.email },
      update: { passwordHash: adminPasswordHash, status: 'active' },
      create: {
        email: admin.email,
        nome: admin.nome,
        passwordHash: adminPasswordHash,
        role: 'super_admin',
        status: 'active',
        permissions: [],
      },
    });
    console.log('✅ Super Admin ensured:', admin.email);
  }

  // Guard: skip demo data if other users already exist
  const existingUsers = await prisma.user.count();
  if (existingUsers > criticalAdmins.length) {
    console.log('⏭️  Demo data skipped — database already populated (' + existingUsers + ' users)');
    return;
  }

  // Hash passwords for demo users
  const agentPasswordHash = await bcrypt.hash('Agent@123', 12);

  // Create Account 1 - Clínica Vida Plena
  const account1 = await prisma.account.upsert({
    where: { id: '11111111-1111-1111-1111-111111111111' },
    update: {},
    create: {
      id: '11111111-1111-1111-1111-111111111111',
      nome: 'Clínica Vida Plena',
      plano: 'Premium',
      status: 'active',
      limiteUsuarios: 20,
      timezone: 'America/Sao_Paulo',
    },
  });
  console.log('✅ Account created:', account1.nome);

  // Create Default Funnel for Account 1
  const funnel1 = await prisma.funnel.upsert({
    where: { accountId_slug: { accountId: account1.id, slug: 'principal' } },
    update: {},
    create: {
      accountId: account1.id,
      name: 'Funil Principal',
      slug: 'principal',
      isDefault: true,
    },
  });

  // Create Tags/Stages for Funnel 1
  const stages = [
    { name: 'Novo Lead', slug: 'novo-lead', color: '#6366F1', ordem: 0 },
    { name: 'Em Contato', slug: 'em-contato', color: '#8B5CF6', ordem: 1 },
    { name: 'Agendado', slug: 'agendado', color: '#F59E0B', ordem: 2 },
    { name: 'Em Negociação', slug: 'em-negociacao', color: '#3B82F6', ordem: 3 },
    { name: 'Fechado', slug: 'fechado', color: '#10B981', ordem: 4 },
    { name: 'Perdido', slug: 'perdido', color: '#EF4444', ordem: 5 },
  ];

  for (const stage of stages) {
    await prisma.tag.upsert({
      where: { accountId_slug: { accountId: account1.id, slug: stage.slug } },
      update: {},
      create: {
        accountId: account1.id,
        funnelId: funnel1.id,
        name: stage.name,
        slug: stage.slug,
        type: 'stage',
        color: stage.color,
        ordem: stage.ordem,
        ativo: true,
      },
    });
  }
  console.log('✅ Tags/Stages created');

  // Create Admin for Account 1
  const admin1 = await prisma.user.upsert({
    where: { email: 'carlos@clinicavidaplena.com' },
    update: {},
    create: {
      email: 'carlos@clinicavidaplena.com',
      nome: 'Carlos Silva',
      passwordHash: adminPasswordHash,
      role: 'admin',
      status: 'active',
      accountId: account1.id,
      permissions: [],
    },
  });
  console.log('✅ Admin created:', admin1.email);

  // Create Agents for Account 1
  const agent1 = await prisma.user.upsert({
    where: { email: 'ana@clinicavidaplena.com' },
    update: {},
    create: {
      email: 'ana@clinicavidaplena.com',
      nome: 'Ana Paula',
      passwordHash: agentPasswordHash,
      role: 'agent',
      status: 'active',
      accountId: account1.id,
      permissions: ['dashboard', 'kanban', 'leads', 'sales', 'agenda'],
    },
  });

  const agent2 = await prisma.user.upsert({
    where: { email: 'pedro@clinicavidaplena.com' },
    update: {},
    create: {
      email: 'pedro@clinicavidaplena.com',
      nome: 'Pedro Santos',
      passwordHash: agentPasswordHash,
      role: 'agent',
      status: 'active',
      accountId: account1.id,
      permissions: ['dashboard', 'kanban', 'leads', 'sales'],
    },
  });
  console.log('✅ Agents created:', agent1.email, agent2.email);

  // Create Products for Account 1
  const products = [
    { nome: 'Consulta Inicial', valorPadrao: 150.00, metodos: ['pix', 'credito', 'debito', 'dinheiro'] },
    { nome: 'Retorno', valorPadrao: 80.00, metodos: ['pix', 'credito', 'debito', 'dinheiro'] },
    { nome: 'Tratamento Básico', valorPadrao: 500.00, metodos: ['pix', 'credito', 'boleto'] },
    { nome: 'Tratamento Premium', valorPadrao: 1200.00, metodos: ['pix', 'credito', 'boleto', 'convenio'] },
    { nome: 'Procedimento Especial', valorPadrao: 2500.00, metodos: ['pix', 'credito', 'boleto'] },
  ];

  const createdProducts: any[] = [];
  for (const product of products) {
    const created = await prisma.product.create({
      data: {
        accountId: account1.id,
        nome: product.nome,
        valorPadrao: product.valorPadrao,
        metodosPagamento: product.metodos,
        conveniosAceitos: product.nome.includes('Premium') ? ['Unimed', 'Bradesco Saúde', 'SulAmérica'] : [],
        ativo: true,
      },
    });
    createdProducts.push(created);
  }
  console.log('✅ Products created');

  // Create Contacts for Account 1
  const contacts = [
    { nome: 'Maria Santos', telefone: '11999887766', email: 'maria@email.com', origem: 'whatsapp' },
    { nome: 'João Oliveira', telefone: '11988776655', email: 'joao@email.com', origem: 'instagram' },
    { nome: 'Ana Costa', telefone: '11977665544', email: 'ana@email.com', origem: 'site' },
    { nome: 'Pedro Almeida', telefone: '11966554433', email: 'pedro@email.com', origem: 'indicacao' },
    { nome: 'Carla Souza', telefone: '11955443322', email: 'carla@email.com', origem: 'whatsapp' },
    { nome: 'Lucas Lima', telefone: '11944332211', email: 'lucas@email.com', origem: 'instagram' },
    { nome: 'Julia Ferreira', telefone: '11933221100', email: 'julia@email.com', origem: 'site' },
    { nome: 'Rafael Martins', telefone: '11922110099', email: 'rafael@email.com', origem: 'whatsapp' },
  ];

  const createdContacts: any[] = [];
  for (const contact of contacts) {
    const created = await prisma.contact.create({
      data: {
        accountId: account1.id,
        nome: contact.nome,
        telefone: contact.telefone,
        email: contact.email,
        origem: contact.origem as any,
      },
    });
    createdContacts.push(created);
  }
  console.log('✅ Contacts created');

  // Assign some contacts to stages
  const tags = await prisma.tag.findMany({
    where: { accountId: account1.id, type: 'stage' },
    orderBy: { ordem: 'asc' },
  });

  for (let i = 0; i < createdContacts.length; i++) {
    const tagIndex = i % tags.length;
    await prisma.leadTag.create({
      data: {
        contactId: createdContacts[i].id,
        tagId: tags[tagIndex].id,
        appliedByType: 'system',
        source: 'system',
      },
    });
  }
  console.log('✅ Contacts assigned to stages');

  // Create Sales for Account 1
  const salesData = [
    { contactIndex: 0, productIndex: 0, status: 'paid', metodoPagamento: 'pix', responsavelId: agent1.id },
    { contactIndex: 0, productIndex: 2, status: 'paid', metodoPagamento: 'credito', responsavelId: agent1.id },
    { contactIndex: 1, productIndex: 1, status: 'paid', metodoPagamento: 'dinheiro', responsavelId: agent2.id },
    { contactIndex: 2, productIndex: 3, status: 'pending', metodoPagamento: 'boleto', responsavelId: agent1.id },
    { contactIndex: 3, productIndex: 0, status: 'paid', metodoPagamento: 'debito', responsavelId: agent2.id },
    { contactIndex: 4, productIndex: 4, status: 'paid', metodoPagamento: 'pix', responsavelId: agent1.id },
    { contactIndex: 5, productIndex: 1, status: 'refunded', metodoPagamento: 'pix', responsavelId: agent2.id },
  ];

  for (const saleData of salesData) {
    const product = createdProducts[saleData.productIndex];
    const contact = createdContacts[saleData.contactIndex];

    const sale = await prisma.sale.create({
      data: {
        accountId: account1.id,
        contactId: contact.id,
        valor: product.valorPadrao,
        status: saleData.status as any,
        metodoPagamento: saleData.metodoPagamento as any,
        responsavelId: saleData.responsavelId,
        paidAt: saleData.status === 'paid' ? new Date() : null,
        refundedAt: saleData.status === 'refunded' ? new Date() : null,
        refundReason: saleData.status === 'refunded' ? 'Cliente desistiu' : null,
        items: {
          create: {
            productId: product.id,
            quantidade: 1,
            valorUnitario: product.valorPadrao,
            valorTotal: product.valorPadrao,
            refunded: saleData.status === 'refunded',
          },
        },
      },
    });
  }
  console.log('✅ Sales created');

  // Create Account 2 - Loja Express (paused account for testing)
  const account2 = await prisma.account.upsert({
    where: { id: '22222222-2222-2222-2222-222222222222' },
    update: {},
    create: {
      id: '22222222-2222-2222-2222-222222222222',
      nome: 'Loja Express',
      plano: 'Básico',
      status: 'paused',
      limiteUsuarios: 5,
      timezone: 'America/Sao_Paulo',
    },
  });

  // Create Default Funnel for Account 2
  await prisma.funnel.upsert({
    where: { accountId_slug: { accountId: account2.id, slug: 'principal' } },
    update: {},
    create: {
      accountId: account2.id,
      name: 'Funil Principal',
      slug: 'principal',
      isDefault: true,
    },
  });

  // Create Admin for Account 2 (suspended)
  await prisma.user.upsert({
    where: { email: 'roberto@lojaexpress.com' },
    update: {},
    create: {
      email: 'roberto@lojaexpress.com',
      nome: 'Roberto Lima',
      passwordHash: adminPasswordHash,
      role: 'admin',
      status: 'active',
      accountId: account2.id,
      permissions: [],
    },
  });
  console.log('✅ Account 2 (paused) created');

  console.log('');
  console.log('🎉 Database seed completed successfully!');
  console.log('');
  console.log('📋 Test Credentials:');
  console.log('  Super Admin: superadmin@sistema.com / Admin@123');
  console.log('  Super Admin: admin@gleps.com.br / Admin@123');
  console.log('  Super Admin: glepsai@gmail.com / Admin@123');
  console.log('  Admin: carlos@clinicavidaplena.com / Admin@123');
  console.log('  Agent: ana@clinicavidaplena.com / Agent@123');
  console.log('  Agent: pedro@clinicavidaplena.com / Agent@123');
  console.log('  (Paused Account) Admin: roberto@lojaexpress.com / Admin@123');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
