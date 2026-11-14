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
- Dashboard backend: [PR #36](https://github.com/carloshgalves/cashControl/pull/36), mesclada, com dados em centavos e isolamento por usuário.
- Dashboard interativo React/Vite: [PR #37](https://github.com/carloshgalves/cashControl/pull/37), mesclada, aprovada visualmente e validada no Chromium.
- Trilha financeira e avisos in-app D-10/D-5: Issue #17 concluída; PRs #38/#39 mescladas na `main`.
- Exportação privada XLSX/PDF: [PR #40](https://github.com/carloshgalves/cashControl/pull/40) mesclada em `main`; revisar o estado da Issue #18 separadamente.
- Cloudflare hospedada e produção: deliberadamente adiadas até o produto estar mais completo.

O documento de decisões é a fonte atual das regras de negócio acordadas. Mudanças devem ser explicitadas e vinculadas à decisão que modificam.

## Desenvolvimento local da interface

Requisitos: Node.js 22.16+ e npm. Execute `npm ci`, configure Wrangler/D1 **local** usando `wrangler.toml.example` e `.dev.vars` ignorados pelo Git, e aplique `npx wrangler d1 migrations apply DB --local --config wrangler.toml`.

Inicie o Worker com `npm run dev -- --ip 127.0.0.1 --port 8787 --config wrangler.toml` e a interface com `npm run ui:dev` em outro terminal; abra **http://127.0.0.1:5173**. O Vite encaminha `/api` ao Worker local. `BETTER_AUTH_URL` deve corresponder à URL do Worker, `http://127.0.0.1:8787`.

Testes: `npm run ui:check`, `npm run ui:test`, `npm run ui:build`, `npm test`. `npm run ui:e2e` exige Worker, frontend e banco local preparados, além de Chromium instalado via Playwright. A execução comprovada está em [GitHub Actions #42941383664](https://github.com/carloshgalves/cashControl/actions/runs/42941383664).

Relatório de revisão da interface: [INTERACTIVE-UI-REVIEW.md](docs/implementation/INTERACTIVE-UI-REVIEW.md).

**Não use contas nem dados financeiros reais neste ambiente de homologação.** Não existe deploy de produção nesta entrega.

## Trilha financeira (C2)

A tela **Trilha financeira** reúne os eventos confirmados, obrigações pendentes, cancelamentos e avisos de vencimento. Os indicadores D-10/D-5 são calculados a partir da **data local do navegador** e do saldo pendente efetivo no D1. Não há pagamentos automáticos, previsões fictícias ou notificações externas.

Endpoints de leitura `GET /api/timeline?from=2026-11-01&to=2026-11-30&asOf=2026-11-11` e `GET /api/alerts?asOf=2026-11-11`. Os dois exigem sessão Better Auth e usam paginação/limites. Testes locais: `npm test`, `npm run ui:test`, `npm run ui:build` e `npm run ui:e2e` (com D1 local e Chromium). Relatório: [FINANCIAL-TIMELINE-REVIEW.md](docs/implementation/FINANCIAL-TIMELINE-REVIEW.md), evidência [GitHub Actions #43064714180](https://github.com/carloshgalves/cashControl/actions/runs/43064714180).

## Exportação XLSX/PDF (C3)

Na interface, use **Exportar** ou **Exportar filtro** na trilha. Selecione período, conta (ou todas) e situação, depois **Baixar XLSX** ou **Baixar PDF**. O relatório consulta exclusivamente a sessão Better Auth verificada no servidor; não há link público ou persistência de documentos.

Endpoint: `GET /api/reports/export?format=xlsx|pdf&from=AAAA-MM-DD&to=AAAA-MM-DD&asOf=AAAA-MM-DD&status=all` (filtro `accountId` opcional). Transferências próprias não são receita, pagamentos de obrigações não são duplicados e pendências não representam saída de caixa. Arquivos com mais de 2.000 eventos falham explicitamente (413).

Validação: `npm test`, `npm run ui:test`, `npm run ui:build`, `npm run ui:e2e` com Worker, D1 e Chromium locais. Exportações usam nomes distintos por filtros, cabeçalhos PDF com quebra e limites medidos por fonte, além de rótulos em português. **Última revisão adversarial aprovada nas baterias locais: 129 backend + 16 frontend + Chromium real.** [Relatório C3](docs/implementation/FINANCIAL-EXPORT-C3-REVIEW.md). **PR #40 mesclada em `main`; sem deploy de produção.**

A geração de XLSX/PDF utiliza formatação exata para totais elevados: no Excel, montantes superiores ao limite seguro de precisão numérica são exportados como **texto monetário** para não perder centavos (e não devem ser somados automaticamente). O E2E usa data civil fixa e não depende do mês de execução. Consulte o relatório C3 para as regressões da terceira revisão adversarial.

## Cartões de crédito e parcelas — D1 / SPEC-004 (PR #41 mesclada)

Nova navegação **Cartões**, opcional, com cadastro de apelido, instituição, limite informado e dias de fechamento/vencimento. Compras com valor total em centavos e 1–60 parcelas geram ciclos mensais consultáveis por compra ou por fatura. Crédito não incrementa saldo; compra não cria saída bancária.

**Regra documentada:** compra até o dia efetivo de fechamento entra no ciclo do próprio mês; após o fechamento, entra no seguinte. Fechamento/vencimento em dia inexistente usam o último dia civil do mês. Vencimento posterior ao fechamento efetivo fica no mesmo mês do ciclo; caso contrário, no mês seguinte. Partes dividem centavos exatamente: primeiros índices recebem o resto (R$100,01 em 10x: R$10,01 + 9 × R$10,00).

API autenticada: `GET/POST /api/cards`, `GET /api/cards/{id}`, `GET/POST /api/cards/{id}/purchases`, `GET /api/cards/{id}/purchases/{purchaseId}`, `GET /api/cards/{id}/invoices`, `GET /api/cards/{id}/invoices/{AAAA-MM}`. IDs de outro titular retornam 404. Compra e parcelas são imutáveis e criadas em lote transacional, com chave de idempotência por titular.

**Estado D1:** [PR #41](https://github.com/carloshgalves/cashControl/pull/41) mesclada. Pagamentos de fatura e integração ao dashboard/trilha/exportação estão em revisão na D2; conciliação com o emissor continua para D3 / #21. Consulte [relatório técnico de D1](docs/implementation/CREDIT-CARDS-D1-REVIEW.md). Sem deploy remoto nem dados reais na homologação.

## Pagamentos integrais e parciais de faturas — D2 / SPEC-004 (Issue #20)

**Implementado na branch de revisão `feat/d2-invoice-payments` (não mesclada).**

- Faturas calculadas por cartão e ciclo com **total, pago e restante** derivados dos registros imutáveis. Ao pagar R$ 900,00 de R$ 1.500,00, restam R$ 600,00; o pagamento posterior de R$ 600,00 encerra o ciclo.
- POST autenticado `/api/cards/{cardId}/invoices/{AAAA-MM}/payments` com `idempotencyKey`, `accountId`, `amount`, `method` e `paidOn`; GET na mesma rota consulta o histórico paginado. Apenas contas e faturas do usuário autenticado são aceitas.
- Uma única saída de caixa `posted_cash_movements` é criada no **mesmo batch SQLite/D1** que o vínculo em `card_invoice_payments`. O banco impede overpay concorrente, vínculos duplos e reembolsos genéricos de pagamento de cartão sem regra de reversão. Compras continuam sem saída bancária.
- Dashboard mostra **faturas de cartão pendentes separadas** das obrigações comuns; a trilha, alertas D-10/D-5 e relatórios PDF/XLSX incluem faturas não pagas **uma vez**, sem tratá-las como débito realizado. Pagamentos aparecem uma vez como baixa confirmada. Um aviso de cartão abre seu cartão e ciclo exatos.
- Formulário React apresenta contas de origem, data, método, valor, histórico de pagamentos e alertas de saldo negativo. Não armazena PAN/CVV. O formatador de centavos utiliza `BigInt` para não arredondar totais elevados.

**Testes locais/CI:** `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test` e `npm run d2:e2e` com D1 descartável e Chromium. Há regressões para duas identidades, 900+600, três tentativas idempotentes simultâneas, duas baixas concorrentes, rollback injetado após inserção bancária e avisos de cartão.

**Limites:** D2 registra somente pagamentos já efetivados; não agenda transferências nem gera juros, estornos automáticos, renegociações ou conciliação bancária (D3 / #21). Reembolso de baixa de cartão requer um fluxo específico que preserve/reabra a dívida, portanto foi bloqueado no endpoint genérico. Não há implantação de produção. [Parecer técnico D2](docs/implementation/CREDIT-INVOICE-D2-REVIEW.md).
