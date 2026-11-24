# G1 / SPEC-007 — empréstimos pessoais concedidos e principal a receber
**Issue:** #29. **Parent:** #7. **Base:** `main` após F2 e reconciliação administrativa. **Gate:** PR Draft; sem merge/deploy antes de CI e aceite de interface.

## Escopo implementado
- Registro de empréstimo concedido a terceiro com titular da sessão, pessoa devedora informada, valor principal, data de concessão, vencimento, conta de origem e chave idempotente.
- Saída de caixa única na data de concessão, como **movimento patrimonial autônomo**, não despesa de consumo; o valor a receber aparece separadamente do saldo bancário, nunca como renda creditada.
- Recebimento parcial ou total de devolução de principal vinculado ao empréstimo, conta receptora e data efetiva. Reduz saldo a receber e repõe caixa sem classificar principal como salário/renda.
- Registros append-only, visão derivada de saldo remanescente, juros não calculados, sem cobrança automática nem emissão jurídica.
- Trilha financeira e relatórios têm categorias próprias para `loan_disbursement`, `loan_repayment`, `loan_receivable`, preservando receita/despesa/neto do dashboard. F2 obtém saldo real atualizado da visão canônica, sem novo crédito presumido.
- API privada: `GET/POST /api/loans`, `GET /api/loans/:loanId`, `GET/POST /api/loans/:loanId/repayments`. Better Auth, proteção CSRF por Origin e isolamento por titular.

## Verificações e revisão adversarial (em andamento)
1. **Saldo e classificação:** concessão R$500 e retorno R$250+R$250; caixa volta ao original e renda/despesa efetivas permanecem zero.
2. **Concorrência:** replay com mesma chave não duplica principal ou baixa, chave divergente retorna conflito, sobrepagamento bloqueado na transação pelo SQLite.
3. **Integridade:** FKs compostas, imutabilidade e saldos em centavos; conta de terceiro não aceita, dívida de terceiro responde 404.
4. **Histórico:** vencimento em atraso aparece como recebível separado, quitação elimina linha pendente; exportação XLSX/PDF não registra empréstimo como renda ou gasto.
5. **Compatibilidade:** esquemas de teste anteriores passam a carregar a migração 0015 para testar a linha do tempo atual, em vez de uma estrutura desatualizada.

## Limitações e gates
A infraestrutura e os testes são locais (D1 descartável). Não houve homologação remota, integração bancária, cálculo de juros ou uso de dados reais. A alteração da interface específica de cadastro de empréstimos/baixas deverá seguir o gate da ADR-0001: **apresentar proposta visual e receber aprovação explícita do responsável antes da implementação de um novo módulo visual**. A linha do tempo atual recebe categorias próprias, mas um painel G1 dedicado ainda não foi aprovado.

**Ciclo de revisão:** inspecionar logs reais de CI (testes, typecheck e navegador), corrigir qualquer finding reprodutível e repetir. Se a validação ficar pendente, manter a PR Draft e a Issue #29 aberta; não declarar integração concluída.

## Evidência de execução CI local — 24/11/2026 UTC

- [GitHub Actions #45310122880](https://github.com/carloshgalves/cashControl/actions/runs/45310122880): **SUCCESS** no commit `9efff4ea`. 266 testes backend aprovados; 18 frontend aprovados; typecheck/build e D1 local com migrações 0001–0015.
- Chromium/Better Auth real: `G1_GRANT_AND_OVERDUE_PASS`, `G1_RETURN_PRINCIPAL_PASS`, `G1_AUTH_ISOLATION_PASS`, em desktop/mobile 390px e duas sessões A/B.
- Finding G1-INT01: D1 hospedado pelo Workerd local impôs teto para a quantidade de termos em `UNION ALL`. A consulta foi corrigida com CTEs separadas (`loan_events`, `account_events`, `all_events`) sem alterar classificação financeira, filtros ou paginação. Regressão real voltou a passar no Chromium.
- Diagnóstico transitório e impressão de erros do Worker foram **removidos** após identificação/correção, preservando a restrição de não expor dados em logs.
- **Gate ainda aberto:** aceite visual do painel G1; validar novamente CI no HEAD desta atualização antes do merge. Sem deploy remoto.
