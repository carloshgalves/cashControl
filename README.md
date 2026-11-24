# cashControl

Ferramenta de gestão de finanças pessoais em **desenvolvimento incremental**, com núcleo financeiro versionado e interface interativa React em validação local.

O produto será multiusuário com finanças isoladas por perfil. Compartilhamento familiar com permissões poderá ser uma evolução futura, sem fazer parte do MVP.

O produto deverá permitir registrar entradas, saídas, fontes de renda, contas a pagar, cartões e faturas, trabalhos opcionais, valores a receber, intenções de compra, reservas preventivas, projeções conservadoras e uma linha do tempo financeira. Relatórios exportáveis em XLSX e PDF também fazem parte dos requisitos iniciais.

## Documentação de produto

- [Especificação central — SPEC-000](docs/specs/SPEC-000-produto-mvp.md)
- [Backlog estruturado — 7 épicos e 23 tickets](docs/planning/BACKLOG.md)

- [Registro de Decisões de Negócio — DEC-001 a DEC-014](docs/decisions/DECISOES-DE-NEGOCIO.md)

As DEC registram **o que foi aprovado** em discussões de produto. Não são ADRs técnicos, não constituem especificações completas de implementação e não autorizam codificação automática.

**Fluxo de trabalho:** descoberta de produto → registro e esclarecimento de decisões → especificações com critérios de aceite → tickets implementáveis → arquitetura e implementação.

## Estado

