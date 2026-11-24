# G2 / SPEC-007 — Revisão adversarial: renegociação de saldo remanescente
**Issue:** #30 · DEC-012 · branch `feat/g2-debt-renegotiation` · **PR Draft, não mesclar enquanto houver finding ou gate visual**.

## Contrato e exemplo de aceite
Uma fatura original de R$ 1.500, com R$ 900 já pagos, possui R$ 600 **ainda em aberto**. O acordo recebe **encargos reais explicitamente informados** de R$ 90 e uma programação de 3 parcelas de R$ 230 (R$ 690 no total). O total de pagamentos bancários anteriores continua R$ 900, a fatura original continua auditável com R$ 600 históricos remanescentes, **mas não é uma cobrança ativa**. O saldo ativo passa a ser só R$ 690, distribuído nas novas datas. Acordo não gera débito bancário; cada confirmação de pagamento gera UM único movimento de caixa vinculado.

O mesmo mecanismo aplica-se a uma obrigação comum parcialmente quitada, inclusive quando há desconto de folha previamente confirmado.

## Implementação
- Migração 0016: `debt_renegotiations` (uma fonte, encargos manuais, snapshot do saldo, acordo e programação imutável JSON em uma única transação), `debt_renegotiation_payments` com débito real e FKs por proprietário; view `debt_renegotiation_installment_balances`.
- A view `financial_active_due_items` é a fonte única para saldos de dívidas ativas, faturas ativas e novas parcelas, sem apagar as views históricas `financial_obligation_balances` e `credit_invoice_balances`.
- Proíbe inserção de novos pagamentos na obrigação/fatura original após seu acordo; proíbe nova compra no mesmo ciclo de fatura renegociada, cancelamento da dívida original e reembolso genérico que reabriria o saldo preservado.
- A baixa do acordo valida parcela, saldo, método, data, proprietário e vínculo com exatamente um débito efetivo; repetição idempotente não movimenta caixa de novo, corridas incompatíveis falham dentro da transação D1.
- API: `GET/POST /api/renegotiations`, `GET /api/renegotiations/:id`, `GET/POST /api/renegotiations/:id/payments`; titular deriva de Better Auth, origem canônica e corpo limitado.
- Dashboard, F1 planejamento, F2 projeções, trilha, alertas e relatório apontam exclusivamente as obrigações **ativas**. O extrato de pagamentos antigos permanece intacto.

## Revisão adversarial
1. Fatura R$1500/R$900/R$600 + R$90 informado = 3×R$230; verificar caixa, cronologia, exportação, planejamento e total após cada pagamento.
2. Obrigação parcialmente quitada: histórico original preservado, novo cronograma somente para o saldo aberto; pagamentos/retornos após acordo não podem modificar o snapshot antigo.
3. Chave repetida e com payload divergente, tentativa de sobrepagamento, duas liquidações concorrentes, transação partida, `INSERT OR REPLACE`, data cronologicamente incompatível e vencimentos fora de ordem.
4. Alice/Bob, conta estrangeira, IDs forjados, CSRF, sessão expirada, filtro inesperado, erros genéricos sem dados financeiros em logs.
5. SQL versionado + D1 local/Workerd + Chromium e regressões de todas as áreas já integradas.

## Limites explícitos e gate de produto
- O acordo é uma **substituição de cronograma**, não baixa de capital, dedução de IR, cálculo de juros, reabertura de fatura nem refinanciamento automático.
- Encargos são informados pela pessoa; datas das parcelas são informadas e ordenadas. Sem estimar taxa de juros, mora ou encargos adicionais futuros.
- Não há cálculo de amortização nem pagamento automático. O mesmo sujeito somente pode ter um acordo de substituição; uma segunda renegociação do acordo requer nova decisão de domínio.
- **Nenhuma nova tela será codificada antes da aprovação visual (ADR-0001)**. É necessário projetar o formulário: selecionar dívida/fatura, exibir saldo antigo e pagamentos já efetuados, explicitar encargos e total 600+90, parcelas e novos vencimentos, confirmar substituição sem criar débito, listar histórico e permitir pagamento da parcela. A interface antiga também deve desabilitar a quitação do sujeito renegociado antes de liberar o recurso a usuários.
- Sem homologação remota, deploy, integração bancária ou dinheiro real. Ainda não encerrar a Issue #30.
