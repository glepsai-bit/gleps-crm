/**
 * Roteiros de conversa do aquecimento.
 *
 * Cada roteiro é uma conversa curta entre dois números (A começa, B responde,
 * A fala de novo...). As linhas alternam A/B pela posição: índice par = quem
 * abriu a conversa, índice ímpar = o parceiro. O motor manda uma linha por
 * vez, com 1–5 min entre elas, para parecer uma troca de verdade.
 *
 * Regras do texto: português coloquial de WhatsApp, sem placeholder de nome
 * (o número não sabe com quem fala), sem link, sem palavra que pareça pedido
 * de opt-out ("sair", "parar") — o webhook de consentimento olha toda mensagem
 * inbound antes de saber que é aquecimento.
 */

export const ROTEIROS: ReadonlyArray<ReadonlyArray<string>> = [
  // rotina
  ['oi, tudo bem?', 'tudo sim e vc?', 'na correria, mas tranquilo', 'sei como é rs'],
  ['bom dia!', 'bom dia, tudo certo?', 'tudo certo sim, e aí?', 'tudo em ordem por aqui'],
  ['e aí, como foi o fds?', 'foi tranquilo, fiquei em casa', 'melhor coisa né', 'demais'],
  ['boa tarde', 'boa tarde! tudo bem?', 'tudo ótimo, e vc?', 'tudo bem também, obrigado'],
  ['oi! conseguiu descansar ontem?', 'consegui sim, dormi cedo', 'que bom, precisava né', 'muito rs'],
  ['já almoçou?', 'ainda não, tô terminando umas coisas aqui', 'não esquece de comer hein', 'pode deixar haha'],
  ['opa, tudo tranquilo?', 'tranquilo demais, e vc?', 'na mesma, trabalhando', 'bora que bora'],
  // clima
  ['que calor hoje hein', 'nem me fala, tá insuportável', 'parece que vai chover mais tarde', 'tomara, precisa muito'],
  ['choveu muito aí?', 'choveu sim, alagou tudo na minha rua', 'nossa, aqui foi mais fraquinho', 'que sorte a sua rs'],
  ['viu como esfriou de repente?', 'vi, tirei o casaco do armário hoje', 'eu tô congelando aqui', 'toma um chá vai'],
  ['nossa, que vento forte', 'aqui também, quase levou o portão', 'cuidado aí hein', 'pode deixar'],
  // indicação
  ['vc conhece algum eletricista de confiança?', 'conheço sim, te mando o contato depois', 'ótimo, valeu demais', 'tranquilo'],
  ['me indica um lugar bom pra almoçar?', 'aquele restaurante perto da praça é muito bom', 'o que tem prato feito?', 'esse mesmo, vale a pena'],
  ['sabe de alguém que conserta celular?', 'sei, tem um rapaz aqui perto que é ótimo', 'me passa o endereço depois?', 'passo sim'],
  ['conhece um dentista bom por aí?', 'conheço, minha irmã vai num que é excelente', 'me manda o nome?', 'mando ainda hoje'],
  ['tem alguma academia boa aí perto?', 'tem uma que abriu agora, parece ótima', 'vou dar uma olhada então', 'depois me conta'],
  // confirmação de horário
  ['confirma nosso encontro amanhã às 15h?', 'confirmado!', 'ótimo, até lá', 'até'],
  ['ainda tá de pé o café sexta?', 'tá sim, às 10 né?', 'isso, às 10', 'combinado então'],
  ['pode ser às 14h em vez de 13h?', 'pode sim, sem problema', 'perfeito, obrigado', 'de nada'],
  ['chego uns 10 min atrasado, tudo bem?', 'tranquilo, te espero', 'valeu!', 'sem pressa'],
  ['a reunião continua na quinta?', 'continua, mesmo horário', 'beleza, anotado', 'ok'],
  // agradecimento
  ['obrigado pela ajuda hoje, viu', 'imagina, precisando é só chamar', 'vou cobrar hein rs', 'pode cobrar'],
  ['valeu pela dica do filme, adorei', 'que bom que gostou!', 'o final me pegou de surpresa', 'eu falei haha'],
  ['brigado por me lembrar do aniversário', 'de nada, quase esqueço também rs', 'salvou minha vida', 'hahaha'],
  ['obrigada pelo café de ontem', 'eu que agradeço a companhia', 'repetimos semana que vem?', 'com certeza'],
  // curtos
  ['oi, tudo bem?', 'tudo e vc?', 'tudo'],
  ['chegou bem?', 'cheguei sim, obrigado', 'que bom'],
  ['bom dia, boa semana!', 'pra vc também!'],
  ['lembra de me ligar mais tarde', 'lembro sim', 'valeu'],
  ['vc viu o jogo ontem?', 'vi, que sofrimento', 'quase morri do coração', 'eu também rs', 'mas no fim deu certo', 'graças a deus'],
  ['tá precisando de algo do mercado?', 'só pão e leite, se puder', 'pode deixar', 'obrigada!', 'de nada'],
];

/** Sorteia um roteiro. Aceita o gerador para os testes ficarem determinísticos. */
export function sortearRoteiro(aleatorio: () => number = Math.random): string[] {
  const idx = Math.min(ROTEIROS.length - 1, Math.floor(aleatorio() * ROTEIROS.length));
  return [...ROTEIROS[idx]];
}
