/**
 * ETAPA D — o bloco "CONTEXTO DO DISPARO" que o agente de IA recebe quando a
 * conversa nasceu de um disparo.
 *
 * Mora num módulo só com Prisma (sem Evolution, sem worker) de propósito: o
 * ai-agent.service importa daqui, e carregar o motor inteiro de disparos
 * dentro do agente custaria em todo teste do agente e em todo boot.
 */
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../../config/database';
import { FUSO_PADRAO, renderizarMensagem, type VariaveisDoEnvio } from './regras';

const STATUS_QUE_CONTAM = ['enviada', 'entregue', 'lida', 'respondeu'];

/**
 * "Esta conversa começou com o disparo '<nome>' enviado em <dd/MM HH:mm>:
 * «<texto renderizado>». A pessoa acabou de responder." — ou null quando a
 * conversa não veio de disparo nenhum.
 */
export async function contextoDoDisparoParaAgente(conversationId: string): Promise<string | null> {
  if (!conversationId) return null;

  const envio = await prisma.disparoEnvio.findFirst({
    where: { conversationId, status: { in: STATUS_QUE_CONTAM } },
    orderBy: [{ enviadoEm: 'desc' }, { createdAt: 'desc' }],
    select: {
      variante: true,
      variaveis: true,
      enviadoEm: true,
      createdAt: true,
      disparo: {
        select: {
          nome: true,
          texto: true,
          variantes: true,
          account: { select: { timezone: true } },
        },
      },
    },
  });
  if (!envio?.disparo) return null;

  const d = envio.disparo;
  const texto = renderizarMensagem(d.texto, d.variantes, envio.variante, envio.variaveis as VariaveisDoEnvio | null);
  const fuso = d.account?.timezone?.trim() || FUSO_PADRAO;
  let quando: string;
  try {
    quando = formatInTimeZone(envio.enviadoEm ?? envio.createdAt, fuso, 'dd/MM HH:mm');
  } catch {
    quando = formatInTimeZone(envio.enviadoEm ?? envio.createdAt, FUSO_PADRAO, 'dd/MM HH:mm');
  }

  return (
    `Esta conversa começou com o disparo '${d.nome}' enviado em ${quando}: «${texto}». ` +
    'A pessoa acabou de responder.'
  );
}
