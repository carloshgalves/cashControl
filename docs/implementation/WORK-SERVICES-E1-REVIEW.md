# E1 / SPEC-005 — revisão de trabalhos e serviços

Issue #22; base `main` após merge da PR #43. Branch `feat/e1-optional-work-costs`. Entrega vertical: migração 0010, serviço, HTTP, Worker, UI e testes.

## Contrato de domínio

DEC-005 e DEC-006: ficha opcional, recebimento independente de execução, vinculação opcional de custos sem dupla contabilização. Cadastro não cria receita; valores previstos não entram no saldo. Eventos de situação são append-only: previsto → confirmado/realizado/cancelado; confirmado → realizado/cancelado; realizado → cancelado. Cancelado é terminal. Essa regra operacional de histórico não implica perdão de dívida, reembolso ou invalidação dos registros efetivos. Motivo é opcional, preservado quando informado.

Recebimento usa a soma dos créditos efetivos vinculados; custo líquido é soma das despesas vinculadas descontados os reembolsos confirmados associados a elas; resultado líquido = recebido − custo líquido. O valor combinado pode ser ausente, zero ou positivo; o estado resultante distingue não informado, a receber, parcial, recebido e acima do combinado. Diferença ainda não recebida é informativa; em trabalho cancelado não é prova de dívida exigível.

Cada lançamento efetivo tem, no máximo, um vínculo de trabalho por titular. Escolha de produto local: o usuário pode registrar um movimento pelo formulário já existente e depois vinculá-lo, ou selecionar um lançamento previamente registrado; sem rateio ou alteração automática do histórico. Não se aceita crédito de reembolso como receita de trabalho, nem pagamento consolidado de fatura como custo individual. Transferências internas não são lançamentos elegíveis. Compra de cartão individual, devolução de recebimentos, desvinculação corretiva e rateio exigem contratos próprios.

## Controles e revisão adversarial

| Finding / risco | Controle aplicado |
|---|---|
| Estado de trabalho confundido com recebimento | estados separados, agregados exatos derivados de movimentos já efetivos |
| Duplicação ou apropriação entre trabalhos/titulares | FK composta, unicidade por titular/movimento, idempotência, concorrência testada |
| Ficha sem evento inicial após falha | batch D1 atômico, falha injetada e retry |
| Reembolso contabilizado como receita e custo superestimado | exclusão de créditos de reembolso, custo líquido derivado, teste de reembolso |
| Pagamento consolidado de cartão tratado como custo do serviço | guard SQL nos dois sentidos e teste do fluxo D2 |
| Sobrescrita de história por INSERT OR REPLACE | guard BEFORE INSERT, além de UPDATE/DELETE; sequência de estado não configurável por cliente |
| Agregado excede inteiro seguro depois da persistência | guard SQL rejeita inserção antes de ultrapassar MAX_SAFE_INTEGER; teste com 1000 lançamentos |
| Perda da seleção após atualizar dados globais, falha de leitura e formulário editável durante POST | tela preservada na atualização global, bloqueio de mutações e retry de leitura, chaves por payload; histórico visível na própria ficha |
| Notas multiline e overflow de rótulos | validação de caracteres, quebra de linha e responsividade |
| Fixture com chave inválida e seletor de texto exato inadequado no E2E | fixtures/chaves válidas, asserção de região/heading/valor sem enfraquecer comportamento financeiro |

Relatórios gerais e dashboard não recebem novos registros de dinheiro; teste compara eventos da trilha antes/depois do vínculo e produz XLSX/PDF com três eventos de caixa. Chromium comprova seleção, recebimento parcial R$100+R$200, despesas R$40+R$60, resultado R$200, cancelamento com motivo, sessão Alice/Bob e viewport mobile. SQLite real em memória aplica migrações 0001–0010 e testa autorização, histórico e limites. Workflow E1 `.github/workflows/e1-work-services-local.yml` executa suite determinística, compilação e jornada em D1 local descartável.

## Limites e gate

Não há gestão de horas, faturamento profissional, recorrência de rendas (E2), projeções automáticas, compartilhamento, rateio ou modificação de vínculos existentes. As datas previstas não criam expectativa recorrente nem receita. A análise de custos trata movimentos efetivos individualizáveis, não competência econômica de compras de cartão. Sem deploy remoto, migração em dados reais, carga de produção ou aceite visual humano. Parecer limitado aos contratos e cenários testados. Merge manual após CI verde no SHA final, revisão visual e aceite do responsável; Issue #22 permanece aberta enquanto não integrada em main.
