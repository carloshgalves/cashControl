# F2 / SPEC-006 — Parecer adversarial de cenários e simulação financeira

**Issue:** [#27](https://github.com/carloshgalves/cashControl/issues/27). **Épico:** #6. **Base:** `main` após PR #48 (F1). **Branch:** `feat/f2-scenario-simulation`. **Gate:** PR Draft, sem merge/deploy ou migração remota.

## Contrato e semântica de risco

DEC-002/003/004 e SPEC-000 exigem distinção entre saldo real, compromisso, reserva virtual e renda não recebida. A F2 é inteiramente **read-only**, apesar de usar POST para receber parâmetros. Nenhum cenário escreve em `posted_cash_movements`, `financial_obligations`, `purchase_intention_events`, `income_expectations`, pagamentos ou outras tabelas; não há migração nova.

- **Saldo inicial:** `financial_account_balances` atual. Uma data selecionada pelo usuário não reconstrói o saldo bancário daquela época. Compras/pagamentos já lançados estão incluídos no saldo e não podem ser lançados novamente como despesas futuras.
- **Compromissos vigentes:** saldo **ainda devido**, segundo `financial_obligation_balances` e `credit_invoice_balances`. Dentro do período, supõe-se pagamento no vencimento (atrasados são alocados no primeiro dia); passivos de datas posteriores não geram pagamento no horizonte, mas continuam reduzindo a margem livre.
- **Reserva virtual:** somente o último estado F1 `reserved`, agregada uma vez desde o começo. Em compra hipotética vinculada, libera a reserva apenas na data de suposta conversão e passa a representar obrigação hipotética **integral**, nunca reserva + obrigação. Uma intenção `converted` já possui obrigação real e não pode ser hipoteticamente convertida de novo.
- **Cenário conservador:** nenhum recebimento futuro incerto entra no caixa. **Cenário planejado:** expectativas E2 explicitamente definidas, filtradas pela data atual/adiada, com `state !== canceled` e `remainingCents > 0`. Mesmo `confirmed` significa expectativa, não crédito bancário. Os valores recebidos e vinculados ficam **somente** no saldo de abertura; não são adicionados novamente. Se um crédito real não foi vinculado à expectativa, a F2 apresenta advertência de possível duplicação, sem supor correspondência financeira.
- **Margem:** `cashModel − outstandingRemaining − otherActiveVirtualReserves − hypotheticalUnpaidLiability`. Pagar uma dívida reduz cashModel e outstandingRemaining simultaneamente, mantendo margem estável. Na data da compra, libera reserva vinculada e cria compromisso. Na data de vencimento, supõe pagamento, reduz cashModel e a obrigação hipotética. O horizonte é inclusivo e limitado a 367 dias.

**Alertas:** saldo de caixa modelado zerado/negativo ou margem livre zerada/negativa representam condição de risco, não bloqueio de decisão. Não foi inventado limiar percentual ou score de risco não autorizado. Datas são civis; o motor não determina ordem intradiária, garantia de depósito nem juros futuros.

## Integridade, privacidade e previsibilidade

- Autorização exclusiva por sessão Better Auth no Worker, inclusive intenção por ID, fontes E2, cartão, obrigações e agregações. 404 para intenção estrangeira sem vazar preço/status. O HTTP exige Origin exato no POST, corpo JSON limitado, chaves allowlist, datas válidas, preço decimal exato; exceções SQL e dados financeiros não são devolvidos em erros ou logs.
- A F2 usa a visão F1 e consultas por titular; valida que totais de obrigações/faturas/reservas individuais conferem com `getPlanningSummary`, rejeitando mudanças concorrentes detectáveis em vez de apresentar margem inconsistente. Cálculos com `BigInt`, guardas `Number.isSafeInteger` e limite de até 2.000 linhas por série. É uma leitura de snapshot financeiro **atual**, não transação bloqueante nem certificação de consistência diante de todas as corridas externas.
- Não há cache persistente de simulação; cada POST recalcula obrigações, faturas, reservas e expectativas. Alterações em rendas e reservas exigem simular novamente. Ao atualizar a fonte interna F1, a tela invalida resultados anteriores e limpa dados ao trocar usuário. A/B demonstrado com login real em navegador.
- Não são coletados dados para score de crédito/LLM/serviços externos. Estatística histórica de renda variável é escopo da F3/#28, não inferida nesta etapa.

## Findings encontrados → corrigidos com regressão

| Finding | Impacto | Remediação |
|---|---|---|
| Validador recebia `unknown` sem narrowing antes de `assertCents` | Build TypeScript | Validar tipo numérico primeiro e executar novamente o typecheck |
| Teste pretendia pagar dentro do horizonte parcela de fatura com vencimento em janeiro | Suposição temporal errada em teste | Caixa só desconta faturas que vencem até dezembro; obrigação de janeiro permanece como passivo na margem |
| Teste comparava nomes aleatórios de exportações PDF/XLSX | Falso negativo em equivalência | Comparar dashboard, timeline, linhas de relatório e tabelas financeiras estáveis, sem exigir nome aleatório igual |
| Fatura consolidada podia ultrapassar o limite de uma compra individual (9e12 centavos) sem violar precisão numérica | Recusa de agregado legítimo | Validador separado para agregados seguros até Number.MAX_SAFE_INTEGER, somas BigInt, regressão de 12e12 centavos numa mesma fatura |
| Entrada bancária já realizada mas não vinculada à expectativa E2 poderia coincidir com renda futura contabilizada no planejado | Risco de projeção otimista/duplicação | Sinalizar contagem de entradas não vinculadas, sem dedução ou correspondência inventada; regressão com vinculação posterior |
| Fatura parcialmente paga poderia aparecer novamente pelo bruto | Risco de pagamento duplicado na projeção | Regra de saldo em aberto e teste com R$ 600 de fatura, R$ 200 já pagos, R$ 400 futuros |
| Margem exatamente zero não recebia alerta | Falso senso de capacidade disponível | Aviso de margem esgotada (zero ou negativa), sem inventar limiar percentual |

## Evidências e limitações

Backend: vazio/sem salário formal, origem freelancer avulsa, expectativa confirmada mas não recebida, parcial já recebida e vinculada, adiamento, cancelamento, competência mensal, obrigação em atraso, várias faturas e vencimentos em dois meses, agregado acima de 9e12, intenção parcial/total, compra livre, conversão real anterior, valor divergente, cliente B, pagamentos reais da dívida/fatura, saldo negativo e zero, ausência de novos registros em movimentações, reservas, obrigações, dashboard, timeline e linhas PDF/XLSX. HTTP: sessão/Origin, JSON extra, datas/centavos, tenant 404 e POST repetido somente de leitura.

Chromium/D1 descartável: duas sessões Better Auth, cartão/contas e intenção cadastrados, simulação com salário incerto, reserva R$ 500 → compra hipotética R$ 500 **sem gravar**, cancelamento de freelance alterando só o planejado, consulta de saldo real, viewport 390px e isolamento entre titulares. Evidências esperadas: `F2_CONSERVATIVE_PLANNED_PASS`, `F2_HYPOTHETICAL_PASS`, `F2_CANCELED_INCOME_PASS` e `F2_TENANT_UI_PASS`.

**Não homologado:** comportamento sob carga/latência Cloudflare de produção, reconciliação de depósitos reais não vinculados automaticamente, ordem intradiária, horizonte superior a 367 dias, cálculo tributário, financiamento/juros automáticos, saldo histórico, estimativa de renda variável potencial e outros cenários não descritos. Uma leitura pode ficar desatualizada após novas movimentações: o usuário deve recalcular a simulação.

**Parecer de escopo:** após as correções e revalidação, não foram identificados findings acionáveis remanescentes nos caminhos verificados. Este parecer não certifica ausência universal de bugs nem substitui revisão humana/aceite visual. Merge permanece manual; Issue #27 aberta até integração em `main`.
