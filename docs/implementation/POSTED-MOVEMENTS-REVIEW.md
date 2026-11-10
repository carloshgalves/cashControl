# Entrega B2 — recebimentos e despesas efetivas (Issue #12)

**Estado:** backend implementado e validado em D1 **local** via Workerd; sem frontend, deploy ou merge. **PR empilhada** sobre a branch da PR #31.

## Comportamento entregável

- Criar recebimento confirmado (`income`) ou despesa efetivamente paga (`expense`) associado à conta/carteira do titular autenticado.
- Dinheiro representado em centavos inteiros; o corpo HTTP contém valor decimal como string (`"27.25"`, não JSON number).
- Movimentações com descrição, dia civil `AAAA-MM-DD`, método (`cash`, `pix`, `debit`, `bank_transfer`), origem livre opcional e categoria opcional.
- Consultar histórico por titular (`GET /api/movements`), por ID (`GET /api/movements/:id`) e por conta (`?accountId=`), com paginação (`limit` 1–100, `offset` até 1.000.000).
- Cálculo único dos saldos por visão SQLite: saldos de abertura + realocações iniciais + recebimentos efetivos − pagamentos efetivos.
- POST idempotente por `(owner_user_id, creation_key)`, inclusive requisições simultâneas; mesma chave com payload diferente retorna conflito.
- FK composta `(owner_user_id, account_id)` impede atribuir movimentação a conta de outro usuário, mesmo se UUID for conhecido.
- API utiliza **a mesma sessão do Better Auth** que já protege contas e carteiras; nunca aceita `ownerId` do cliente como identidade.
- Valores reais podem revelar saldo negativo se o usuário registrar pagamento já feito maior que o saldo anotado; a aplicação **não inventa automaticamente um empréstimo** nem impede registrar um fato passado.

## Contrato HTTP mínimo

Requer cookie de sessão válida do titular, `Origin` igual à origem canônica em POST, e `Content-Type: application/json` no cliente. Exemplo de POST `/api/movements`:

```json
{
  "idempotencyKey": "transaction-20261110-001",
  "accountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "direction": "income",
  "amount": "37.51",
  "method": "pix",
  "description": "Serviço realizado",
  "occurredOn": "2026-11-10",
  "sourceLabel": "Trabalho eventual",
  "category": "Serviços"
}
```

Resposta: objeto `movement` com ID gerado no servidor, `amountCents`, data civil, criação e demais atributos. IDs e datas no exemplo são fictícios.

**Importante:** `bank_transfer` significa pagamento **externo** como método de uma entrada/saída. Transferências **entre contas próprias** são outra operação de negócio (Issue #14); não devem ser registradas como receita/despesa.

## Fora deste incremento

- Crédito, compra parcelada, fatura, obrigações ainda não pagas, eventos previstos, salário recorrente, câmbio, devolução/estorno e transferências internas.
- Edição/exclusão de eventos históricos; tratamentos compensatórios serão modelados nos tickets correspondentes.
- Telas de frontend: apresentar o design para aprovação antes de implementar.
- Conexão remota à Cloudflare, deploy, custo de CPU e produção: intencionalmente adiados.

## Evidência e revisão adversarial

**CI real:** [GitHub Actions run #42837838351](https://github.com/carloshgalves/cashControl/actions/runs/42837838351) — SUCCESS.

- `npm ci`: dependências travadas instaladas.
- `npm run typecheck`: passou, incluindo Hono, Better Auth e todos os serviços.
- `npm test`: **35 PASS, 0 FAIL** no runner. Bateria local de desenvolvimento mais ampla: **36 PASS, 0 FAIL**, TypeScript core OK.
- Migrações `0001`, `0002`, `0003`: aplicadas a D1 local via Wrangler.
- `FINANCE_E2E_PASS`: dois logins reais, conta de Alice, POST de renda e despesa, saldo reconciliado, retry sem duplicidade, Bob sem leitura/escrita na conta de Alice, origem cruzada negada, logout revoga cookie.
- O workflow **não faz deploy**. Não representa performance real da cota de CPU da Cloudflare hospedada.

### Findings encontrados / remediados

1. **T-01 — Fixture inválida:** teste de calendário usava uma chave com caracteres incompatíveis com a validação de idempotência; o teste falhava pelo motivo errado. Corrigimos a chave do próprio teste antes de executá-lo novamente.
2. **F-01 — Saldo de conta obsoleto após POST:** a implementação anterior calculava saldo apenas por abertura/realocação. Criada visão unificada `financial_account_balances` e adaptada a verificação de disponibilidade da realocação, para considerar pagamentos já feitos.
3. **F-02 — Escapamento incorreto no código transferido ao GitHub:** expressões regulares na nova rota HTTP estavam escapadas duas vezes. Corrigidas antes da suíte de integração; TypeScript e Workerd/E2E reais passaram.
4. **F-03 — Referência a conta de terceiro:** não basta filtro por usuário na consulta. FK composta por proprietário protege também o lançamento; testes incluem UUID de outro usuário e isolamento por sessão.
5. **F-04 — Retry financeiro e falha concorrente:** verificação de replay antes e depois da tentativa atômica de INSERT e UNIQUE por usuário/chave. Testes locais incluem requisições simultâneas e payload divergente.

### Re-review

Não restaram findings reprodutíveis acionáveis no escopo validado após as correções acima. A ausência de findings neste recorte **não é** uma homologação de produção ou garantia de ausência de bugs futuros.

## Dependências e gates

- Branch base: `feat/backend-account-domain-initial` (PR #31, ainda Draft, não mesclada).
- Issue #11 (onboarding/contas) e #12 (este incremento) continuam abertos até seus critérios de UI serem aprovados e construídos.
- Esta PR deve ser integrada após #31 e revisão humana; manter o sistema sem interfaces até aprovação das telas.
- Não criar pipeline recorrente de alto custo; o workflow criado roda ao adicionar seu YAML ou por disparo manual.
