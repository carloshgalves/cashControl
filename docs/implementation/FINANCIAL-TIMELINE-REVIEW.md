# C2 / Issue #17 — Trilha financeira e avisos de vencimento

**Data da revisão:** 11/11/2026. **Referência:** [Issue #17](https://github.com/carloshgalves/cashControl/issues/17), SPEC-003/C2. **Base:** `main` após a integração da PR #37. **Estado:** fatia vertical backend + frontend implementada, revisada e testada localmente; **sem deploy, migração adicional ou merge automático**.

## Contrato funcional aprovado

O cashControl passa a ter uma **Trilha financeira** com eventos selecionáveis num eixo cronológico visual, detalhes contextuais, filtro de estado e navegador de datas, sem replicar uma planilha financeira.

As origens dos eventos são os dados do próprio titular autenticado:

- **Realizado:** entradas e saídas confirmadas, pagamentos de obrigações, devoluções efetivamente recebidas e transferências internas. Cada evento aparece **uma única vez**. Uma baixa de obrigação não gera um segundo lançamento de saída na trilha; uma devolução vinculada não se transforma em renda fictícia; transferências entre contas próprias não são entrada ou despesa.
- **Previsto:** vencimento futuro de uma obrigação com valor ainda pendente. Não constitui caixa debitado nem receita/compra projetada.
- **Pendente:** obrigação com saldo em aberto cujo vencimento é hoje ou já passou.
- **Cancelado:** evento histórico de cancelamento na data do cancelamento e com **zero fluxo de caixa**; obrigação cancelada não reaparece como vencimento ativo.
- **Quitado:** os pagamentos confirmados permanecem como histórico, mas não há evento de obrigação pendente nem aviso depois de a pendência ser zero.

Não existem projeções de salário, compras ou valores futuros inventados; o único sentido de “previsto” nesta versão é **compromisso financeiro já registrado com vencimento futuro**.

## Datas e alertas D-10 / D-5

Os avisos **in-app** derivam do valor **ainda pendente** na view canônica `financial_obligation_balances` e do dia civil de referência `asOf`.

| Diferença vencimento − asOf | Situação |
|---|---|
| 11 dias ou mais | Sem aviso |
| 10 a 6 dias | D-10 |
| 5 a 0 dias | D-5, com “vence hoje” em D0 |
| Data passada com saldo pendente | Atrasado |

As diferenças são calculadas em datas civis, com tratamento de fevereiro bissexto, sem subtrair horas ou pressupor UTC como data local. A aplicação envia `asOf` com o dia local do navegador; essa data afeta **somente os indicadores de exibição**, jamais titular, autorização, pagamentos ou saldos registrados. O dispositivo precisa manter relógio correto para alertas corretos; preferência configurável de fuso é tema futuro.

Os alertas aparecem no panorama e na trilha. É possível selecioná-los, abrir os detalhes da obrigação, inclusive se ela vence fora do mês atual, e registrar uma **baixa efetiva** pelo modal existente. Não há envio externo, push, e-mail, SMS ou job agendado.

## API e escopo

`GET /api/timeline?from=2026-11-01&to=2026-11-30&asOf=2026-11-11&status=all&limit=30&offset=0`

- `status`: `all | realized | pending | planned | canceled`.
- `events[]`: `id`, `date`, `kind`, `status`, `title`, `amountCents`, `accountId`, `obligationId`, `relatedId`.
- `hasMore` e `offset` para paginação. `limit` por padrão 30, teto 100; `offset` até 1.000.000.
- Ordem cronológica determinística **crescente** (esquerda → direita no eixo aprovado); empates por `created_at` e `id`.
- Um só SELECT com `UNION ALL`, composto de consultas **todas filtradas por `owner_user_id` da sessão**. Leituras não alteram ledger nem mantêm totais derivados persistidos.

`GET /api/alerts?asOf=2026-11-11&limit=20&offset=0`

- Avisos do titular com `obligationId`, `title`, `dueOn`, `outstandingCents`, `daysUntil`, `level`; `hasMore`, `offset`, `asOf`.
- Obrigações quitadas e canceladas não aparecem, e pagamentos parciais ajustam imediatamente o valor do aviso.
- Avisos próximos aparecem antes dos atrasados no resultado paginado.

Todos os endpoints usam Better Auth e proteção same-origin do Worker; identidade nunca é recebida de URL, header ou body. `from`, `to` e `asOf` são datas ISO civis obrigatórias, calendariamente válidas, e `from <= to`; `status`, parâmetros repetidos, desconhecidos ou paginação inválida são recusados. Respostas `no-store`. **Não houve migração**: a timeline deriva exclusivamente das migrations 0001–0006.

## Implementação visual

- `web/src/Trail.tsx` e `web/src/trail.css`: trilha horizontal rolável, filtros acessíveis, cartão de detalhes contextual, alerta clicável e calendário com destaque por dia. Layout desktop e mobile, texto legível e informações além da cor.
- `web/src/trail.ts`: contrato HTTP tipado, rótulos em português para estados e tipos e formatadores para aviso e valores.
- `web/src/App.tsx`: nova seção de navegação, resumo de alertas no panorama, integração com modal de pagamento real e reset completo de estado temporário entre sessões.
- Conteúdo de eventos é escapado pelo React, sem armazenamento local de tokens ou dados financeiros. Falha de leitura do endpoint é apresentada como erro, não mascarada com números fictícios.
- Para listas grandes, novas páginas são pedidas explicitamente ao backend. O calendário informa que os marcadores refletem somente as páginas carregadas, evitando sugerir cobertura exaustiva indevida.

## Ciclo de revisão adversarial, achados e reparos

1. **C2-F01 — Literais SQL portáveis.** A versão inicial do read model usava aspas duplas para textos, que alguns builds SQLite tratariam como identificadores. Corrigido para literais com aspas simples antes do teste real.
2. **C2-F02 — Compatibilidade Node 22.** O teste da lógica visual carregou uma classe TypeScript com propriedades de parâmetro que o modo `--experimental-strip-types` não suporta. A classe `ApiError` foi convertida a campos explícitos, sem alterar comportamento HTTP.
3. **C2-F03 — Tipagem estrita de datas e filtro.** TypeScript identificou componentes opcionais de `split` e a entrada `status` recebida do HTTP. Corrigida a leitura da data por posições ISO fixas e mantida validação explícita do status contra enum permitido.
4. **C2-F04 — Estado entre sessões.** Chromium mostrou que um segundo usuário herdava a seção de navegação usada pelo primeiro após logout. Corrigido reset de vista, mês, semana, conta, dia, aviso e modal no encerramento e em novo login; dados A/B permanecem isolados.
5. **C2-F05 — Seleção de alertas assíncrona.** Clicar antes do carregamento da lista podia perder o evento selecionado; agora a seleção é preservada e reconciliada com a chegada de dados.
6. **C2-F06 — Dia sem eventos mostrava detalhe alheio.** O painel agora usa apenas eventos do dia selecionado; caso não exista, exibe estado vazio.
7. **C2-F07 — Aviso de outro mês.** O alerta continua exibindo detalhes reais e ação de pagamento mesmo quando o vencimento está fora do mês escolhido, sem mudar silenciosamente o período.
8. **C2-F08 — Ordem contrária ao design.** A consulta inicialmente ordenava do mais recente ao mais antigo. Corrigida para a trilha crescente do protótipo aprovado; teste específico garante a ordenação.
9. **C2-F09 — Cobertura mobile.** Acrescentado ensaio no Chromium de navegação mobile, filtro previsto em usuário sem contas, ausência de overflow horizontal do documento e logout real.

**Re-review:** após as correções, nenhum finding acionável reproduzível permaneceu dentro do contrato, da segurança e das interações exercitados pelos testes. Não equivale a auditoria universal ou homologação de produção.

## Evidência executada

**[GitHub Actions #43064714180 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43064714180)**

- `npm ci` com lockfile existente; `npm run ui:check`, `npm run ui:build`, `npm run typecheck` aprovados.
- `npm run ui:test`: **9 testes aprovados, 0 falhas**.
- `npm test`: **112 testes aprovados, 0 falhas**, com data civil bissexta, fronteiras D-10/D-5, cancelamento, pagamento parcial/integral, reembolso, transferência, A/B, filtros e paginação.
- D1 local migrado nas versões 0001–0006; nenhuma migration 0007 necessária.
- `UI_BROWSER_E2E_PASS`: Chromium real, bundle de produção via Vite Preview, Better Auth e D1 local, duas contas de usuário fictícias, pagamentos, alertas, filtros, cancelamento, navegação e logout desktop/mobile.
- Sem credenciais reais, Cloudflare remoto, métricas hospedadas de CPU ou deploy. Workflow somente leitura e sem CI disparado a cada commit de código.

## Gate final

Branch pronta para revisão e PR **Draft**, sem merge automático, pois o proprietário revisa e integra manualmente. A Issue #17 deve ficar aberta até o merge; qualquer desenvolvimento de notificações externas, previsões de renda ou agendamento contínuo requer decisão e issue próprias.
