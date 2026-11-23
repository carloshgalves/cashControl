# E2 / SPEC-005 — Revisão adversarial de recorrência e renda prevista

**Issue:** #23; **parent:** #5; **base:** `main` após merge da PR #44 (E1); **branch:** `feat/e2-income-sources-expectations`; **gate:** PR Draft, sem merge/deploy.

## Contrato financeiro e decisões de produto

DEC-004 define fontes fixas, variáveis, mistas e avulsas, sem impor periodicidade à receita eventual. DEC-007 separa natureza do vínculo, composição remuneratória e frequência informada. A implementação preserva rigorosamente as três dimensões. Apenas parcela **fixa líquida positiva** informada por usuário, de fonte fixa/mista com período semanal, quinzenal, mensal ou personalizado, gera automaticamente **expectativa**, nunca saldo. Remuneração variável/avulsa e fontes sem período não produzem receita artificial ou média estatística. Para elas, o usuário registra expectativas pontuais com data/valor explícitos. A natureza profissional não obriga uma remuneração fixa e freelancer pode receber valores recorrentes informados.

Datas civis usam calendário gregoriano: recorrência mensal ancora no dia escolhido e ajusta ao último dia de meses menores, sem acumular deslocamento. Intervalos em dias são exatos; primeira e última datas restringem geração. Leitura `GET` é determinística, sem cron/banco de eventos sintéticos ou escrita; intervalo máximo 367 dias, cotas de resultados com erro explícito (413) em vez de exibir resumo parcial.

Expectativa tem identidade estável `sourceId + occurrenceKey`. `planned` significa prevista; `confirmed` significa apenas **expectativa confirmada**, jamais crédito bancário. `delayed` conserva origem e registra nova data; `canceled` é terminal, com motivo opcional, sem criar estorno ou apagar caixa já recebido. Histórico de eventos é append-only. Receita efetiva só é registrada pelo endpoint original `/api/movements`; depois o usuário pode associá-la, de forma opcional, com total e diferença centesimal auditáveis. Associação nunca posta um segundo movimento, débito, depósito ou previsão no fluxo real. Cada entrada pode pertencer a uma expectativa por titular; créditos oriundos de reembolsos são excluídos. O mesmo recebimento pode ter proveniência analítica em um trabalho E1 sem duplicar dinheiro no caixa.

## Persistência / segurança

- `0011_income_expectations.sql`: `income_sources`, `income_expectations`, `income_expectation_events`, `income_receipt_links` e visão `income_expectation_totals`; chaves compostas por titular, FKs, índices e guards de UPDATE/DELETE/INSERT OR REPLACE. Inserção SQL forjada de ocorrência fixa (data ou valor incompatível) falha mesmo fora da API. Status repetido sem mudança efetiva é recusado; tentativa posterior a cancelamento também.
- Ao atuar em uma recorrência ainda virtual, a materialização da expectativa e o evento/vínculo são gravados no **mesmo batch D1**. Falha injetada entre as duas gravações prova rollback; concorrência usa unicidade, precondições e replay por chave.
- `income_receipt_safe_total` protege cada associação para que o total recebido por ocorrência não ultrapasse `Number.MAX_SAFE_INTEGER` centavos antes de persistir. UI e serviço calculam diferença assinada exata; uma superação da previsão não some do relatório analítico.
- HTTP/Worker: autorização a partir da sessão Better Auth verificada, Origin estrito nos POSTs, JSON limitado e filtros allowlist, limite de paginação, 404 sem enumerar fonte estrangeira, conflitos como 409. Logs não imprimem PII ou valores particulares.
- Fonte e condições iniciais são imutáveis nesta etapa; não foi inventada semântica de suspensão, término retroativo, reajuste ou bruto/desconto além do que DEC-007 autoriza. `endOn` opcional na criação. Mudanças no salário-base por vigência, extras e folha estão em E3/#24.

## Findings acionáveis tratados no ciclo implementa → revisa → corrige

| Achado | Correção / regressão |
|---|---|
| Vínculo financeiro duplicado retornava erro genérico do SQLite | Conflito E2 tipado (409) e tentativa da mesma receita em expectativas distintas |
| Replay de uma confirmação antiga após adiamento podia apresentar estado obsoleto/rejeitar uma tentativa idempotente | Consultar operação original pela chave antes do estado atual; testes de replay |
| Associações acumuladas poderiam ultrapassar limite inteiro seguro | Guard SQL pré-inserção; 1.000 lançamentos máximos + rejeição do 1.001º |
| Falha entre materializar expectativa e vincular entrada poderia deixar evento órfão | Batch D1 atômico; trigger de falha injetada e retry |
| Calendário mensal e ciclos especiais poderiam produzir datas inexistentes ou presumidas | Clamping civil de fim de mês, semanas/quatorzenas/custom, endOn e teste de calendário vazio |
| Estado repetido sem mudança e ocorrência SQL forjada | Guards de estado, data e valor no SQLite |
| Crédito de reembolso poderia ser confundido com salário | Validação antes do vínculo, guard SQL nos dois sentidos |
| UI podia mostrar saldo pendente de expectativa cancelada como crédito exigível e esconder recebimento superior ao previsto | Variação recebida − prevista com sinal; aviso explícito de cancelamento não exigível |
| E2E inicialmente exercia o vínculo apenas via API | Fluxo real no formulário React de associação de entrada, com Better Auth e D1 local |

## Verificações e limites de evidência

Testes determinísticos de calendário CLT, freelancer 0/1/3 em semanas distintas, meses sem eventos, salário fixo de freelancer e salário variável de empregado, adiamento, cancelamento, idempotência, rollback, cross-user, resumo de caixa/timeline/XLSX/PDF, concorrência, reembolso e limites elevados. Chromium verifica cadastro pela tela, confirmação sem caixa, freelancer manual, associação de recebimento, mobile e A/B com sign-out. Compilação TypeScript, Vite e migrações 0001–0011 via Wrangler D1 local; não houve deploy remoto ou dados reais.

A revisão é limitada às invariantes e cenários exercitados. Não certifica carga em Cloudflare remoto, acessibilidade integral, exclusões administrativas, backup externo ou inspeção visual humana. E3, edição/encerramento/suspensão de fontes, benefícios, horas extras e retenções na folha precisam de contrato específico; previsões históricas automáticas ficam no ticket F3.

**Portão:** último SHA CI verde, revisão adversarial sem achados de código restantes, revisão visual/aceite humano e merge manual; Issue #23 permanece aberta até integração em `main`. **Não** publicar, migrar banco remoto ou alterar dados reais neste ticket.
