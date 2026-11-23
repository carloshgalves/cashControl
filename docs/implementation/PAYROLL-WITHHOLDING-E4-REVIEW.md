# E4 / SPEC-005 — baixa de obrigação por retenção de salário confirmada

**Issue:** #25; **épico:** #5. **Base:** `main` após PR #46 (E3). **Branch:** `feat/e4-payroll-withheld-obligations`. **Gate:** PR Draft, sem merge/deploy.

## Contrato de domínio

DEC-009/010: o líquido é a referência de dinheiro disponível. Bruto e descontos são opcionais; **descrever uma dedução não equivale a confirmar sua retenção**. Só a ação separada com `confirmRetained=true`, desconto de demonstrativo aritmeticamente conciliado, valor, obrigação, data efetiva e chave de idempotência pode registrar baixa. O desconto confirmado não produz `posted_cash_movements` e não transita por `financial_obligation_payments` (que sempre exige despesa real). Ele tem canal próprio `salary_withheld_obligation_payments` e origem tipada `salary_withholding_confirmed`.

Exemplo de aceite: salário bruto R$ 3.000, INSS R$ 200, consignado R$ 300, salário líquido R$ 2.500. Saldo bancário com crédito real de R$ 2.500 e sem qualquer despesa adicional por consignado; dívida R$ 300 inicialmente aberta, quitada apenas após confirmação expressa do desconto. Uma retenção parcial de R$ 90 mantém R$ 210 pendentes; os R$ 210 seguintes encerram. Recebimento bancário e retenção confirmada não podem ser somados duas vezes como caixa. Se uma parte da obrigação foi paga via Pix, a retenção usa somente o saldo remanescente; reembolso do pagamento Pix reabre a parte efetivamente devolvida sem desfazer o desconto confirmado em folha.

## Modelagem e segurança

- **Migração 0013:** tabela append-only com PK, `creation_key` exclusiva por titular, desconto por índice de versão E3, obrigação FK composta por titular e `statement_seq` FK. Trigger de inserção valida titular do demonstrativo, competência não cancelada, versão mais recente, bruto presente e matematicamente conciliado, JSON descontado, valor por índice ainda não consumido e saldo da obrigação não cancelada. Confirmações concorrentes só podem ocupar o saldo uma vez. Repetições com mesma chave e mesmo payload devolvem o mesmo registro; uso diverso da chave resulta em conflito.
- A visão `financial_obligation_balances` substituída soma **caixa líquido de reembolsos + retenções confirmadas**. O trigger original de pagamento bancário continua validando contra essa visão, logo Pix versus folha disputam o mesmo saldo remanescente sem duplo pagamento. O trigger de cancelamento é atualizado para incluir retenções não bancárias. Dashboard e agenda já usam a visão e refletem a nova dívida; a trilha de caixa e exportações permanecem sem despesa artificial. Um GET separado por obrigação apresenta rastreabilidade da origem em folha, distinta de pagamentos Pix.
- Guardas BEFORE INSERT/UPDATE/DELETE protegem o histórico mesmo em `INSERT OR REPLACE` com `PRAGMA recursive_triggers=OFF`. Depois da primeira retenção confirmada para a competência, novas versões do demonstrativo são recusadas; evita duplicar um desconto sobre novas versões da mesma folha. Sem procedimento auditável de retificação nessa fatia.
- Serviço exige principal Better Auth, assinatura E3 corrente, `grossStatus='matched'`, valor em centavos, data civil válida e confirmação explícita. HTTP aplica Origin estrito, corpo JSON e filtros allowlist, 404 para dados de outro titular, paginação e idempotência. Nenhuma PII/valor de holerite em logs. Segurança por titular também demonstrada nos relacionamentos SQL.

## Ciclos de revisão e correção

| Finding / risco | Remediação |
|---|---|
| Teste de timeline presumiu objeto `.events` quando o contrato devolve array | Corrigiu a asserção, preservando o teste real da ausência de segundo evento bancário |
| SQL direto poderia quitar com `bruto − descontos ≠ líquido` apesar do serviço bloquear | Trigger SQL exige reconciliação aritmética; regressão de inserção forjada |
| Saldo da obrigação podia ser pago duas vezes por Pix e folha em simultâneo | Visão e triggers compartilham saldo efetivo; corrida com ambas as modalidades elegíveis e **apenas um commit** |
| `INSERT OR REPLACE` poderia reescrever histórico de um desconto parcialmente usado com triggers recursivos desligados | Guard preventivo por `payment_id`/`creation_key` e regressão sobre redução de valor já pago |
| Confirmação da folha não atualizava imediatamente panorama geral | Propagou refresh global após alteração de remuneração/baixa; E2E abre panorama sem recarga |
| Reembolso após pagamento bancário parcial e retenção confirmada poderia confundir liquidação | Regressão: o reembolso reabre somente parte devolvida do Pix, preservando retenção em folha |
| Fonte ou obrigação de outro titular, pagamento acima de dívida/desconto, confirmação sem bruto, desconto insuficiente | Rejeição 404/409 no serviço, guards SQL e testes A/B; nenhuma gravação bancária |
| Registro E3 de descontos poderia parecer um pagamento confirmado | Ação humana distinta, checkbox explícito, histórico de descontos não pagos separado do histórico de baixas |

## Evidência e portão

Validação de regras contratuais, valores exatos, idempotência, concorrência, histórico imutável, proteção SQL, ausência de movimentação bancária, pagamentos parciais, reembolsos e integração com saldos, timeline, XLSX/PDF. Chromium cria obrigação e conta, lança um **único** salário líquido real, cadastra fonte + demonstrativo bruto e descontos, exige checkbox, confirma baixa de consignado, observa dívida paga e saldo de caixa intacto, verifica atualização do panorama, duas sessões Better Auth e mobile.

Workflow `.github/workflows/e4-payroll-withholding-local.yml` aplica migrações até 0013 em D1 local e executa TypeScript, build, suítes determinísticas e Chromium. Nenhum deploy/migração remota foi executado.

**Limites:** sem cálculo ou verificação externa de INSS/IRRF, sem anexo automático de holerite, sem quitação por entrada automática de salário, sem retificação de retenção já confirmada, sem desconto em folha sem salário bruto detalhado, sem compartilhamento entre titulares. Uma conciliação aritmética correta não substitui prova de que a retenção ocorreu; a confirmação é declaração do usuário. A análise é limitada ao escopo e cenários cobertos, não certificação universal.

**Gate:** CI verde no SHA final, parecer adversarial sem findings acionáveis detectados no recorte, inspeção visual/aceite e merge humanos. Issue #25 permanece aberta enquanto a PR não foi integrada.
