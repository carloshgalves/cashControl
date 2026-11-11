# SPEC-003 C2 — Trilha financeira e avisos in-app de vencimento

**Escopo:** Issue [#17](https://github.com/carloshgalves/cashControl/issues/17), protótipo visual aprovado antes da codificação. Entrega vertical em `feat/c2-financial-trail-alerts` baseada em `main` após PRs #36/#37. **Sem deploy, sem D1 remoto, sem merge automático.**

## Contrato de produto

O usuário visualiza uma trilha cronológica dos **eventos financeiros confirmados** e das obrigações ainda pendentes, com filtros e detalhes. A representação distingue claramente três dimensões:

- **Realizado:** entrada/despesa efetivamente registrada, pagamento de obrigação, devolução de dinheiro vinculada à despesa original ou transferência entre contas próprias. A transferência é um evento único e não cria receita ou gasto.
- **Previsto / pendente:** **somente vencimento de obrigação realmente cadastrada**, com valor **ainda pendente**. Não é dinheiro pago e não altera o saldo. Uma obrigação em atraso aparece como `overdue`, sem sofrer baixa presumida. Não há previsão inferida de salários ou créditos.
- **Cancelado:** evento imutável de cancelamento com valor de caixa **zero**, enquanto o compromisso cancelado deixa de integrar vencimentos ativos. Obrigação integralmente quitada também deixa de ser vencimento pendente, mas seus pagamentos permanecem na trilha de eventos reais.

Os estados apresentados são os **estados atuais** do livro financeiro: consultar um mês anterior não recria uma fotografia histórica das obrigações naquela data.

## Endpoints

`GET /api/trail?from=2026-11-01&to=2026-11-30&asOf=2026-11-11&status=all&limit=30&offset=0`

Resposta: `{events:[{id,kind,status,timing,date,title,amountCents,accountId,obligationId,relatedMovementId}], hasMore, limit, offset, period, asOf, status}`. Ordenação **global**, da data anterior à posterior, e desempate determinístico por criação, tipo e ID. Filtros: `all`, `realized`, `scheduled`, `pending`, `overdue`, `canceled`; paginação de 1 a 100 eventos e offset limitado. Cada linha de consulta restringe `owner_user_id` derivado da sessão verificada Better Auth. Sem IDs de outro titular em parâmetros nem headers aceitos como autenticação.

`GET /api/due-alerts?asOf=2026-11-11&limit=30&offset=0`

Retorna apenas obrigações com `outstanding_cents > 0` e vencimento de **hoje até 10 dias adiante**, inclusivos, com `daysUntilDue` e `stage`:

| Distância civil do vencimento | Etapa | Exibição |
|---|---|---|
| 10–6 dias | `D-10` | Aviso inicial |
| 5–1 dias | `D-5` | Aviso prioritário |
| 0 dias | `TODAY` | Vence hoje |
| Passado ou mais de 10 dias | Sem alerta D-10/D-5 | Pode aparecer na cronologia como atraso/obrigação |

O campo `asOf` é uma data civil validada no servidor; a UI utiliza a data local do navegador. Esse contrato facilita testes determinísticos sem supor o fuso horário do servidor. Não há job, push, SMS ou e-mail. As consultas não criam nem alteram saldos ou alertas persistidos.

**Validações HTTP:** autenticação pela sessão Better Auth, origem canônica, `GET` apenas, cache `no-store`, datas impossíveis/invertidas rejeitadas, parâmetros desconhecidos ou duplicados rejeitados, limites obrigatórios de paginação. Erros SQL não são expostos ao cliente.

## Arquitetura e interface

- `src/backend/trail/trail.ts`: leitura SQL por `UNION ALL` dos movimentos, transferências, obrigações pendentes e cancelamentos. **Uma ordenação/paginação após o conjunto inteiro**; não faz concatenação de páginas de origens diferentes, que perderia eventos. Histórico de reembolso e pagamento mantém vínculo com o evento original.
- `src/backend/http/accounts-handler.ts` e `src/worker.ts`: endpoints isolados por sessão no mesmo middleware HTTP seguro do restante da aplicação.
- `web/src/TrailView.tsx` e `web/src/trail.css`: tela aprovada com faixa contextual de avisos D-10/D-5, trilha horizontal clicável, filtros, detalhes do evento, calendário selecionável e ação de pagamento real para obrigação ativa. O carregamento é paginado no backend; páginas recuperadas permanecem acessíveis na trilha, sem ocultar eventos após um limite de exibição arbitrário.
- `web/src/App.tsx`: opção dedicada na navegação desktop/mobile; agenda e dashboard anteriores preservados. A saída da sessão também reinicia o estado visual de seleção, período, mensagens e navegação, impedindo compartilhar avisos da sessão anterior com outro usuário.
- Não há migração adicional: os dados já são provenientes das tabelas/vistas canônicas das migrações 0001–0006, sem duplicar saldos.

## Ciclo implementação → revisão adversarial → correção → repetição

| ID | Finding observado | Correção e re-review |
|---|---|---|
| C2-T01 | Seis testes novos criavam idempotencyKeys com espaços/acentos inválidos | Sanitização restrita às fixtures; **não alteradas** validações do produto |
| C2-T02 | Seletor de pagamento no Chromium correspondia a dois botões | Seletor associado explicitamente ao diálogo aberto, sem enfraquecer critérios de saldo |
| C2-F01 | Após logout Alice → login Bob, a UI mantinha aba selecionada e aviso anterior (embora dados financeiros estivessem isolados) | Reset de mês/aba/seleções/mensagens ao trocar usuário; E2E verifica isolamento A/B e ausência de aviso antigo |
| C2-F02 | A ordem inicial da trilha era decrescente, enquanto protótipo aprovado mostrava acontecimentos → próximos eventos | Ordenação SQL ascendente, com testes de ordem e paginação global |
| C2-F03 | Tela repetia o título editorial da página | Removido o título superior redundante apenas na aba da trilha; E2E exige um único título visível |
| C2-F04 | Aviso selecionado poderia não ter detalhe se evento estivesse fora da página inicial; após pagamento, um snapshot local poderia ficar desatualizado | Detalhe derivado do alerta **mais recente do servidor**, fallback seguro; nenhuma pendência antiga inventada |
| C2-F05 | Carregamento posterior podia ocultar eventos já recuperados e botão de retry nem sempre reconsultava | Todas as páginas efetivamente carregadas aparecem na trilha; reconsulta explícita para erro de eventos/avisos |

A bateria também inspecionou: **fronteira de 10/5/0 dias**, ano bissexto e virada de ano; pagamentos integrais e parciais; reembolsos que reabrem pendência; cancelamento sem débito; dados de Alice/Bob; datas inválidas, filtros/offset forjados; ausência de duplicidade de receita nas transferências; sem vazamento por logs.

## Evidência final executada

**[GitHub Actions #43064915668](https://github.com/carloshgalves/cashControl/actions/runs/43064915668) — SUCCESS**, branch C2 após as correções finais:

- `npm ci` com lockfile sem instalar bibliotecas adicionais.
- `npm run typecheck`, `npm run ui:check`, `npm run ui:build` — aprovados.
- `npm test` — **117 passed, 0 failed**.
- `npm run ui:test` — **5 passed, 0 failed**.
- Migrações 0001–0006 aplicadas ao **D1 local descartável** via Wrangler.
- `npm run ui:e2e` no **Chromium headless contra build de produção**: `TRAIL_BROWSER_E2E_PASS` e `UI_BROWSER_E2E_PASS` com Better Auth real, dois usuários, alertas D-5, filtros, cancelamento, pagamento parcial, atualização da pendência, login/logout, navegação mobile sem overflow e nenhuma mensagem da sessão A na sessão B.
- Workflow com `permissions: contents: read`, sem acesso à Cloudflare hospedada e sem usar dados reais.

**Parecer técnico:** no escopo e nos cenários executados, não permanece finding acionável reproduzível após o último ciclo. Isso não substitui auditoria formal WCAG, homologação de produção e testes de carga.

## Gates pendentes

**PR para revisão/merge manual**, Issue #17 permanece aberta até merge. Sem deploy. Alertas são passivos e calculados no momento da leitura: não notificam quando o site está fechado. Integração push/e-mail/SMS, regras de previsão de receitas não cadastradas e sincronização offline estão fora da Issue #17.
