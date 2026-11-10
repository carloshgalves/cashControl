# B5 / Issue #15 — Cancelamentos e reembolsos auditáveis

**Estado:** backend desenvolvido na branch `feat/cancellation-refunds`, a partir da `main` após merge da PR #34. **Sem frontend, deploy ou Cloudflare remoto.** Normas: DEC-002, SPEC-002/B5, [Issue #15](https://github.com/carloshgalves/cashControl/issues/15).

## Escopo funcional escolhido

Uma obrigação **sem qualquer pagamento realizado** pode ser cancelada. O cancelamento ganha um evento imutável (`obligation_cancellations`), encerra seu saldo pendente e **não cria entrada bancária**. O registro original, seu valor, vencimento e motivo da desistência permanecem consultáveis.

Depois de existir qualquer pagamento confirmado, o cancelamento simples fica bloqueado, mesmo se houver reembolso integral: não é permitido apagar a história da quitação. O usuário pode registrar uma ou várias **devoluções efetivamente recebidas** contra a despesa original, sem ultrapassar seu valor pago. A mudança contratual de uma obrigação já paga, sua extinção e chargebacks automáticos são detalhes não aprovados e **não são inferidos nesta fatia**.

A devolução é uma **entrada compensatória de caixa** com `eventKind: 'refund'`, `refundOfMovementId` e `refundedCents`, não um novo salário/serviço prestado. O usuário informa o meio real de recebimento (Pix, espécie, débito ou transferência externa) sem herdar ficticiamente o meio usado na compra original. Pode registrar o recebimento numa outra conta **própria**. Em ambos os casos a linha original da despesa permanece imutável.

Se a despesa quitou total ou parcialmente uma obrigação, a consulta da obrigação passa a usar o **pago líquido de devoluções**. Por exemplo, obrigação de R$ 100,00, paga R$ 80,00 e devolvida R$ 30,00: pago líquido R$ 50,00, pendente R$ 50,00. Reembolsos de uma obrigação já quitada podem reabrir seu saldo pendente; a aplicação não declara a obrigação contratualmente extinta sem decisão explícita.

## Endpoints HTTP

Todos reaproveitam Better Auth, política de origem em POST, limites de payload, erros genéricos e isolamento por titular:

| Rota | Método | Efeito |
|---|---|---|
| `/api/obligations/:id/cancel` | POST | Cancela obrigação ainda não paga; devolve `cancellation` |
| `/api/obligations/:id` | GET | Inclui `state: canceled`, `canceledAt`, `canceledOn` e `cancellationReason` |
| `/api/refunds` | POST | Registra recebimento comprovado e vínculo com despesa original |
| `/api/refunds` | GET | Lista histórico por titular, paginado; `?originalMovementId=` filtra |
| `/api/refunds/:id` | GET | Detalha devolução própria, 404 para recurso alheio |
| `/api/movements` | GET | Mostra despesa e crédito de reembolso com `eventKind` e vínculo explícito |

Exemplo de reembolso (IDs de exemplo):

```json
{
  "idempotencyKey": "refund-20261110-0001",
  "originalMovementId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "accountId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "amount": "30.00",
  "method": "pix",
  "refundedOn": "2026-11-10",
  "reason": "Compra devolvida"
}
```

**Não** registrar pedido de reembolso ainda não recebido como caixa. Nunca informar `owner_user_id` via cliente.

## Modelagem, invariantes e preservação de histórico

