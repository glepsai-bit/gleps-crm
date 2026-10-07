const PASSOS: { titulo: string; texto: string }[] = [
  { titulo: 'Conecte dois ou mais números', texto: ' em Configurações › Inboxes. Um número sozinho não tem com quem conversar.' },
  { titulo: 'Aperte "Aquecer um número"', texto: ' e escolha o número. Só isso — sem pool, estratégia ou mídia.' },
  { titulo: 'Em 30 dias o número está pronto.', texto: ' Ele aparece nos Disparos com o limite diário que aguenta.' },
];

export function ComoFunciona() {
  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
      <h2 className="text-[15px] font-semibold text-foreground">Como funciona</h2>
      <ol className="flex flex-col gap-3.5">
        {PASSOS.map((p, i) => (
          <li key={p.titulo} className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary tabular-nums">{i + 1}</span>
            <div className="text-[13.5px] leading-relaxed text-foreground/90">
              <b className="text-foreground">{p.titulo}</b>{p.texto}
            </div>
          </li>
        ))}
      </ol>
      <p className="border-t pt-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
        As mensagens são textos curtos de cumprimento e conversa, só entre os seus números.{' '}
        <b className="text-foreground/90">Nunca aparecem no Chat nem acionam a IA.</b> Se os envios falharem, o número pausa sozinho; se a Evolution cair, a conversa espera sem punir ninguém.
      </p>
    </div>
  );
}
