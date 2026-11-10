# SPEC-003 / C1 — Dashboard financeiro (backend e contrato)

**Situação:** backend da [Issue #16](https://github.com/carloshgalves/cashControl/issues/16) implementado, testado e submetido a revisão adversarial. A **UI ainda depende de aprovação visual do responsável**, e não há deploy nem D1 remoto. Branch `feat/dashboard-read-model` baseada na `main` após merge da PR #35.

## Regra de produto

O dashboard deve apresentar separadamente três classes que não são sinônimos:

1. **Saldos efetivos atuais:** valor nas contas/carteiras cadastradas, incluindo abertura, realocações iniciais, movimentos confirmados e transferências internas. Ao mudar o período, **o saldo atual não vira um falso saldo histórico**.
2. **Caixa do período:** entradas efetivamente recebidas, gastos efetivamente pagos e reembolsos efetivamente creditados, determinados pela data civil `occurred_on` (intervalo inclusivo). Transferências próprias não são novas receitas nem despesas; saldo de abertura também não é renda.
3. **Obrigações pendentes atuais:** total e contagem do `outstanding_cents` das obrigações não quitadas/canceladas, com subconjunto de vencimentos cujo `due_on` esteja no período selecionado. Criar obrigação não reduz saldo bancário.

**Expectativas e projeções não existem no domínio P0**: a API devolve `expectations: {status: "not_implemented"}`, não zero, para impedir confusão entre inexistência de informação e previsão de R$ 0. Não inferir receita futura do histórico.

**Reembolsos** são dinheiro recebido, mas não são renda do trabalho. Seu montante é separado (`refundsCents`) da receita ordinária (`incomeCents`). A variação de caixa no período é `incomeCents + refundsCents - expensesCents`. Não corresponde necessariamente à diferença entre saldos atuais e o total do período, pois saldos incluem valores de abertura e eventos de outros períodos.

## Contrato da API

`GET /api/dashboard?from=2026-11-01&to=2026-11-30`

- Exige cookie de sessão Better Auth validado no backend; `owner_user_id` é obtido exclusivamente da sessão, não de query, header ou corpo.
- `from` e `to` são datas civis `AAAA-MM-DD` obrigatórias, inclusivas, calendariamente válidas, e `from <= to`. A escolha padrão do mês é responsabilidade da UI futura; o backend não supõe fuso ou data inicial.
- Filtros ainda não implementados (`accountId`, `category`, `ownerId`, etc.) retornam `400 INVALID_FILTER`: não são ignorados silenciosamente, evitando exibir todos os dados como se fossem filtrados. Chaves duplicadas `from`/`to` são rejeitadas.
- Retorna `{dashboard: {...}}` em `application/json`, `no-store`, com todos os valores em **centavos inteiros**; nenhum dado sensível é lançado em logs.
- Campo `balances.basis = "current"` diferencia saldo atual de `cashFlow.basis = "confirmed_occurrence_in_period"` e `obligations.basis = "current_outstanding"`.

Modelo de resposta (valores ilustrativos):

```json
{
  "dashboard": {
    "currency": "BRL",
    "period": {"from": "2026-11-01", "to": "2026-11-30"},
    "balances": {
      "basis": "current",
      "totalCents": 10000,
      "accounts": [
        {"accountId": "<uuid>", "name": "Banco", "kind": "bank", "currency": "BRL", "balanceCents": 7445},
        {"accountId": "<uuid>", "name": "Espécie", "kind": "cash", "currency": "BRL", "balanceCents": 2555}
      ]
    },
    "cashFlow": {
      "basis": "confirmed_occurrence_in_period",
      "incomeCents": 0, "expensesCents": 0, "refundsCents": 0, "netCents": 0
    },
    "obligations": {
      "basis": "current_outstanding",
      "openCount": 0, "outstandingCents": 0,
      "dueInPeriodCount": 0, "dueInPeriodCents": 0
    },
    "expectations": {"status": "not_implemented"}
  }
}
```

## Implementação e invariantes

- `src/backend/dashboard/dashboard.ts`: uma **única instrução SQL SELECT**, com CTEs para contas, caixa do período e obrigações pendentes; a resposta usa um snapshot de consulta coerente, sem armazenar saldos paralelos sujeitos a drift.
- Consulta filtra por `owner_user_id` em **todas** as CTEs. O mesmo comando devolve contas e totais, inclusive caso o usuário não tenha nenhuma conta (resultado em zero com array vazio).
- Saldos podem ser negativos se gastos reais excederem o saldo registrado. Nenhum valor é arredondado; `Number.isSafeInteger` valida valores e somas. Dinheiro é BRL.
- Período é exclusivamente calendário de movimentos confirmados; compromissos continuam atuais, com vencimentos filtrados dentro do intervalo selecionado. **Não há retrocálculo de saldo em uma data passada**.
- A consulta de `posted_cash_movements` identifica devoluções pelo vínculo persistido em `cash_refunds`. O fluxo líquido ignora transferências porque elas não estão na tabela de entradas/saídas.
- `src/backend/http/accounts-handler.ts` e `src/worker.ts`: endpoint GET protegido pelo mesmo Better Auth do restante do produto; sem CORS aberto, sem cache e sem confiar em qualquer identificador enviado pelo navegador.
- Não houve migração adicional: todos os dados vêm das versões SQL 0001–0006 existentes.

## Ciclo implementação → adversarial review → reparos → re-review

1. **C1-T01 — Fixtures quebradas:** a primeira bateria falhou em cinco testes novos porque certos labels geravam `idempotencyKey` com espaço, e o fixture criava duas carteiras `general` para o mesmo titular, vedadas pelo esquema. Corrigidas as fixtures (chaves sanitizadas; contas bancárias distintas). Nenhuma regra foi afrouxada; regressão de 104 testes verde.
2. **C1-F01 — Filtros silenciosamente ignorados:** a API poderia receber `accountId`/`category`/identidade em query e responder totais **globais**, levando o consumidor a acreditar que estavam filtrados. Corrigido: somente `from` e `to` são aceitos; outros parâmetros recebem 400, com testes HTTP e E2E adversariais.
3. **C1-F02 — Tipagem de `URLSearchParams.keys()`:** a primeira versão da validação F01 não compilava com as definições DOM do projeto. Corrigida usando `URLSearchParams.forEach()`, sem enfraquecer validação de parâmetros, e repetido typecheck + teste completo.
4. **C1-F03 — Verificação de isolamento:** A e B têm contas, movimentos e obrigações diferentes. Testes asseguram que os totais e nomes nunca se misturam, que `ownerId` em query é rejeitado e que sessão anônima não pode consultar dashboard.
5. **C1-F04 — Contabilidade/semântica:** provas de que abertura não se torna renda, transferência não conta como receita, criação de obrigação não reduz saldo, pagamento parcial afeta saída e saldo aberto, reembolso fica separado de renda, estorno de obrigação reabre pendência, cancelamento não cria dinheiro, intervalo passado não altera saldo atual.
6. **C1-F05 — Snapshot e centavos:** teste garante somente uma instrução SQL para todos os indicadores e proteção contra total fora de `Number.MAX_SAFE_INTEGER`.

**Último estado da revisão adversarial:** não foram identificados outros findings acionáveis reproduzíveis dentro do contrato backend e dos testes exercitados. Isso não equivale a aprovação da interface nem do ambiente de produção.

## Evidências de execução

- Primeira bateria: 99/104, com 5 fixtures novas inválidas.
- [Regressão #42917358409](https://github.com/carloshgalves/cashControl/actions/runs/42917358409): **SUCCESS**, 104/104, migrações locais e E2E com dois titulares.
- Revisão identificou C1-F01. [Execução #42917736586](https://github.com/carloshgalves/cashControl/actions/runs/42917736586): correção do contrato encontrou C1-F02 no TypeScript, corrigida.
- **[Execução final #42917895750](https://github.com/carloshgalves/cashControl/actions/runs/42917895750): SUCCESS.** `npm ci`, `npm run typecheck`, `node --check scripts/e2e-auth.mjs`, `npm test`: **104 PASS, 0 FAIL**; migrações 0001–0006 aplicadas no D1 local; `DASHBOARD_E2E_PASS` confirma conciliação independente de saldos, fluxos, reembolsos e obrigações e isolamento de dois usuários reais.
- Nenhum deploy, D1 remoto ou medição de CPU do Workers Free foi executado, conforme decisão de adiar a infraestrutura até o produto estar pronto.

## Gate de UI e próximo passo

**A Issue #16 é vertical, incluindo interface:** esta entrega atende **o backend dos quatro critérios**, mas **não conclui a Issue** até o design de dashboard ser aprovado, a interface implementada e seus testes de acessibilidade/jornada serem executados.

Sugestão para aprovação de produto, a apresentar aqui na conversa antes de codificar frontend:

- Dashboard desktop com cartões distintos: `Saldo disponível agora`, `Recebimentos do período`, `Pagamentos do período`, `Devoluções` e `Obrigações em aberto`.
- Seção `Contas e carteiras`, cada saldo independente, e `Vencimentos neste período` com rótulos `pendente` sem sugerir que foram pagos.
- Controle de datas com período explícito e legenda fixa: saldos/pendências atuais; fluxos no período selecionado.
- Estado vazio para quem ainda não cadastrou contas (deve oferecer início com carteira geral/zero, sem exigir banco).
- Mobile prioriza saldo atual, fluxo do período e vencimentos, com cartões empilhados e menu simples.

Não criar componentes React, estilos, telas, wireframes versionados como código ou testes de UI antes da aprovação visual do responsável. O backend/PR permanece Draft para revisão e merge manual.
