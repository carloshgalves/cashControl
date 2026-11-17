# SPEC-004 / D3 — Conferência manual de faturas: implementação e revisão adversarial

**Parent:** #4 · **Issue:** [#21](https://github.com/carloshgalves/cashControl/issues/21) · **Base:** merge da PR #42 em `main` · **Branch:** `feat/d3-manual-invoice-reconciliation` · **Gate:** PR Draft, sem merge/deploy.

## Contrato e decisão de negócio

DEC-011 aprovou a **conciliação opcional** do valor fornecido manualmente pelo usuário frente ao calculado das compras/parcelas, sem atualização automática ou presunção de integração bancária. O sistema não deve inferir juros, compra ausente, estorno, tarifa ou motivo de diferença apenas pelo montante total.

O valor de comparação é o **total bruto do ciclo**: `SUM(credit_installments.amount_cents)`, antes dos pagamentos. O saldo pendente derivado dos pagamentos D2 é **outro indicador** e não se altera com a observação manual. Por exemplo, fatura bruta R$ 1.500 e pagamento de R$ 500 → a comparação continua usando R$ 1.500; a dívida líquida é R$ 1.000.

| Situação | API | Interface | Efeito financeiro |
|---|---|---|---|
| Usuário não forneceu valor | `unreported` | Ainda não informada | Nenhum |
| Valor informado igual ao total atual | `matched` | Valores coincidem | Nenhum |
| Valor diferente do total atual | `pending_divergence` | Divergência pendente | Nenhum |

**`matched` não constitui confirmação do banco.** O campo `source: manual` identifica claramente a origem informada pelo usuário.

## Persistência e isolamento

- Migração `0009_invoice_bank_reconciliation.sql`: `card_invoice_bank_observations` em regime **append-only**, chave de idempotência e ID únicos **por titular**, FK titular/cartão, índice de histórico por cartão/ciclo/sequence. Triggers recusam UPDATE/DELETE, ciclo inexistente, titular alheio e snapshot de total calculado fraudado.
- `reconciliation.ts`: consulta do ciclo autorizada pelo titular (mesmo contrato de D1/D2), validação decimal estrita, `latest` por sequência monotônica, histórico paginado e diferença exata com sinal. A observação armazena também o total calculado na época, para auditoria; comparação atual é recalculada no GET. Retry do mesmo payload não cria outro registro; chave reutilizada com valor diferente retorna conflito.
- O total agregado da fatura pode exceder o teto de **um único lançamento**. D3 suporta até `Number.MAX_SAFE_INTEGER` centavos na **comparação**, usando `BigInt` para interpretar o decimal, sem alterar os limites dos pagamentos e compras ordinárias.
- HTTP: `GET/POST /api/cards/:cardId/invoices/:cycle/reconciliation`, sessão Better Auth vigente, verificação de origin em POST, body JSON limitado, parâmetros GET allowlist, status 400/401/403/404/409/413 conforme causa. Não armazena número integral de cartão, CVV, dados de login, comprovantes ou extratos.
- A inserção não escreve em `posted_cash_movements`, `credit_installments`, `card_invoice_payments`, `financial_obligations` nem altera os agregados do dashboard, da trilha ou XLSX/PDF.

## Interface

- `InvoiceReconciliationPanel.tsx` na fatura do cartão, com comparação em três colunas, status explícito, sinal da diferença, orientação para revisar parcelas e opção de registrar novo total **manual**.
- Histórico imutável acessível por região nomeada com paginação progressiva; ao registrar nova observação, a antiga permanece consultável.
- Em caso de POST efetivado e falha subsequente no GET, o formulário mantém a **mesma chave de idempotência**, para retry sem duplicação.

## Ciclo adversarial e regressões

| Achado da revisão | Correção | Verificação |
|---|---|---|
| Histórico em div sem semântica de região acessível | Uso de `section aria-label` | Chromium com `getByRole('region')` |
| POST podia ter sido confirmado e GET de refresh falhar; a UI trocava a chave prematuramente | Chave renovada somente após GET de sucesso | Interceptação de rede no navegador; retry sem observação adicional |
| Replay antigo podia indicar estado obsoleto apesar de observação posterior | Read model sempre consulta observação atual | Teste de replay após nova observação |
| Limite de 9e12 centavos por compra também limitava indevidamente soma de fatura | Teto separado de comparação, até `MAX_SAFE_INTEGER`, parsing exato | Duas compras individuais válidas de 9e12 centavos no mesmo ciclo |
| Erro de `noUncheckedIndexedAccess` no novo parsing decimal | Desestruturação com fallback seguro | TypeScript `--noEmit` |
| Total informado poderia parecer saldo restante após pagamento parcial | Diferenciação explícita total bruto vs saldo devido | Teste com pagamento parcial D2 e comparação inalterada |
| Usuário B poderia tentar consultar/informar fatura de A | Autorização por titular e FK composta com restrição SQL | Teste HTTP 404, SQL cross-owner, Chromium A/B |

**Suíte:** testes determinísticos `tests/reconciliation.test.mjs` e `web/tests/finance.test.mjs`, mais regressões históricas de D1/D2; `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`. Workflow `d3-manual-reconciliation-local.yml` aplica migrações 0001–0009 em D1 **descartável** e executa Chromium/Better Auth reais com duas identidades, total divergente, revisão, histórico, isolamento, mobile e falha de refresh injetada após POST confirmado.

## Limites e release gate

Sem conta bancária automatizada, documento do emissor anexado, apuração automática de compra faltante, alteração de lançamentos ou juros inventados. Não há "resolver diferença" sem evidência: diferença não nula fica `pending_divergence` até um novo valor manual passar a coincidir com o total calculado. Há limite de 2.000 parcelas no detalhe D1 e paginação no histórico D3. Testes de desenvolvimento local não homologam Cloudflare em produção, acessibilidade integral, carga, backup ou aceite visual humano.

**Gate para merge:** CI aprovado no último commit, revisão final do diff, inspeção visual humana e merge manual; a Issue #21 permanece aberta até integração em `main`. Nenhuma migração remota, deploy, alteração em dados reais ou marcação de PR como aprovada foi realizada.

**Parecer atual:** os findings de código identificados na revisão foram corrigidos e protegidos por testes. Não se afirma ausência universal de defeitos; avaliações adicionais em produção permanecem fora de escopo.