- DEC-001 a DEC-014: registradas e aprovadas nos limites indicados em cada decisão.
- Especificação funcional e tickets: **publicados**, com implementação incremental P0/P1/P2; a ADR-0001 está aprovada; a Issue #8 permanece aberta até homologação operacional (CPU/Workers hospedado, backup e restore).
- Backend financeiro (contas, movimentos, obrigações, transferências e reembolsos): implementado e testado em D1 local.
- Dashboard backend: [PR #36](https://github.com/carloshgalves/cashControl/pull/36), mesclada, com dados em centavos e isolamento por usuário.
- Dashboard interativo React/Vite: [PR #37](https://github.com/carloshgalves/cashControl/pull/37), mesclada, aprovada visualmente e validada no Chromium.
- Trilha financeira e avisos in-app D-10/D-5: Issue #17 concluída; PRs #38/#39 mescladas na `main`.
- Exportação privada XLSX/PDF: [PR #40](https://github.com/carloshgalves/cashControl/pull/40) mesclada em `main`; Issue #18 encerrada após reconciliação dos critérios de aceite.
- F1/F2: intenções, reservas virtuais e cenários read-only integrados na `main` (PRs #48/#49).
- G1, G2 e F3: lógica e APIs integradas em `main` nas PRs [#51](https://github.com/carloshgalves/cashControl/pull/51), [#53](https://github.com/carloshgalves/cashControl/pull/53) e [#52](https://github.com/carloshgalves/cashControl/pull/52). As respectivas Issues #29, #30 e #28 permanecem abertas por ausência das telas dedicadas aprovadas visualmente; a fórmula F3 segue proposta ainda não homologada matematicamente.
- Cloudflare hospedada e produção: deliberadamente adiadas até o produto estar mais completo; sem aprovação de dados financeiros reais.
- **Gate operacional aberto:** #8–#10 (CPU Workers Free, recuperação de conta, backup/restauração, validação remota). A branch de A1 introduz um **ensaio de exportação/criptação/restauração local**; não prova backup externo, CPU hospedado ou restore remoto.

O documento de decisões é a fonte atual das regras de negócio acordadas. Mudanças devem ser explicitadas e vinculadas à decisão que modificam.

## Recuperabilidade — A1 / SPEC-001

O procedimento local [D1-RECOVERY-RUNBOOK.md](docs/operations/D1-RECOVERY-RUNBOOK.md) demonstra recuperação de um banco D1 descartável com 16 migrações e duas contas de teste: exportação SQL real por Wrangler, criptografia autenticada AES-256-GCM, exclusão do export em claro, importação em **outro** D1 local, verificação das definições SQL de schema, integridade de FKs e comparação de todas as linhas e saldos derivados. Um teste adversarial modifica intencionalmente uma linha do banco restaurado e exige que a impressão digital detecte a divergência.

Para reproduzir após `npm ci`: `npm run ops:recovery:drill`. A criptografia isolada também é testada em `npm test`. Nunca se conectam bancos remotos, não há SQL financeiro publicado em CI e a chave de backup de produção não existe no projeto.

**Limite:** ensaio local não implica segurança operacional aprovada. O ticket #8 mantém gates específicos para armazenamento independente cifrado, retenção, políticas de acesso e recuperação de chave, restore remoto em ambiente isolado, monitoramento e aferição de CPU hospedada. Não utilizar dados financeiros reais nem encerrar os tickets #8–#10 com base nesse CI.

## Desenvolvimento local da interface

Requisitos: Node.js 22.16+ e npm. Execute `npm ci`, configure Wrangler/D1 **local** usando `wrangler.toml.example` e `.dev.vars` ignorados pelo Git, e aplique `npx wrangler d1 migrations apply DB --local --config wrangler.toml`.

Inicie o Worker com `npm run dev -- --ip 127.0.0.1 --port 8787 --config wrangler.toml` e a interface com `npm run ui:dev` em outro terminal; abra **http://127.0.0.1:5173**. O Vite encaminha `/api` ao Worker local. `BETTER_AUTH_URL` deve corresponder à URL do Worker, `http://127.0.0.1:8787`.

Testes: `npm run ui:check`, `npm run ui:test`, `npm run ui:build`, `npm test`. `npm run ui:e2e` exige Worker, frontend e banco local preparados, além de Chromium instalado via Playwright. A execução comprovada está em [GitHub Actions #42941383664](https://github.com/carloshgalves/cashControl/actions/runs/42941383664).

Relatório de revisão da interface: [INTERACTIVE-UI-REVIEW.md](docs/implementation/INTERACTIVE-UI-REVIEW.md).

**Não use contas nem dados financeiros reais neste ambiente de homologação.** Não existe deploy de produção nesta entrega.

## Trilha financeira (C2)

A tela **Trilha financeira** reúne os eventos confirmados, obrigações pendentes, cancelamentos e avisos de vencimento. Os indicadores D-10/D-5 são calculados a partir da **data local do navegador** e do saldo pendente efetivo no D1. Não há pagamentos automáticos, previsões fictícias ou notificações externas.

Endpoints de leitura `GET /api/timeline?from=2026-11-01&to=2026-11-30&asOf=2026-11-11` e `GET /api/alerts?asOf=2026-11-11`. Os dois exigem sessão Better Auth e usam paginação/limites. Testes locais: `npm test`, `npm run ui:test`, `npm run ui:build` e `npm run ui:e2e` (com D1 local e Chromium). Relatório: [FINANCIAL-TIMELINE-REVIEW.md](docs/implementation/FINANCIAL-TIMELINE-REVIEW.md), evidência [GitHub Actions #43064714180](https://github.com/carloshgalves/cashControl/actions/runs/43064714180).

## Exportação XLSX/PDF (C3)

Na interface, use **Exportar** ou **Exportar filtro** na trilha. Selecione período, conta (ou todas) e situação, depois **Baixar XLSX** ou **Baixar PDF**. O relatório consulta exclusivamente a sessão Better Auth verificada no servidor; não há link público ou persistência de documentos.

Endpoint: `GET /api/reports/export?format=xlsx|pdf&from=AAAA-MM-DD&to=AAAA-MM-DD&asOf=AAAA-MM-DD&status=all` (filtro `accountId` opcional). Transferências próprias não são receita, pagamentos de obrigações não são duplicados e pendências não representam saída de caixa. Arquivos com mais de 2.000 eventos falham explicitamente (413).

Validação: `npm test`, `npm run ui:test`, `npm run ui:build`, `npm run ui:e2e` com Worker, D1 e Chromium locais. Exportações usam nomes distintos por filtros, cabeçalhos PDF com quebra e limites medidos por fonte, além de rótulos em português. **Última revisão adversarial aprovada nas baterias locais: 129 backend + 16 frontend + Chromium real.** [Relatório C3](docs/implementation/FINANCIAL-EXPORT-C3-REVIEW.md). **PR #40 mesclada em `main`; sem deploy de produção.**

A geração de XLSX/PDF utiliza formatação exata para totais elevados: no Excel, montantes superiores ao limite seguro de precisão numérica são exportados como **texto monetário** para não perder centavos (e não devem ser somados automaticamente). O E2E usa data civil fixa e não depende do mês de execução. Consulte o relatório C3 para as regressões da terceira revisão adversarial.

## Cartões de crédito e parcelas — D1 / SPEC-004 (PR #41 mesclada)

Nova navegação **Cartões**, opcional, com cadastro de apelido, instituição, limite informado e dias de fechamento/vencimento. Compras com valor total em centavos e 1–60 parcelas geram ciclos mensais consultáveis por compra ou por fatura. Crédito não incrementa saldo; compra não cria saída bancária.

**Regra documentada:** compra até o dia efetivo de fechamento entra no ciclo do próprio mês; após o fechamento, entra no seguinte. Fechamento/vencimento em dia inexistente usam o último dia civil do mês. Vencimento posterior ao fechamento efetivo fica no mesmo mês do ciclo; caso contrário, no mês seguinte. Partes dividem centavos exatamente: primeiros índices recebem o resto (R$100,01 em 10x: R$10,01 + 9 × R$10,00).

API autenticada: `GET/POST /api/cards`, `GET /api/cards/{id}`, `GET/POST /api/cards/{id}/purchases`, `GET /api/cards/{id}/purchases/{purchaseId}`, `GET /api/cards/{id}/invoices`, `GET /api/cards/{id}/invoices/{AAAA-MM}`. IDs de outro titular retornam 404. Compra e parcelas são imutáveis e criadas em lote transacional, com chave de idempotência por titular.

**Estado D1:** [PR #41](https://github.com/carloshgalves/cashControl/pull/41) mesclada. Pagamentos de fatura e integração ao dashboard/trilha/exportação foram mesclados na [PR #42](https://github.com/carloshgalves/cashControl/pull/42); a conferência manual foi integrada pela PR #43 / D3 (#21). Consulte [relatório técnico de D1](docs/implementation/CREDIT-CARDS-D1-REVIEW.md). Sem deploy remoto nem dados reais na homologação.

## Pagamentos integrais e parciais de faturas — D2 / SPEC-004 (Issue #20)

**PR #42 mesclada em `main`.** Sem deploy de produção.

- Faturas calculadas por cartão e ciclo com **total, pago e restante** derivados dos registros imutáveis. Ao pagar R$ 900,00 de R$ 1.500,00, restam R$ 600,00; o pagamento posterior de R$ 600,00 encerra o ciclo.
- POST autenticado `/api/cards/{cardId}/invoices/{AAAA-MM}/payments` com `idempotencyKey`, `accountId`, `amount`, `method` e `paidOn`; GET na mesma rota consulta o histórico paginado. Apenas contas e faturas do usuário autenticado são aceitas.
- Uma única saída de caixa `posted_cash_movements` é criada no **mesmo batch SQLite/D1** que o vínculo em `card_invoice_payments`. O banco impede overpay concorrente, vínculos duplos e reembolsos genéricos de pagamento de cartão sem regra de reversão. Compras continuam sem saída bancária.
- Dashboard mostra **faturas de cartão pendentes separadas** das obrigações comuns; a trilha, alertas D-10/D-5 e relatórios PDF/XLSX incluem faturas não pagas **uma vez**, sem tratá-las como débito realizado. Pagamentos aparecem uma vez como baixa confirmada. Um aviso de cartão abre seu cartão e ciclo exatos.
- Formulário React apresenta contas de origem, data, método, valor, histórico de pagamentos e alertas de saldo negativo. Não armazena PAN/CVV. O formatador de centavos utiliza `BigInt` para não arredondar totais elevados.

**Testes locais/CI:** `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test` e `npm run d2:e2e` com D1 descartável e Chromium. Há regressões para duas identidades, 900+600, três tentativas idempotentes simultâneas, duas baixas concorrentes, rollback injetado após inserção bancária e avisos de cartão.

**Limites:** D2 registra somente pagamentos já efetivados; não agenda transferências nem gera juros, estornos automáticos, renegociações ou conciliação bancária (D3 / #21). Reembolso de baixa de cartão requer um fluxo específico que preserve/reabra a dívida, portanto foi bloqueado no endpoint genérico. Não há implantação de produção. [Parecer técnico D2](docs/implementation/CREDIT-INVOICE-D2-REVIEW.md).

## Conferência manual de faturas — D3 / SPEC-004 (Issue #21)

**PR #43 mesclada em `main`.** Opcional: quem não informa valor da instituição permanece com status **Ainda não informada** e continua usando as faturas normalmente.

O usuário digita o **total bruto da fatura** exibido em seu banco ou emissor e o cashControl compara com o **total calculado das compras e parcelas do mesmo cartão/ciclo**, não com o saldo em aberto após pagamentos. Estados: **Valores coincidem** (`matched`), **Divergência pendente** (`pending_divergence`) e **Ainda não informada** (`unreported`). Uma diferença pendente não autoriza ajuste de compra, parcela, dívida, pagamento, saldo ou juros. Nenhuma conexão ou confirmação automática de banco é representada.

A tela de cartão mostra totais lado a lado, diferença com sinal, lista de parcelas para conferência e histórico imutável de valores informados, com o cálculo que existia no momento do lançamento. Inserir outro valor acrescenta uma observação sem apagar a anterior; o status atual usa a observação manual mais recente e o valor **atual** calculado do ciclo. Repetir a mesma requisição de forma idempotente não insere uma segunda observação.

Contrato: `GET /api/cards/:cardId/invoices/:cycle/reconciliation?limit=25&offset=0` devolve status e histórico; `POST` no mesmo caminho recebe `{idempotencyKey,reportedTotal}` onde `reportedTotal` é string decimal não negativa. Somente o titular autenticado acessa a fatura, com verificação Better Auth e Origin para POST. Montantes agregados são comparados com aritmética de centavos segura, mesmo quando a soma de várias compras ultrapassa o limite de um lançamento individual.

**Fora do escopo:** importação de extrato, upload de documento, APIs bancárias, identificação automática das causas de divergência, ajustes contábeis automáticos, geração de encargos e alterações de pagamentos/parcelas. [Parecer D3](docs/implementation/CREDIT-INVOICE-D3-REVIEW.md). Sem deploy remoto ou exposição de dados reais.

## Trabalhos, recebimentos e custos — E1 / SPEC-005 (Issue #22)

Implementação E1 integrada em `main` pela [PR #44](https://github.com/carloshgalves/cashControl/pull/44). Cadastro opcional com contratante, valor combinado (opcional), datas previstas, categoria e observações. Estados previsto, confirmado, realizado e cancelado são independentes do estado de recebimento. Cancelamento preserva motivo, histórico e lançamentos anteriores; não cria dinheiro nem certifica dívida exigível.

Na seção **Trabalhos**, registre um serviço e associe movimentações efetivas já existentes. Também é possível abrir o formulário normal de receita ou despesa e vinculá-la após o registro. O vínculo é único por lançamento e titular, imutável e não cria entrada ou saída adicional. Reembolsos reduzem os custos líquidos; créditos de reembolso e pagamentos consolidados de fatura não podem ser vinculados como receita ou custo individual do serviço. Ex.: recebimentos de R$ 100 + R$ 200, despesas de R$ 40 + R$ 60 → resultado líquido de R$ 200.

API autenticada: `GET/POST /api/works`, `GET /api/works/:workId`, `GET/POST /api/works/:workId/states`, `GET/POST /api/works/:workId/movements`, `GET /api/work-movements/available`. A migração `0010_work_services.sql` registra fichas, eventos e vínculos; a visão calcula os valores em centavos. Não há nova movimentação no vínculo, nem expectativa creditada automaticamente. O fluxo geral e os relatórios permanecem os mesmos.

Validação: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run e1:e2e` com D1 local e Chromium/Better Auth. [Parecer técnico E1](docs/implementation/WORK-SERVICES-E1-REVIEW.md). Fora do escopo: recorrência E2, rateio, alteração/desvinculação de históricos, gestão de horas, faturamento, atribuição de compra individual de cartão, integração bancária e deploy remoto.


## Fontes de renda e expectativas — E2 / SPEC-005 (Issue #23)

A PR #45 (E2) foi integrada em `main`. A implementação E2 fontes de renda e calendário **sem registrar dinheiro automaticamente**, conforme DEC-004/007 e a SPEC-005. O cadastro registra **vínculo** (CLT, público, contrato contínuo, freelance, outro), **natureza da remuneração** (fixa, variável, mista ou avulsa) e **periodicidade** (nenhuma, semanal, quinzenal, mensal ou intervalo personalizado de 1–365 dias). Esses três campos são independentes. Remuneração líquida fixa, quando informada e positiva, gera expectativas recorrentes somente para remuneração fixa/mista com periodicidade. Renda puramente variável ou avulsa exige expectativa explicitamente informada; meses sem renda permanecem sem lançamentos.

Calendário determinístico de até 367 dias inclusivos: 31/jan mensal gera 28/fev (ou 29/fev em ano bissexto), 31/mar etc.; primeira e última datas informadas delimitam o intervalo. `GET /api/income-calendar?from=AAAA-MM-DD&to=AAAA-MM-DD` não grava nada. Uma expectativa pode ser **confirmada como previsão** (sem creditar caixa), **adiada** (mantendo a data original e a identidade do evento) ou **cancelada** (preservando motivo e recebimentos históricos). O histórico é imutável e idempotente.

Valores previstos e recebimentos efetivos são comparados em centavos, inclusive diferença positiva/negativa: o usuário pode **vincular uma entrada real já registrada** à expectativa, integral ou parcialmente, sem criar outra entrada. Um mesmo lançamento real não pode satisfazer duas expectativas; créditos de reembolso não são salários/receita de trabalho. O dashboard, a trilha e as exportações de caixa continuam representando somente lançamentos reais. Saldo restante de expectativa cancelada não é apresentado como dívida automaticamente exigível.

API autenticada Better Auth: `GET/POST /api/income-sources`, `GET /api/income-sources/:sourceId`, `POST /api/income-sources/:sourceId/expectations` (pontual), `GET /api/income-calendar`, `GET /api/income-receipts/available`, `GET/POST /api/income-sources/:sourceId/expectations/:occurrenceKey/events` e `GET/POST /api/income-sources/:sourceId/expectations/:occurrenceKey/receipts`. Migração `0011_income_expectations.sql`; SQL protege identidade do titular, calendários fixos, valores, imutabilidade e associação única de recebimentos.

Validação: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run e2:e2e`, com migrações 0001–0011 em D1 descartável, Chromium e duas sessões Better Auth. [Parecer E2](docs/implementation/INCOME-EXPECTATIONS-E2-REVIEW.md).

**Limites explícitos:** encerramento/suspensão de uma fonte após a criação, reajustes por vigência e composição bruto/descontos dependem das regras complementares a detalhar em DEC-007 e E3 (#24); não são inferidos ou aplicados retroativamente nesta fatia. Fontes podem ser criadas com última data de recorrência informada. Sem horas automáticas, estimativas históricas/IA (F3), folha externa, Open Finance, exportação de previsões como dinheiro real ou deploy remoto.


## Composição salarial e reajustes — E3 / SPEC-005 (Issue #24)

**A PR #46 (E3) foi integrada em `main`.** A E3 amplia a tela **Rendas → fonte de renda → competência** sem alterar os lançamentos reais de caixa.

- **Salário líquido** obrigatório no demonstrativo da competência; **salário bruto opcional no mesmo formulário**, sem checkbox ou etapa adicional. Se bruto estiver vazio, é ignorado e nenhum desconto é inventado.
- Com bruto informado, o usuário pode discriminar **INSS, IRRF, consignado, plano de saúde e outras retenções** com valor e rótulo; a conferência é exata em centavos: `bruto − descontos discriminados − líquido informado`. Uma diferença não zero gera **conciliação pendente** e não autoriza ajuste automático. A igualdade é exclusivamente aritmética, não comprovação bancária ou tributária.
- **Reajuste permanente** exige nova remuneração **líquida**, motivo e **data de vigência**. A expectativa-base a partir dessa data é recalculada no GET do calendário E2 sem reescrever o valor inicial nem as competências anteriores. Reajustes devem ter vigências posteriores à última revisão existente; correções retroativas exigem contrato específico.
- **Horas extras, gratificações, outras verbas e reduções pontuais** pertencem somente ao demonstrativo daquela competência. Ex.: base R$ 2.500 até outubro; aumento para R$ 2.750 a partir de novembro; demonstrativo novembro R$ 3.000 com R$ 250 de horas extras; dezembro retorna à base recorrente de R$ 2.750. Se não houver demonstrativo, o calendário usa a base vigente.
- Cada demonstrativo guarda **base líquida existente na data de registro** e lista de descontos/adicionais. Novas correções acrescentam versões imutáveis; salário-base, histórico de composição e caixa efetivo são conceitos distintos. Alterações de base posteriores **não reinterpretam** a conciliação histórica do demonstrativo anterior. Se o líquido não conferir com base + componentes, a diferença também fica visível.
- A E3 **não cria recebimentos, pagamentos, tarifas, impostos ou baixas de obrigação**: descontos retidos antes do crédito bancário já se refletem no líquido; contabilizá-los como nova saída duplicaria despesas. A baixa confirmada por desconto em folha é a **E4/#25**, ainda fora desta entrega.

API privada: `GET/POST /api/income-sources/:sourceId/salary-revisions`; `GET/POST /api/income-sources/:sourceId/expectations/:occurrenceKey/salary`. Better Auth, Origin no POST, validação estrita de corpo JSON, dinheiro exato em centavos, idempotência por titular e códigos 400/401/403/404/409/413. A migração `0012_salary_composition.sql` é append-only, com FKs de titular, integridade de vigência, snapshot base verificável e proteção contra `INSERT OR REPLACE`, `UPDATE` e `DELETE`. Os campos de salário e holerite não são emitidos em logs.

Validação local: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run e3:e2e`, migrações 0001–0012 em D1 descartável e Chromium/Better Auth real com Alice/Bob. [Parecer adversarial E3](docs/implementation/PAYROLL-E3-REVIEW.md).

**Fora do escopo:** cálculo automático de INSS/IRRF e regras trabalhistas, emissão de holerite, confirmação bancária de salários, pagamento de consignado em folha (E4), anexos de documentos, encerramento/suspensão de fonte, reajuste retroativo antes da última versão, rateio de um recebimento em múltiplas competências e deploy remoto.


## Desconto em folha confirmado e obrigação paga — E4 / SPEC-005 (Issue #25)

A branch `feat/e4-payroll-withheld-obligations` entrega **quitação parcial/total de obrigação por desconto efetivamente retido em folha**, com origem explícita `salary_withholding_confirmed`. É uma forma de **pagamento não bancário**: o salário líquido depositado continua sendo a única receita de conta, e a retenção **não gera segundo débito bancário**, movimentação de caixa, tarifa, lançamento de dívida ou reembolso.

Fluxo: **Rendas → selecionar competência da fonte → informar bruto, líquido e descontos E3 → conferir `bruto − descontos = líquido` → confirmar separadamente a retenção ocorrida → selecionar a obrigação, desconto, valor retido e data de retenção → marcar confirmação expressa → baixar obrigação**. O demonstrativo isolado, sem confirmação adicional, jamais altera o saldo devido. Uma conciliação gross/líquido pendente ou bruto ausente não habilita quitação. A confirmação pode ser parcial e utilizar somente o valor remanescente daquele desconto, respeitando também o saldo ainda devido.

Ex.: salário **bruto R$ 3.000**, retenções INSS R$ 200 + consignado R$ 300, **líquido R$ 2.500**. Se R$ 2.500 foram realmente depositados, essa é a **única entrada no banco**. Só quando se confirma o consignado R$ 300, a obrigação muda de R$ 300 em aberto para R$ 0 — **sem uma saída adicional de R$ 300 do saldo bancário**. O registro conserva identificador da versão de demonstrativo, índice e rótulo do desconto, obrigação, valor, data e trilha append-only.

Banco: migração `0013_salary_withholding_obligations.sql`; tabela `salary_withheld_obligation_payments`, guardas por titular, versão corrente, desconto discriminado e aritmeticamente conciliado, limite de desconto e saldo da dívida, idempotência e proteção contra `INSERT OR REPLACE`, UPDATE/DELETE. A visão `financial_obligation_balances` agrega dinheiro pago efetivamente pelo caixa **líquido de reembolsos** mais o pagamento não bancário confirmado em folha. A guarda de cancelamento impede cancelar dívida já liquidada parcialmente por qualquer das duas vias. Uma vez confirmada retenção, o demonstrativo fica **congelado**; retificação exige procedimento separado e auditável.

API autenticada: `GET/POST /api/income-sources/:sourceId/expectations/:occurrenceKey/salary/withholdings` e `GET /api/obligations/:obligationId/withholdings`; o fluxo bancário anterior `GET /api/obligations/:id/payments` continua listando **apenas pagamentos de caixa**, não duplicando baixas não bancárias. A interface apresenta histórico por competência, e as obrigações mostram saldos corrigidos em dashboard, agenda e relatórios; após confirmação, o panorama é atualizado sem exigir recarregamento manual. `GET` usa paginação, Better Auth e isolamento entre titulares. Os POSTs exigem Origin válido, JSON permitido, confirmação humana explícita, decimal em centavos e idempotência.

Validação: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run e4:e2e`, migrações 0001–0013 com D1 local descartável, Chromium real e duas sessões Better Auth. [Parecer E4](docs/implementation/PAYROLL-WITHHOLDING-E4-REVIEW.md).

**Fora de escopo:** retenção automática por simples digitação de holerite, cálculo tributário de INSS/IRRF, integração com folha/empregador, anexos comprobatórios, correção/estorno posterior de baixa por retenção, quitação de várias competências por uma única verba, e deploy remoto. O comprovante de retenção é declaração explícita do usuário; **não** é verificação automática externa. Registrar desconto na folha não significa que uma dívida esteja juridicamente extinta sem a confirmação real de pagamento.


## Planejamento de compras e reservas preventivas — F1 / SPEC-006 (Issue #26)

A branch `feat/f1-purchase-intentions-preventive-reserves` implementa uma área de **Planejamento** para registrar algo que se deseja comprar, descrição opcional, preço estimado e data possível da compra. Uma intenção nasce no estado **planejamento**: nunca é dívida, compra no cartão nem lançamento financeiro. Pode-se optar por ativar uma **reserva virtual**, total ou parcial, ajustá-la, desativá-la retornando a planejamento ou retirar a intenção antes da compra. A exclusão é lógica, preservando histórico imutável e sem remover qualquer evento financeiro real.

A margem preventiva F1 é um **indicador conservador atual**: `saldos reais atuais − obrigações próprias em aberto − faturas de cartão em aberto − reservas virtuais ativas`. O saldo bancário e o fluxo real não são alterados por planejar ou reservar. Margem negativa recebe alerta, mas não impede a decisão. Nem compras apenas planejadas, nem salários previstos ou receitas incertas são tratados como dinheiro confirmado. A F1 não projeta uma curva por datas: cenários conservadores, planejados e potenciais, renda futura e simulações pertencem à **F2/#27** e à F3/#28.

Para **concretizar a compra**, o usuário seleciona explicitamente o **vencimento da obrigação** (pode diferir da data possível de compra) e marca confirmação. A transação D1 registra uma obrigação comum de valor integral e uma transição `convert` no mesmo batch atômico, removendo a reserva virtual. Exemplo: reserva R$ 500 → obrigação R$ 500, sem virar compromisso R$ 1.000 e **sem deduzir caixa**; apenas quando a obrigação for paga pelo fluxo já existente, haverá saída bancária. Uma reserva parcial de R$ 200 convertida em compra de R$ 500 é substituída integralmente pelo compromisso de R$ 500, nunca somada a ele.

Modelo persistente: migração `0014_purchase_intentions.sql` com `purchase_intentions`, `purchase_intention_events` e visão `purchase_intention_balances`. Eventos são append-only com índices, proprietário, valores exatos, data de vencimento escolhida na conversão, vínculos e estados `planning`, `reserved`, `converted` e `excluded`. Triggers impedem alterações retroativas, `INSERT OR REPLACE`, reserva maior que o preço, transição após conversão/exclusão, conversão forjada sem obrigação correspondente e duas conversões com chaves distintas. Uma repetição idempotente retorna o mesmo evento; operação conflitante é recusada.

API protegida por Better Auth: `GET/POST /api/intentions`, `GET /api/intentions/:id`, `GET/POST /api/intentions/:id/events`, `GET /api/planning-summary`. Origin estrito no POST, corpo JSON e filtros allowlist, chaves de idempotência por titular, validação de datas/centavos e 404 para recursos de outro usuário. Interface responsiva desktop/mobile com histórico e painel de margem; o panorama principal é atualizado após conversão. Intenções nunca fazem parte do extrato bancário ou de relatórios de caixa antes de um pagamento real.

Validação local: `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run f1:e2e`. O workflow `.github/workflows/f1-purchase-planning-local.yml` aplica migrações 0001–0014 em D1 descartável e verifica Chromium/Better Auth com dois usuários, inclusive reserva/retirada, conversão, pagamento posterior, exclusão e navegação mobile. [Parecer adversarial F1](docs/implementation/PURCHASE-INTENTIONS-F1-REVIEW.md).

**Fora do escopo:** compra automática, integração de e-commerce, compras parceladas/financiadas na conversão, edição retroativa de intenções, transferências de reserva entre contas, bloqueio bancário por reserva, ML/IA obrigatória, previsão estatística de renda ou deploy remoto. Uma reserva virtual não bloqueia gastos reais.


## Simulação conservadora e planejada — F2 / SPEC-006 (Issue #27)

**Status:** [PR #49](https://github.com/carloshgalves/cashControl/pull/49) mesclada via merge commit `b64d9b66` em 23/11/2026; sem deploy remoto. A **F1 (#26/PR #48)** já está integrada em `main`. A F2 amplia **Planejamento → Simular cenários** sem adicionar tabelas ou migrar banco (usa somente views de F1/E2/cartões/obrigações).

A interface compara **Conservador** (apenas caixa atual e despesas futuras de obrigações/faturas existentes, sem renda futura) e **Planejado** (o mesmo cenário mais **somente** o valor ainda não recebido das expectativas de renda explicitamente cadastradas na E2, inclusive salários líquidos recorrentes informados, valores avulsos, adiamentos e reajustes salariais existentes). Valores de expectativas canceladas são removidos da projeção; recibos já vinculados à expectativa reduzem apenas a sua parcela futura e permanecem no saldo bancário atual. A ausência de emprego formal não cria salário automático. Estado E2 `confirmed` significa que o usuário confirmou a **expectativa**, não que o banco creditou dinheiro.

**Base temporal:** o saldo de abertura é o saldo bancário **atual**, mesmo quando o usuário seleciona datas distintas; não representa saldo histórico naquele dia. A F2 distribui hipoteticamente **somente saldos ainda abertos** de obrigações e faturas por vencimento, alocando atrasados no primeiro dia do período. Pagamentos efetivos já saíram do saldo atual e do devido, por isso **não** são descontados de novo. Dívidas com vencimento após o fim da simulação não se tornam saída bancária dentro do horizonte, mas continuam como passivo na margem. Limite: período com no máximo 367 dias.

**Margem projetada:** `saldo atual − obrigações abertas − faturas abertas − reservas ativas` na abertura. Ao supor o pagamento de compromisso, o caixa projetado cai e o passivo correspondente cai na mesma proporção, sem falsa segunda dedução da margem. A soma de **receitas explicitamente ainda esperadas** aumenta apenas a versão planejada e na data informada/adiada, não a conservadora. O calendário usa datas civis e centavos inteiros com BigInt; agregados de faturas podem superar o limite monetário de uma compra isolada sem perder precisão. O sistema destaca caixa/margem zerado ou negativo sem bloquear a simulação.

**Compra hipotética:** pode ser livre (informar preço, data de concretização e vencimento) ou associada a uma intenção F1 em `planning/reserved`. Se já houver uma reserva (total ou parcial), a simulação a libera **na data da compra hipotética** e cria o compromisso hipotético integral, sem somar ambos. Só na data de vencimento suposta o caixa modelado cai. Se a intenção foi excluída, convertida na vida real, pertence a outro titular ou apresenta preço incoerente, a simulação é rejeitada. Nenhuma compra, reserva, pagamento, baixa ou expectativa é gravada. O fluxo **real** de compra continua sendo a confirmação da F1, separada da F2.

**Atenção a lançamentos não vinculados:** quando existem entradas reais sem vínculo a uma expectativa E2, o sistema alerta que o cenário planejado **pode superestimar valores** caso essas entradas já correspondam a previsões ainda abertas. Não presume vinculação, não subtrai receitas incertas silenciosamente e não expõe dados de outros usuários. O correto é usar a associação opcional de recebimentos existente em **Rendas**.

**API:** `POST /api/planning/simulate` recebe `from`, `to` e `hypothetical` opcional (`amount`, `purchaseOn`, `dueOn`, `intentionId` opcional). Apesar do método POST, é **estritamente read-only**, usado para enviar parâmetros privados, sem gravar dados. Better Auth (titular real), Origin e JSON allowlist, valores exatos em centavos, 404 para intenção estrangeira, 400 para datas ou valores inválidos, 409 para snapshot inconsistente e 413 para agregados/volume não seguro. Resposta inclui indicadores atuais, dois cenários e pontos cronológicos, com estado de recebimento das expectativas.

**Testes:** `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, `npm run f2:e2e`. Workflow `.github/workflows/f2-scenarios-local.yml` reutiliza D1 local descartável com migrações até 0014 e Chromium/Better Auth Alice/Bob. Testa ausência de caixa/emprego, vencimentos e pagamentos parciais, faturamento de cartão, reserva parcial/total, renda cancelada/adiada e parcialmente recebida, precisão com faturas consolidadas, cenário negativo e zero, simulação sem escrita, exports e isolamento entre titulares. [Parecer adversarial F2](docs/implementation/SCENARIOS-F2-REVIEW.md).

**Limites:** sem reconstrução de saldo histórico, garantia de recebimento, projeção estatística de renda extra (F3/#28), score de crédito, recomendação de empréstimo, cálculo de juros, financiamento/parcelamento hipotético ou compra automática. A F2 supõe pagamento de obrigações no vencimento, mas não é agenda de débito automático, não conhece a ordem intradiária de entradas/saídas e não grava transações.
