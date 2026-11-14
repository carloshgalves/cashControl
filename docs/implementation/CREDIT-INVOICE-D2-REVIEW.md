# D2 / SPEC-004 — Revisão independente de pagamentos de fatura

**Issue:** [#20](https://github.com/carloshgalves/cashControl/issues/20) · **Base:** `main` após merge da PR #41 · **Branch:** `feat/d2-invoice-payments` · **Situação:** entrega vertical em revisão, sem merge ou deploy remoto.

## Contrato financeiro

Compra a crédito registra dívida e parcelas (D1), mas **não** movimenta saldo efetivo. D2 registra somente **pagamento efetivado** de fatura a partir de conta própria, com data civil e meio informados, como uma saída de caixa. O pagamento reduz o saldo devedor da fatura e o saldo bancário uma só vez. O valor devido é derivado da soma das parcelas de um ciclo menos os pagamentos efetivamente persistidos; não existe saldo editável em memória.

Exemplo de aceitação: compra de R$ 1.500,00; baixa parcial R$ 900,00 → pago R$ 900,00 e restante R$ 600,00; quitação R$ 600,00 → pago R$ 1.500,00 e restante zero. Duas baixas somam R$ 1.500,00 no fluxo confirmado, sem gerar outra saída pela compra.

## Implementação vertical e evidências

- `migrations/0008_card_invoice_payments.sql`: pagamentos imutáveis, chaves compostas por titular, FKs da conta, cartão e lançamento, unicidade por idempotência e `movement_id`, visão de saldos derivada sem multiplicação por junção. Triggers exigem movimento correspondente do próprio titular, mesmo valor, conta, método, dia e chave; recusam overpayment e uso do mesmo débito para outra obrigação ou reembolso genérico.
- `src/backend/cards/invoice-payments.ts`: validação de principal, origem e data, consulta de replay antes de nova tentativa, cálculo do restante, registro atômico via `db.batch`, retorno tipado 409 para excesso e recusa de outros titulares.
- `src/backend/http/accounts-handler.ts` e `src/worker.ts`: POST/GET `/api/cards/:cardId/invoices/:cycle/payments` apenas com sessão Better Auth válida, Origin de POST estrito, body e parâmetros permitidos limitados, 404 sem revelar existência de outro titular; sem CORS aberto.
- `web/src/InvoicePaymentPanel.tsx`, `CardScreen.tsx`, `App.tsx`: pagamento integral/parcial, histórico, saldo restante, escolha de conta, aviso de saldo negativo, idempotência preservada em retransmissão e renovada quando o formulário muda.
- Dashboard separa cartões de obrigações comuns em agregados consistentes por uma consulta. Trilha cronológica e exportações contam a pendência por ciclo uma vez, tratam pagamento como uma saída confirmada (não outra compra), e eliminam aviso após quitação.
- Alertas em `GET /api/alerts` somam contas comuns e faturas de cartão no próprio SQL, preservando tipo e alvo. Aviso de cartão traz `cardId` e `cycle` explícitos e leva ao detalhe autorizado do ciclo; alertas comuns preservam `obligationId` real.

## Revisões adversariais (implementação → revisão → correção → revalidação)

| Código | Achado | Remediação | Controle regressivo |
|---|---|---|---|
| D2-R1 | Pagamento de fatura poderia reaproveitar débito também vinculado a obrigação/reembolso | Triggers nos dois sentidos e vínculo por `creation_key` | Tentativas adversariais SQL |
| D2-R2 | Repetição/concorrência e falha entre lançamentos | Batch atômico, replay por titular e chave; trigger SQL de saldo vivo | Três retries simultâneos; duas chaves concorrentes; rollback injetado |
| D2-R3 | Visões externas não representavam faturas e podiam ocultar pendências | Indicador separado de cartão no dashboard; evento único por ciclo na trilha/relatório | Duas compras + obrigação comum + 900/600 + A/B |
| D2-R4 | Leitura de filtro dos alertas SQL passou argumentos extras na união | Corrigida quantidade de parâmetros vinculados | Testes D-10/D-5 e contratos legados |
| D2-R5 | Aviso de cartão apontava para mecanismo de obrigações comuns | IDs explícitos e navegação por cartão/ciclo com sessão vigente | Chromium real D-10 e isolamento A/B |
| D2-R6 | Callback e foco anteriores podiam refazer consultas ou sobreviver à troca de sessão | Callback estável, alvo consumível, limpeza no logout/login | Chromium e verificação de seleção |
| D2-R7 | UI formatava montantes agregados com divisão em ponto flutuante | Formatação exata com `BigInt` | Centavos acima de R$ 90 trilhões |
| D2-R8 | Segundo E2E atingia limite de cadastro de Better Auth no mesmo IP | Workflow com jornada D2 isolada e D1 verificada por testes determinísticos | Worker/D1 descartáveis, A/B em Chromium |

**Comprovação:** a suíte Node usa SQLite real em memória com PRAGMA `foreign_keys=ON` e migrações 0001–0008. O CI usa Wrangler D1 **local** descartável, Better Auth real (Alice/Bob), Chromium em desktop e viewport mobile. Gates: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test` e `npm run d2:e2e`. O log precisa apresentar `D2_ALERT_UI_PASS`, `D2_CASH_UI_PASS` e `D2_TENANT_UI_PASS`.

## Limites conhecidos e gate humano

D3 (#21) permanece responsável pela conciliação opcional com informação externa do emissor; não se simulam conexão bancária, juros, chargeback, recálculo retroativo ou antecipação. Como reembolso genérico não reabre dívidas de cartão, reverter pagamentos de fatura via `cash_refunds` está deliberadamente bloqueado até contrato específico. O detalhe de parcelas D1 tem limite seguro de 2.000 linhas e não deve ser anunciado como exportação sem limites.

Nenhuma evidência local prova operação em produção, backup externo, carga em Cloudflare Free ou inspeção visual humana definitiva. **Release gate:** CI no último commit, revisão visual, aceite humano e merge manual; Issue #20 só pode ser fechada após integração confirmada em `main`. Nenhuma migração remota ou deploy foi acionado.

**Parecer:** nenhum finding de correção de código identificado como pendente no escopo testado após a última bateria verde. A revisão é fundamentada nas garantias e cenários citados, não é prova de ausência universal de defeitos.
