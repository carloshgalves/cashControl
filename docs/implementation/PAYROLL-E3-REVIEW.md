# SPEC-005 / E3 — Remuneração-base, demonstrativos e descontos

**Ticket:** [Issue #24](https://github.com/carloshgalves/cashControl/issues/24). **Épico:** #5. **Base:** `main` após PR #45 (E2). **Branch:** `feat/e3-payroll-breakdowns-revisions`. **Gate:** PR Draft, sem merge/deploy.

## Escopo aprovado e regras

DEC-007/008/009: vínculo empregatício, composição remuneratória e periodicidade permanecem independentes. Salário líquido é a base das expectativas; bruto é opcional, com descontos discriminados se informado, sem checkbox para habilitar. Uma variação permanente requer data de vigência e motivo; uma verba pontual (horas extras, gratificação, outras verbas ou redução) só integra a competência que a pessoa explicitamente descreveu.

**Exemplo de aceite:** salário líquido-base até outubro de R$ 2.500; reajuste permanente com início 01/11 para R$ 2.750; novembro com adicional de horas extras de R$ 250 e líquido da competência de R$ 3.000; dezembro permanece com base R$ 2.750, mesmo sem lançar salário novo. Outubro continua R$ 2.500. Nenhuma dessas alterações cria dinheiro em conta. Caso a entrada bancária real exista, continua dependente da API original de movimentos/associação E2.

**Conciliação:** `grossDifferenceCents = bruto - soma dos descontos discriminados - líquido informado`; `null` quando o bruto não foi informado. `grossStatus`: `not_provided`, `matched` (apenas conferência matemática) ou `pending`. Descontos com rótulos como INSS/IRRF/consignado não são calculados automaticamente nem geram débito em banco. `componentsDifferenceCents = líquido informado - base registrada ao criar o demonstrativo - soma de componentes pontuais assinados`; diferenças também são visíveis e não reconciliadas silenciosamente.

## Modelo, autorização e integridade

- Migração `0012_salary_composition.sql`: `salary_base_revisions` com data efetiva, valor líquido, motivo e titular; `salary_period_statements` com versões append-only de líquido, bruto opcional, descontos e componentes JSON validados, **base_net_at_entry_cents imutável**. O SQL valida o snapshot-base frente à fonte/revisões vigentes no instante do INSERT e impede história reescrita via UPDATE/DELETE/REPLACE. Uma revisão com vigência anterior ou igual à última vigente é recusada. Replays idempotentes do mesmo payload continuam válidos.
- Migração não modifica o esquema E2 existente ou seus registros. `income.ts` aplica sobreposição determinística da versão de salário-base vigente para a **data original da competência** (não a nova data bancária após adiamento). Se houver demonstrativo explícito da competência, seu líquido declarado prevalece **na previsão**. Uma expectativa E2 materializada antes do reajuste conserva seu valor-base histórico físico, mas a agenda mostra a remuneração vigente, com trilha de versões.
- Alteração de composição registrada posteriormente conserva snapshots de cada versão: uma revisão salarial tardia não altera retroativamente a análise de componentes de um demonstrativo já emitido. Se um usuário registrar outra versão do demonstrativo, a nova versão torna-se atual para o calendário sem apagar as anteriores.
- Autorização é derivada da sessão Better Auth do Worker. FKs compostas por titular e validações de origem, chave, ciclo, campos, JSON, tamanho e paginação previnem cross-tenant, CSRF e múltiplos registros não intencionais. Valores em centavos por parse decimal e somas com BigInt, sem floats para o cálculo remuneratório.
- A E3 não altera `posted_cash_movements`, saldos, histórico de pagamento real, `financial_obligation_payments` nem exportações de fluxo real. O pagamento de obrigação por desconto em folha só será feito na E4 após confirmação, sem duplo débito.

## Findings encontrados, correções e regressões

| Finding | Impacto | Remediação |
|---|---|---|
| Suíte E2 de integração não aplicava migração 0012 | Falhas falsas em consultas de calendário | Atualizar fixtures de todas as camadas E2; CI completo |
| Teste de débito consultava tabela antiga de obrigações | Falha de teste | Validar tabela efetiva `financial_obligation_payments` |
| Demonstrativo posterior a um reajuste alterava retroativamente base de comparação de versão anterior | **Achado de auditabilidade** | Snapshot `base_net_at_entry_cents` imutável com CHECK via trigger SQL; regressões antes/depois do reajuste e replay antigo |
| Tela exibia totais, mas não o nome e valor de cada desconto/adicional salvo | Achado de rastreabilidade/UX | Composição detalhada e histórico de valores/bruto/motivos visíveis, testados no Chromium |
| Fonte sem parte fixa recorrente podia oferecer ação inválida de reajuste | Controle de UX | Desabilitar reajuste com mensagem explicativa |
| Limpar salário bruto mantendo descontos preenchidos deixava formulário inválido | UX e contrato | Descartar descontos ao esvaziar bruto, preservando o modo líquido somente |
| Líquido e base + componentes pontuais diferentes não recebiam destaque contextual | Risco de conciliação enganosa | Banner explícito de diferença não conciliada, sem ajuste automático |
| Gross − discounts insuficiente poderia parecer conciliado | Risco contábil | Status `pending`, cálculo exato, banner e versões imutáveis |

## Testes

- CLT: R$ 2.500 outubro → R$ 2.750 novembro/dezembro; hora extra R$ 250 só em novembro, sem alterar dezembro.
- Bruto ausente: somente líquido é válido; bruto preenchido com descontos insuficientes fica `pending`, com INSS/IRRF/consignado detalhados; combinação completa gera `matched` apenas matemático.
- Múltiplas composições no mesmo ciclo preservam versões, base ao registrar e razões; `INSERT OR REPLACE`, UPDATE, DELETE e snapshot-base forjado são rejeitados; idempotência e vigência conflitante, rollback injetado na materialização E2→E3.
- A/B (usuário estrangeiro 404), Origin POST, filtros duplicados, JSON inválido, valor não seguro, sinal de componentes, e nenhuma mutação de caixa/obrigações. Comparações de dashboard, timeline e exportações XLSX/PDF inalteradas; nenhum dado financeiro é logado intencionalmente.
- Chromium com Better Auth/D1 real local: cria fonte, escolhe competência, registra reajuste, líquido somente, horas extras, bruto/INSS/IRRF insuficientes e depois completos, lê histórico, confirma que caixa permanece zero, testa viewport mobile e isolamento Alice/Bob.

**Limites:** proposta de interface usa formulário contextual na área Rendas, com líquido e bruto lado a lado, sem checkbox. E4/#25 cuidará da retenção confirmada como baixa de obrigação, com natureza não-bancária e sem débito em duplicidade. A E3 não simula tributos/holerite, não conecta empregador, não faz retroatividade complexa, não implementa edição/encerramento de fonte nem deploy remoto. Revisão de acessibilidade/carga em produção e aceite visual humano permanecem separados.

**Parecer atual:** não foram identificados findings acionáveis remanescentes nos caminhos verificáveis depois das correções. O aceite exige **CI verde no último SHA, revisão visual humana e merge manual**; manter a Issue #24 aberta até merge. Ausência de findings no recorte testado não é prova universal de ausência de defeitos.
