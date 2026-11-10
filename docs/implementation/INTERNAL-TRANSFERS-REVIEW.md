# SPEC-002/B4 — Transferências internas entre contas próprias

**Estado:** backend implementado na branch `feat/internal-transfers`, baseado na `main` após o merge da PR #33. **Sem frontend, sem deploy e sem banco remoto.** Issue [#14](https://github.com/carloshgalves/cashControl/issues/14).

## Semântica financeira

Uma transferência interna não é uma receita nem uma despesa: ela apenas desloca dinheiro registrado de um recurso próprio para outro, preservando o total do titular.

Exemplo: conta A com R$ 100,00, conta B com R$ 0,00. Transferir R$ 25,55 resulta em A = R$ 74,45 e B = R$ 25,55, com total consolidado ainda R$ 100,00. O histórico de `posted_cash_movements` permanece inalterado.

As transferências de saldo inicial da DEC-001 (`initial_allocations`) são distintas: representam a abertura de uma conta mediante **reclassificação de saldo previamente informado**. As transferências implementadas aqui são operações financeiras confirmadas entre contas já cadastradas.

## Contrato

- `POST /api/transfers`: cria transferência confirmada, com chave idempotente, contas origem/destino, valor decimal em string, data civil `AAAA-MM-DD` e nota opcional.
- `GET /api/transfers`: histórico do titular, paginado (limite 1–100, offset até 1.000.000); `?accountId=` filtra transferências de entrada **ou** saída da conta.
- `GET /api/transfers/:id`: detalhe próprio, ou 404 para inexistente/pertencente a outro titular.
- Reutiliza middleware/handler com sessão Better Auth validada no backend, origem canônica obrigatória em POST, corpo limitado a 4096 bytes e respostas `no-store`. Campos de identidade remetidos pelo navegador (como `ownerId`) são ignorados.

Exemplo de POST:

```json
{
  "idempotencyKey": "internal-20261110-001",
  "sourceAccountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "targetAccountId": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
  "amount": "25.55",
  "transferredOn": "2026-11-10",
  "note": "Separar dinheiro em espécie"
}
```

Os IDs são placeholders. O servidor valida que ambos os recursos existem e pertencem ao usuário da sessão, que são distintos e que o dinheiro efetivamente registrado na origem é suficiente para o valor solicitado.

## Modelagem, concorrência e auditabilidade

- Migração [`0005_internal_transfers.sql`](../../migrations/0005_internal_transfers.sql): cada transferência é **um único registro**, não duas movimentações independentes que possam ser gravadas parcialmente. FKs compostas vinculam origem e destino ao mesmo proprietário, e CHECK impede a origem ser igual ao destino.
- A visão consolidada `financial_account_balances` é redefinida para calcular saldo de abertura + realocações iniciais + receitas/despesas reais + transferências internas de entrada − transferências internas de saída, tudo em centavos inteiros.
- Um trigger de banco verifica saldo registrado disponível **no momento do INSERT**. SQLite serializa writers; duas transferências concorrentes não conseguem ambas gastar a mesma disponibilidade. A mesma verificação é respeitada por realocações iniciais futuras, que já consultam a visão canônica de saldo.
- A operação aborta se origem/destino não existem, destino é de outro titular, valor é zero ou superior ao saldo, ou as contas são idênticas. O banco não grava efeito parcial.
- `UNIQUE(owner_user_id, creation_key)` + replay antes e depois do INSERT tornam a operação idempotente inclusive diante de retries concorrentes. Reutilizar a chave com outro valor, data, origem, destino ou nota retorna conflito.
- Triggers de imutabilidade impedem alteração/exclusão silenciosa de transferências passadas. Correções exigirão um evento compensatório explícito, sem reescrita histórica.

## Revisão adversarial e regressões

A implementação foi revisada para:

1. **Atomicidade:** tentativa de transferir para conta inexistente não debita a origem; uma linha de transferência representa as duas pontas.
2. **Tenant isolation:** sessão de outro usuário não pode ver nem registrar transferência usando UUID de conta estrangeira. FKs no banco são defesa adicional ao escopo na API.
3. **Dupla contabilização:** resultado receitas − despesas e número de movimentações de caixa não mudam por transferências próprias. Total consolidado também permanece igual.
4. **Concorrência:** duas requisições distintas tentando retirar R$ 75,00 de R$ 100,00 disponíveis: exatamente uma é confirmada, a outra recusada; source e destination permanecem consistentes.
5. **Retries:** mesmo idempotencyKey, inclusive simultaneamente, produz uma única transferência; dados divergentes com a mesma chave são recusados.
6. **Compatibilidade:** pagamentos de obrigações e despesas já registradas reduzem disponibilidade para futuras transferências; uma realocação de saldo inicial não pode consumir dinheiro já transferido.
7. **Validação:** centavos, zero, datas impossíveis/anos bissextos, paginação, mesmo ID nas duas pontas, campos indevidos e texto com conteúdo de SQL malicioso são tratados como dados ou rejeitados.

**Achados e remediações:** as guardas de saldo, FKs compostas, imutabilidade, idempotência e testes de ataque foram adicionados antes do primeiro teste real de integração. Durante a revisão do teste de transferências de ida/volta, um **valor esperado da própria fixture** foi corrigido antes da execução do CI, sem alterar a regra de produto. A revisão após a execução não encontrou finding acionável reproduzível neste escopo; isso não equivale à garantia de inexistência de bugs.

## Evidências

- [GitHub Actions #42852017287](https://github.com/carloshgalves/cashControl/actions/runs/42852017287): **SUCCESS**.
- `npm ci` com lockfile, `npm run typecheck` completo e `npm test`: **71 PASS, 0 FAIL**.
- Migrações 0001–0005 aplicadas por Wrangler ao D1 local; `0005_internal_transfers.sql` aplicada com sucesso.
- `TRANSFERS_E2E_PASS`: cadastro de duas contas, transferência, saldo origem/destino, idempotência, nenhuma receita/despesa artificial, sessão isolada e CSRF.
- `TRANSFERS_RACE_PASS`: duas transferências de R$ 50,00 concorrentes contra saldo restante de R$ 64,40; somente uma aceita, sem débito/crédito parcial.
- `OBLIGATIONS_RACE_PASS`, `OBLIGATIONS_E2E_PASS` e `FINANCE_E2E_PASS`: regressões dos módulos anteriores aprovadas no mesmo Workerd local.
- O workflow tem permissão de **leitura somente**, não faz deploy e não utiliza D1 remoto nem credenciais reais de usuário. A medição de CPU da Cloudflare hospedada continua adiada por decisão do responsável.

## Limites e próximo gate

- Não há interface visual. **Qualquer implementação de frontend precisa ser apresentada ao responsável do produto para aprovação antes de codificar.**
- Não integra APIs Pix, instituições bancárias ou transferências entre usuários; trata-se de registro financeiro, não execução bancária.
- Não cria juros, encargos, obrigação a pagar ou classificação de receita/despesa econômica.
- Não altera a política do sistema para permitir saldo negativo por transferência: somente fundos efetivamente registrados disponíveis podem ser movidos. Gasto já pago pode deixar saldo negativo quando registrado como despesa na Issue #12.
- Sem edição ou exclusão: ajustes posteriores deverão utilizar operações compensatórias auditáveis, assunto da Issue #15.
- A entrega está pronta para revisão e merge do backend. A Issue #14 pode permanecer aberta até uma eventual jornada visual aprovada.