- Migração `0006_cancellations_refunds.sql`: tabelas de cancelamentos e devoluções com PKs, idempotência por titular e FKs compostas. O contrato original e seus pagamentos também são protegidos contra UPDATE/DELETE retroativos.
- Cancelamento não gera dinheiro: evento auditável, trigger exige ausência de pagamentos anteriores. Se cancelamento e pagamento concorrem, apenas um consegue ser confirmado.
- O serviço de reembolso usa um `D1.batch()` atômico: insere crédito real em `posted_cash_movements` e a linha correspondente em `cash_refunds`. Se qualquer passo falhar, **não há crédito órfão**.
- Trigger de defesa em profundidade valida origem paga (`direction = expense`), devolução efetivamente creditada (`direction = income`), mesmo titular, montante exato, data não anterior à despesa e prefixo reservado de idempotência.
- Trigger verifica a soma de **todas** as devoluções contra a despesa e recusa exceder o montante originalmente pago, inclusive concorrência entre reembolsos.
- `financial_obligation_balances` calcula `paid_cents` líquido de estornos e `outstanding_cents` coerente; pagamentos novos após devolução são autorizados apenas até a pendência líquida.
- `obligation_payment_invariants` foi reinstalado usando o saldo líquido; impede pagamento após cancelamento e quitação acima do devido.
- O histórico de devoluções e as tabelas originais de movimentos, obrigações e pagamentos possuem gatilhos de imutabilidade. Futuras correções requerem eventos vinculados, não sobrescritas silenciosas.

## Revisão adversarial — ciclos executados

1. **B5-F01 — Regressão no replay financeiro:** uma consulta de idempotência ainda selecionava a estrutura antiga do lançamento, omitindo os campos novos de classificação; três testes anteriores falharam. Corrigido usando a mesma seleção derivada em todas as leituras; os testes voltaram a passar.
2. **B5-F02 — Erro no script E2E:** havia duas variáveis `attack` declaradas no mesmo escopo, impedindo a execução da bateria real. Corrigido o nome e adicionada etapa `node --check scripts/e2e-auth.mjs` ao workflow antes de subir o Worker.
3. **B5-F03 — Meio da devolução inferido incorretamente:** o backend copiava o método de pagamento original, potencialmente registrando um Pix como espécie ou vice-versa. Corrigido exigindo `method` no pedido do reembolso e incluindo esse campo na chave semântica de replay.
4. **B5-F04 — Imutabilidade incompleta dos pagamentos:** pagamentos/obrigações originais poderiam ser alterados diretamente por SQL e prejudicar a rastreabilidade dos estornos. Acrescentados triggers de UPDATE/DELETE e teste adversarial específico.
5. **B5-F05 — Prova concorrencial:** duas devoluções diferentes não podem reembolsar a mesma quantia duas vezes. Foram adicionados testes tanto em SQLite real quanto com dois pedidos simultâneos contra Workerd/D1 local, sem enfraquecer asserções anteriores.

**Re-review:** depois das correções, nenhum achado acionável reproduzível permanece nas superfícies efetivamente cobertas pela suíte. A afirmação não inclui produção, chargebacks reais ou interfaces ainda inexistentes.

## Evidência objetiva

- Primeira tentativa de CI identificou F01: 85/88 testes aprovados.
- Segunda execução confirmou correção do domínio (88/88) e revelou F02 antes de iniciar E2E.
- Execução subsequente confirmou 88/88, migração 0006 aplicada e integração com duas sessões reais.
- Outra execução validou F03 com 88/88 e integração real.
- **[Execução final #42915366466](https://github.com/carloshgalves/cashControl/actions/runs/42915366466)** — validar conclusão antes de declarar aprovação de F04. Esperado: 89 testes, migração 0006 e E2E real.

A integração usa somente D1 local descartável, Wrangler/Workerd, contas fictícias e dependências instaladas com `npm ci`. Não faz deploy. Cloudflare hospedada, custo de CPU e política de operação do SaaS permanecem adiados por decisão do usuário.

## Fora de escopo

Cancelamento de obrigação com pagamentos já realizados, renegociação, reversão bancária real, chargeback automático, impostos, classificação contábil sofisticada de competência, taxas de cartão, edição retroativa, ressarcimento de transferências próprias, compartilhamento familiar e interface visual.

**Frontend ainda não implementado**: antes de iniciar qualquer tela, propor o design ao responsável pelo produto e obter aprovação explícita. A PR fica em Draft aguardando revisão e merge manual.
