# cashControl

Ferramenta de gestão de finanças pessoais em **desenvolvimento incremental**, com núcleo financeiro versionado e interface interativa React em validação local.

O produto será multiusuário com finanças isoladas por perfil. Compartilhamento familiar com permissões poderá ser uma evolução futura, sem fazer parte do MVP.

O produto deverá permitir registrar entradas, saídas, fontes de renda, contas a pagar, cartões e faturas, trabalhos opcionais, valores a receber, intenções de compra, reservas preventivas, projeções conservadoras e uma linha do tempo financeira. Relatórios exportáveis em XLSX e PDF também fazem parte dos requisitos iniciais.

## Documentação de produto

- [Especificação central — SPEC-000](docs/specs/SPEC-000-produto-mvp.md)
- [Backlog estruturado — 7 épicos e 23 tickets](docs/planning/BACKLOG.md)

- [Registro de Decisões de Negócio — DEC-001 a DEC-014](docs/decisions/DECISOES-DE-NEGOCIO.md)

As DEC registram **o que foi aprovado** em discussões de produto. Não são ADRs técnicos, não constituem especificações completas de implementação e não autorizam codificação automática.

**Fluxo de trabalho:** descoberta de produto → registro e esclarecimento de decisões → especificações com critérios de aceite → tickets implementáveis → arquitetura e implementação.

## Estado

- DEC-001 a DEC-014: registradas e aprovadas nos limites indicados em cada decisão.
- Especificação funcional e tickets: **publicados**, com implementação incremental P0/P1/P2; decisões técnicas ainda dependem da Issue #8.
- Backend financeiro (contas, movimentos, obrigações, transferências e reembolsos): implementado e testado em D1 local.
- Dashboard backend: [PR #36](https://github.com/carloshgalves/cashControl/pull/36), em Draft, com dados em centavos e isolamento por usuário.
- Dashboard interativo React/Vite: branch empilhada `feat/interactive-dashboard-ui`, aprovada visualmente e validada no Chromium; aguarda revisão/merge manual.
- Cloudflare hospedada e produção: deliberadamente adiadas até o produto estar mais completo.

O documento de decisões é a fonte atual das regras de negócio acordadas. Mudanças devem ser explicitadas e vinculadas à decisão que modificam.

## Desenvolvimento local da interface

Requisitos: Node.js 22.16+ e npm. Execute `npm ci`, configure Wrangler/D1 **local** usando `wrangler.toml.example` e `.dev.vars` ignorados pelo Git, e aplique `npx wrangler d1 migrations apply DB --local --config wrangler.toml`.

Inicie o Worker com `npm run dev -- --ip 127.0.0.1 --port 8787 --config wrangler.toml` e a interface com `npm run ui:dev` em outro terminal; abra **http://127.0.0.1:5173**. O Vite encaminha `/api` ao Worker local. `BETTER_AUTH_URL` deve corresponder à URL do Worker, `http://127.0.0.1:8787`.

Testes: `npm run ui:check`, `npm run ui:test`, `npm run ui:build`, `npm test`. `npm run ui:e2e` exige Worker, frontend e banco local preparados, além de Chromium instalado via Playwright. A execução comprovada está em [GitHub Actions #42941383664](https://github.com/carloshgalves/cashControl/actions/runs/42941383664).

Relatório de revisão da interface: [INTERACTIVE-UI-REVIEW.md](docs/implementation/INTERACTIVE-UI-REVIEW.md).

**Não use contas nem dados financeiros reais neste ambiente de homologação.** Não existe deploy de produção nesta entrega.
