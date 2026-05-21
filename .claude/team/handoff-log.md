# Log de handoffs

> Registro cronológico de passagens de bastão entre papéis. Mais recente no topo.
> Modelo:
> ```
> ## [data] T-XXX — <título>  (@origem → @destino)
> - **O que mudou:** ...
> - **Arquivos/rotas afetadas:** ...
> - **Como testar:** ...
> - **Pendências/observações:** ...
> ```

## 2026-05-21 — T-000 Estrutura do time (@dev-principal → equipe)
- **O que mudou:** criada base de coordenação do time em `.claude/agents/` (frontend, qa) e `.claude/team/` (README, board, handoff-log). `.gitignore` passou a excluir `.env*`.
- **Como testar:** ler `.claude/team/README.md` e confirmar que o fluxo faz sentido para o seu papel.
- **Pendências:** inicializar git e fazer o commit base.
