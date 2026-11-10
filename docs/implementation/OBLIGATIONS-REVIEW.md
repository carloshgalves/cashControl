# SPEC-002/B3 — Contas a pagar e pagamentos parciais

**Situação:** implementação de backend e revisão adversarial na branch `feat/obligations-partial-payments`; nenhuma tela, deploy ou conexão remota Cloudflare. Issue [#13](https://github.com/carloshgalves/cashControl/issues/13).

## Contrato funcional

- Uma obrigação financeira é um **compromisso não pago**, com título, categoria opcional, valor total positivo em centavos e vencimento civil (`YYYY-MM-DD`).
- Criar obrigação **não movimenta saldo real** nem cria despesa paga no histórico. Estado inicial: `open`.
- Cada pagamento confirmado associa obrigação e conta/carteira **do mesmo usuário**. Um pagamento gera exatamente uma movimentação de saída na tabela de caixa e um registro de quitação vinculado, num único `D1.batch()` atômico.
- O estado é derivado do histórico: `open` (nada pago), `partially_paid` (resta saldo), `paid` (nenhum saldo). O saldo aberto jamais fica negativo.
- Valor acima do devido, valor zero, conta inexistente/de outro titular e obrigação inexistente/de outro titular são rejeitados. Uma falha no segundo `INSERT` reverte o lançamento de caixa correspondente.
- Repetição com a mesma chave de idempotência e parâmetros mantém o mesmo pagamento, sem desconto duplicado; a mesma chave com dados divergentes é conflito.
- O limite de um compromisso é o `total_cents` original. Renegociação, juros, parcelamento de fatura e alterações do valor total ficarão para as respectivas Issues posteriores.
- É possível registrar um pagamento real que deixe a conta com saldo registrado negativo. O aplicativo não inventa nova dívida ou entrada para encobrir um fato registrado; a interface futura poderá advertir.

## Contratos HTTP (session cookie Better Auth, sem token DIY)

| Operação | Método e recurso | Resultado |
|---|---|---|
| Cadastrar obrigação | `POST /api/obligations` | 201; objeto `obligation` |
| Listar obrigações | `GET /api/obligations?limit=50&offset=0` | 200; `obligations[]` |
| Detalhar saldo aberto | `GET /api/obligations/:id` | 200 ou 404 |
| Registrar pagamento | `POST /api/obligations/:id/payments` | 201; objeto `payment` |
| Histórico de pagamentos | `GET /api/obligations/:id/payments` | 200; `payments[]`, ou 404 se não pertencer ao titular |

Exemplo de criação de obrigação (valores monetários no HTTP são strings decimais, não números de ponto flutuante):

```json
{
  "idempotencyKey": "bill-20261125-internet",
  "title": "Internet",
  "amount": "75.00",
  "dueOn": "2026-11-25",
  "category": "Internet"
}
```

Exemplo de pagamento parcial:

```json
{
  "idempotencyKey": "bill-payment-20261110-01",
  "accountId": "<UUID da conta do titular>",
  "amount": "25.50",
  "method": "pix",
  "paidOn": "2026-11-10"
}
```

A origem HTTP precisa corresponder à origem canônica nas mutações, e a identidade do titular vem exclusivamente da sessão verificada. Campos `ownerId` no corpo ou cabeçalhos `x-user-id` não conferem autorização. Requisições e respostas usam `no-store` e erros genéricos, evitando vazamento de SQL/identidade.

## Invariantes e garantias de persistência

- `financial_obligations`: obrigação original imutável nesta entrega; chave de idempotência exclusiva por titular.
- `financial_obligation_payments`: pagamento vinculado via FKs compostas ao compromisso e à movimentação de caixa, sem vincular dados de titulares diferentes.
- `financial_obligation_balances`: estado e total quitado calculados a partir das linhas efetivamente pagas; sem campo `status` manual que possa divergir.
- `obligation_payment_invariants` (trigger SQLite): proíbe pagamento referenciar receita ou movimentação de valor divergente e proíbe pagamento acima do saldo aberto, mesmo que futuro código escreva diretamente na tabela.
- O serviço usa `D1.batch()` para criar despesa de caixa e quitação de forma atômica. Uma subconsulta condiciona o segundo `INSERT` à disponibilidade do saldo aberto; uma obrigação inválida provoca erro `NOT NULL` e o primeiro lançamento é revertido.
- Os métodos de pagamento representam **quitação financeira**, não geração de uma segunda despesa econômica. A obrigação criada não é lançada previamente como saída de caixa.
- A mesma obrigação pode ser paga em múltiplas parcelas, inclusive por contas ou meios diferentes, e cada pagamento preserva referência à despesa de caixa correspondente.

## Validação e revisão adversarial

### Findings acionáveis detectados e corrigidos

1. **B3-F1 — Validação de mês (alta):** comparação de `getUTCMonth()` (zero-based) com mês civil (um-based) rejeitava datas válidas. Corrigida com `getUTCMonth() + 1`; regressão de datas civis/leap year obrigatória.
2. **B3-F2 — Integridade do elo entre quitação e caixa (alta, defesa em profundidade):** apenas uma FK garantiria que a movimentação existia, não que era uma despesa do mesmo valor. Adicionado trigger exigindo `direction='expense'`, mesmo proprietário e igualdade exata de centavos.
3. **B3-F3 — Sobrepagamento via caminho alternativo (alta, defesa em profundidade):** proteção condicional do serviço preservada e complementada com trigger contra inserção direta que exceda saldo aberto; testes negativos cobrem bypass.
4. **B3-F4 — Requisições concorrentes:** criados testes para duas tentativas com a mesma chave e duas tentativas diferentes competindo pelo saldo remanescente; deve haver uma única baixa, sem despesa órfã. E2E também exercita duas sessões reais e tentativas cruzadas.

### Evidência

- [Execução #42846195147](https://github.com/carloshgalves/cashControl/actions/runs/42846195147): **52 testes aprovados, zero falhas**, tipagem TypeScript, migrações até 0004 no D1 local e autenticação real com Better Auth/Workerd; nenhuma implantação.
- [Execução #42846493519](https://github.com/carloshgalves/cashControl/actions/runs/42846493519): revisão final incluindo concorrência HTTP no Workerd local — verificar conclusão e logs antes de declarar homologação do teste adicional.

## Limites da entrega

- **Sem telas:** a interface do usuário será submetida ao proprietário antes de ser desenvolvida.
- **Sem produção:** nenhum deploy, CPU na Cloudflare hospedada ou banco remoto. Por decisão do produto, isso ocorrerá quando as funcionalidades estiverem maduras.
- **Não contemplados:** cartões/faturas, encargos e juros, renegociações, recorrência, cancelamentos, antecipações, envio automático de alertas e geração de extratos.
- O histórico é somente de inclusão nesta fatia. Estornos, correções e cancelamentos futuros serão especificados junto aos eventos compensatórios, sem sobrescrever liquidações antigas.

## Critério de saída

Issue #13 pode considerar seus critérios **backend** atendidos quando migração, endpoints, pagamento, quitação parcial/total, não duplicação e testes locais passam. A Issue permanece aberta caso se exija jornada visual de lançamento ou homologação de interface; este PR não aprova tela nem publica produto.
