import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Garantir SystemSettings com Evolution global (se não tiver)
  const settings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      evolutionBaseUrl: 'https://autevo.gleps.com.br',
      evolutionApiKey: '429683C4C977415CAAFCCE10F7D57E11',
    },
  });

  // 2. Se conta FitPark tem evolution* per-account, MANTER (override) — não limpar

  // 3. Criar Inbox padrão "WhatsApp Principal" pra conta FitPark com instance fitpark-principal
  const accountId = '00000000-0000-0000-0000-000000000001';
  const existing = await prisma.inbox.findFirst({
    where: { accountId, evolutionInstance: 'fitpark-principal' },
  });

  let inboxCreated = false;
  if (!existing) {
    await prisma.inbox.create({
      data: {
        accountId,
        name: 'WhatsApp Principal',
        channelType: 'whatsapp',
        evolutionInstance: 'fitpark-principal',
        active: true,
      },
    });
    inboxCreated = true;
    console.log('Inbox WhatsApp Principal criado');
  } else {
    console.log('Inbox já existe');
  }

  console.log('SystemSettings:', settings.id, 'evo URL:', settings.evolutionBaseUrl);
  console.log(JSON.stringify({ settingsId: settings.id, inboxCreated }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
