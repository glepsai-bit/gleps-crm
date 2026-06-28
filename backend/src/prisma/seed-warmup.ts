import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Seed WarmupTemplate (accountId = null -> templates globais)
// Total: ~50 templates (greeting, response, smalltalk, reaction)

type SeedTpl = {
  type: 'text' | 'audio' | 'sticker' | 'image' | 'reaction';
  category: 'greeting' | 'response' | 'smalltalk' | 'reaction' | 'media';
  content: string;
  weight?: number;
};

const TEMPLATES: SeedTpl[] = [
  // greeting (10)
  { type: 'text', category: 'greeting', content: 'Oi' },
  { type: 'text', category: 'greeting', content: 'Olá' },
  { type: 'text', category: 'greeting', content: 'Bom dia' },
  { type: 'text', category: 'greeting', content: 'Boa tarde' },
  { type: 'text', category: 'greeting', content: 'Boa noite' },
  { type: 'text', category: 'greeting', content: 'E aí' },
  { type: 'text', category: 'greeting', content: 'Tudo bem?' },
  { type: 'text', category: 'greeting', content: 'Como vai?' },
  { type: 'text', category: 'greeting', content: 'Como você está?' },
  { type: 'text', category: 'greeting', content: 'Salve' },

  // response (10)
  { type: 'text', category: 'response', content: 'Tudo certo' },
  { type: 'text', category: 'response', content: 'Por aqui sim' },
  { type: 'text', category: 'response', content: 'Beleza' },
  { type: 'text', category: 'response', content: 'Show' },
  { type: 'text', category: 'response', content: 'Massa' },
  { type: 'text', category: 'response', content: 'Legal' },
  { type: 'text', category: 'response', content: 'Bacana' },
  { type: 'text', category: 'response', content: 'Que bom' },
  { type: 'text', category: 'response', content: 'Que bacana' },
  { type: 'text', category: 'response', content: 'Joia' },

  // smalltalk (17)
  { type: 'text', category: 'smalltalk', content: 'Bom mesmo' },
  { type: 'text', category: 'smalltalk', content: 'Saudade' },
  { type: 'text', category: 'smalltalk', content: 'Fazendo o que?' },
  { type: 'text', category: 'smalltalk', content: 'Trabalhando muito?' },
  { type: 'text', category: 'smalltalk', content: 'Como foi o dia?' },
  { type: 'text', category: 'smalltalk', content: 'Que isso' },
  { type: 'text', category: 'smalltalk', content: 'Verdade' },
  { type: 'text', category: 'smalltalk', content: 'Pois é' },
  { type: 'text', category: 'smalltalk', content: 'Sério?' },
  { type: 'text', category: 'smalltalk', content: 'Caraca' },
  { type: 'text', category: 'smalltalk', content: 'Que loucura' },
  { type: 'text', category: 'smalltalk', content: 'Olha só' },
  { type: 'text', category: 'smalltalk', content: 'Sim sim' },
  { type: 'text', category: 'smalltalk', content: 'Não é?' },
  { type: 'text', category: 'smalltalk', content: 'Concordo plenamente' },
  { type: 'text', category: 'smalltalk', content: 'Verdade verdade' },
  { type: 'text', category: 'smalltalk', content: 'Sim com certeza' },

  // reaction (10)
  { type: 'reaction', category: 'reaction', content: '👍' },
  { type: 'reaction', category: 'reaction', content: '❤️' },
  { type: 'reaction', category: 'reaction', content: '😂' },
  { type: 'reaction', category: 'reaction', content: '🙏' },
  { type: 'reaction', category: 'reaction', content: '🔥' },
  { type: 'reaction', category: 'reaction', content: '👏' },
  { type: 'reaction', category: 'reaction', content: '😊' },
  { type: 'reaction', category: 'reaction', content: '🤔' },
  { type: 'reaction', category: 'reaction', content: '😅' },
  { type: 'reaction', category: 'reaction', content: '✨' },
];

async function main() {
  console.log(`Seed warmup templates — ${TEMPLATES.length} templates globais`);

  // Idempotente: limpa globais antes (accountId null) e re-insere
  await prisma.warmupTemplate.deleteMany({ where: { accountId: null } });

  let inserted = 0;
  for (const tpl of TEMPLATES) {
    await prisma.warmupTemplate.create({
      data: {
        accountId: null,
        type: tpl.type,
        category: tpl.category,
        content: tpl.content,
        weight: tpl.weight ?? 1,
        language: 'pt-BR',
        isActive: true,
      },
    });
    inserted++;
  }

  console.log(`Inseridos: ${inserted} templates globais`);
  const total = await prisma.warmupTemplate.count();
  console.log(`Total na tabela warmup_templates: ${total}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
