/** Formatação e rampa fixa do aquecimento (mesma tabela do backend: rampa única de 30 dias). */

const RAMPA_INICIAL = [10, 12, 15, 20, 25, 30, 40];

/** Mensagens planejadas por dia (1..30), só para desenhar a curva explicativa. */
export function rampaPorDia(): { dia: number; mensagens: number }[] {
  const out: { dia: number; mensagens: number }[] = [];
  for (let d = 1; d <= 30; d++) {
    let n: number;
    if (d <= 7) n = RAMPA_INICIAL[d - 1];
    else if (d <= 14) n = Math.round(50 + ((d - 8) * 30) / 6);
    else if (d <= 21) n = Math.round(100 + ((d - 15) * 80) / 6);
    else n = 200;
    out.push({ dia: d, mensagens: n });
  }
  return out;
}

/** 5534988119078 -> +55 34 98811-9078 (cai para o valor cru se não bater). */
export function formatarTelefone(tel: string | null | undefined): string {
  const d = (tel ?? '').replace(/\D/g, '');
  const m = d.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+${m[1]} ${m[2]} ${m[3]}-${m[4]}` : tel ?? '';
}

export function iniciais(nome: string): string {
  const p = nome.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[1][0]).toUpperCase();
}

/** "em 4 min" / "agora" a partir de uma data ISO. */
export function emQuantoTempo(iso: string | null | undefined, agora = Date.now()): string {
  if (!iso) return 'em breve';
  const min = Math.round((new Date(iso).getTime() - agora) / 60000);
  if (min <= 0) return 'agora';
  if (min < 60) return `em ${min} min`;
  return `em ${Math.floor(min / 60)} h ${min % 60} min`;
}

export function horaCurta(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** "08:00" -> "08h" para o rótulo da janela. */
export function horaDaJanela(hhmm: string): string {
  return `${hhmm.slice(0, 2)}h`;
}

/** Só mostra o aviso de infra quando a data é futura. */
export function infraPausaAtiva(iso: string | null | undefined, agora = Date.now()): boolean {
  return !!iso && new Date(iso).getTime() > agora;
}
