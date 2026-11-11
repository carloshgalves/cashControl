# C3 / SPEC-003 — Exportação XLSX/PDF (entrega vertical em revisão)

**Issue:** [#18](https://github.com/carloshgalves/cashControl/issues/18). **PR:** [#40](https://github.com/carloshgalves/cashControl/pull/40). **Base:** `main` após as PRs #38/#39. **Estado:** backend, interface, testes e API implementados na branch da PR; entrega **Draft para revisão visual humana e merge manual**. **Sem merge, Cloudflare remota, D1 remoto ou deploy.**

## Contrato HTTP e autenticação

`GET /api/reports/export?format=xlsx&from=2026-11-01&to=2026-11-30&asOf=2026-11-11&status=all`

Alternativas: `format=pdf`, filtros por `status=realized|planned|pending|overdue|canceled|all` e `accountId` opcional, **proveniente somente de conta do próprio titular**. O filtro `accountId` inclui a transferência se a conta for origem **ou destino**; obrigações sem conta vinculada são excluídas do escopo de uma conta isolada. O padrão sem `accountId` inclui todas as contas e obrigações do titular.

- Autenticação verificada via **Better Auth no backend** (titular da sessão, nunca de parâmetros ou headers). Falta de sessão = 401; ID de conta inexistente ou de outro titular = **404 indistinguível**; datas ou filtros inválidos/duplicados/desconhecidos = 400.
- Sem URLs persistentes ou compartilhamento público. O download é o corpo de resposta GET, com `Content-Disposition: attachment`, MIME correto e `Cache-Control: private, no-store`, `Pragma: no-cache`, `nosniff`.
- Datas são civis ISO; `asOf` torna o estado previsto/pendente/atrasado determinístico. O período filtra **datas dos eventos** e não cria saldos históricos inexistentes. O estado das obrigações representa o **saldo aberto atual**, não um snapshot retroativo do vencimento.
- O endpoint não grava no banco, não altera sessão, não usa armazenamento local dos usuários e não registra valores financeiros em logs.
- **Limites explícitos:** até **2.000 eventos** por arquivo. A consulta usa **um único SELECT da cronologia canônica** com `LIMIT 2001`, isolado por titular e, quando selecionado, por conta. Mais de 2.000 eventos ou PDF com quantidade excessiva de páginas = **HTTP 413**, sem exportação truncada. Recomenda-se reduzir período/escopo.
- Para exportação de todos os estados e contas, totais de caixa e obrigações no período são conciliados com o read model do dashboard. Se ocorrer divergência (por exemplo, escrita concorrente entre as duas leituras), **HTTP 409**, nunca documento silenciosamente contraditório. O banco permanece inalterado.

## Semântica financeira

O relatório apresenta **receitas efetivamente recebidas**, **saídas efetivamente pagas** (inclusive pagamentos de obrigações), **reembolsos efetivamente recebidos**, **transferências internas neutras** e **obrigações abertas não debitadas** em categorias distintas. Cancelamentos aparecem como eventos históricos de valor monetário zero, sem duplicar faturas nem reduzir o caixa. Saldo inicial de conta não é receita. O fluxo líquido usa centavos inteiros e é igual a entradas + reembolsos − saídas; não é o saldo bancário atual.

A coluna *Valor do evento* da planilha armazena número com formato monetário, não fórmula nem caixa agregado. É obrigatório respeitar a coluna `Tipo` e a tabela de totais para evitar somar erroneamente obrigações/transferências com despesas ou receitas.

## Estrutura dos arquivos

- **XLSX:** `src/backend/reports/xlsx.ts`, pacote OOXML Office Open XML com `[Content_Types].xml`, relations, `workbook.xml`, `sheet1.xml`, `styles.xml`. ZIP armazenado com tamanhos e **CRC32**, sem depender de pacotes adicionais (custo/compatibilidade Workers). Uma planilha `Histórico financeiro`, cabeçalho congelado, largura de colunas, títulos, data/filtro/escopo, eventos e resumo em R$. Textos de usuário sempre `inlineStr`, **sem avaliação de fórmulas**: `=HYPERLINK(...)` permanece texto. Unicode completo preservado na planilha.
- **PDF:** `src/backend/reports/pdf.ts`, PDF 1.4 paisagem com paginação, título, filtros, data civil, resumo de valores, eventos com rótulos e numeração de páginas. Codificação WinAnsi preserva os caracteres habituais em português; caracteres não representáveis na fonte padrão são identificados **explicitamente** como `[U+XXXX]` (a exportação XLSX preserva o caractere original). Nunca há links/scripts de PDF, apenas texto e desenhos. Quantidade anormal de páginas retorna 413, sem documento parcial.
- Ambos exportam somente dados da consulta autenticada. Strings fornecidas pelo usuário são convertidas em XML seguro ou operandos PDF hexadecimais, sem execução.

## Revisão adversarial — achados e correções

| Finding | Correção | Evidência |
|---|---|---|
| C3-T01 — teste de estado futuro esperava `Pendente` em vez de `Previsto` | Corrigida premissa do teste; regra financeira preservada | primeira execução detectou falha, ciclo seguinte passou |
| C3-F01 — largura em PDF confundida com quantidade de caracteres | Corrigido wrap pela largura real em pontos: descrição e conta legíveis | teste de 85 registros/páginas |
| C3-F02 — ZIP com campo de data DOS inválido em alguns leitores | Definido timestamp ZIP válido 1980-01-01 e congelada a linha de cabeçalho correta | teste independente de integridade CRC32 |
| C3-F03 — PDF substituía silenciosamente Unicode não WinAnsi por `?` | Identificadores visíveis `[U+XXXX]`; XLSX mantém o texto Unicode original | teste de nomes portugueses e emoji |
| C3-F04 — PDFs extensos ultrapassavam teto de páginas sem erro de relatório claro | Limite explícito e conversão para `ReportTooLargeError` / HTTP 413 | teste de relatório alto e confirmação de banco intocado |
| C3-S01 — fórmula fornecida em descrição poderia ser executada no Excel | Valores sempre `inlineStr`, escapados como XML e sem célula `<f>` | teste `=HYPERLINK` |
| C3-S02 — exportação de outra conta/titular | `getAccount` no contexto da sessão; proprietário definido somente pelo Better Auth | teste A/B de API e navegador |

**Limites da revisão:** verificações programáticas de estrutura e conteúdo; o PDF usa fonte padrão e a planilha não contém macros. A interface e os **botões reais** foram exercitados em Chromium, mas revisão visual humana e aceitação de produto continuam pendentes. Auditoria WCAG formal, Cloudflare hospedada e teste de carga não foram executados.

## Evidência de execução

Pipeline: `npm ci`, `npm run typecheck`, `npm run ui:check`, `npm run ui:build`, `npm test`, `npm run ui:test`, migrações **0001–0006 em D1 local**, `npm run ui:e2e` em Chromium sobre a **build existente de produção** (login e duas sessões Better Auth reais), incluindo endpoint PDF/XLSX e proteção de conta alheia. Todos os testes usam usuários fictícios e banco descartável.

**[GitHub Actions #43073453008 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43073453008)**: **126/126 testes backend**, **9/9 frontend**, TypeScript/build aprovados, D1 local 0001–0006 aplicado, `C3_REAL_AUTH_EXPORT_PASS` e `UI_BROWSER_E2E_PASS` em Chromium com Better Auth real e dois usuários fictícios.

## Interface, revisão adversarial e homologação local

- Ação **Exportar** no cabeçalho (desktop/mobile) e **Exportar filtro** na trilha, preservando sua situação selecionada.
- Modal com período sugerido (mês exibido), datas civis editáveis, conta, situação, botões XLSX/PDF e aviso de privacidade; consulta servidor com filtros completos, não apenas a página exibida.
- `fetch` same-origin com cookie verificado, `cache: no-store`, validação de MIME e assinatura PDF/ZIP antes de preparar o download. Não há armazenamento local de dados financeiros, nem URL pública persistida.
- Erros de filtros, sessão, conta, reconciliação e limite (400/401/403/404/409/413) oferecem feedback; geração bloqueia concorrência. Requisições são canceladas ao fechar a interface. Os blobs privados são revogados no fechamento do modal ou após 15 segundos.
- Testes de cliente cobrem URLs, datas, filtros, identidade ausente, sessão, formato, assinaturas, erro e abort; testes de Chromium usam **botões reais** e verificam PDF/XLSX, filtro conta/situação, 413 sem download, limpeza do blob, isolamento Alice/Bob e mobile.

**Achados corrigidos:** construtor TS incompatível com `--experimental-strip-types` do Node 22; retenção temporária de URL de blob durante troca de sessão; validação de ano no cliente alinhada ao backend (1000–9999).

**[GitHub Actions #43087645571 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43087645571)**: 126/126 backend, 15/15 frontend, typechecks, build, D1 local e Chromium (`C3_UI_DOWNLOAD_PASS`, `C3_UI_TENANT_PASS` e `UI_BROWSER_E2E_PASS`). Uma rodada final da documentação também será executada.


## Segunda revisão adversarial — findings de apresentação corrigidos (11/11/2026)

| Finding | Remediação | Evidência |
|---|---|---|
| C3-PDF-P1A — título com 120 `W` invadia a coluna seguinte | Layout das seis colunas com limites explícitos; larguras calculadas pelas métricas AFM de Helvetica/Helvetica-Bold para ASCII e limite conservador para demais glifos WinAnsi; quebra em limites reais de pontos | Teste de 120 `W` na descrição, medição independente da largura dos glifos e preservação de todos os caracteres |
| C3-PDF-P1B — nome de conta com 80 `W` cortava o cabeçalho | Metadados do escopo e situação quebrados em múltiplas linhas, com resumo/tabela posicionados dinamicamente | Teste de escopo restrito à conta de 80 `W`, sem caracteres perdidos nem exceder a página |
| C3-META-P2 — status interno `all`/`overdue` visível | Status localizados nos metadados XLSX e PDF (ex.: `Todas as situações`, `Atrasado`); eventos já tinham traduções | Testes reais de conteúdo dos dois formatos |
| C3-NAME-P2 — relatórios com filtros diferentes recebiam o mesmo nome | Nome inclui período, situação e indicação `todas-contas`/`conta-selecionada`, além de sufixo aleatório não identificador; sem usuário, nome de conta ou UUID | Testes cliente/servidor de escopo e unicidade dos downloads |

**Robustez adicional:** eventos cujo texto não cabe numa página são continuados na próxima sem repetir o valor monetário como nova ocorrência. Os caracteres fora de WinAnsi permanecem representados por marcadores `[U+XXXX]` atômicos, mesmo na quebra de linha. O limite de 450 páginas e o HTTP 413 continuam, com fixture de volume extremo ajustada para exercitar o limite sob o novo layout.

**Ciclo de correções:** execuções intermediárias detectaram premissas obsoletas no teste de 455 páginas, chave de idempotência de fixture maior que o limite e filtro de conta ausente do caso adversarial do cabeçalho. Fixtures ajustadas sem enfraquecer as garantias: teste exige preservação de 120 `W`/80 `W`, verifica posições e valida continuação Unicode.

**[GitHub Actions #43092783770 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43092783770)**: 129/129 testes backend, 16/16 testes frontend, TypeScript, build, migrações D1 locais e Chromium com Better Auth de duas identidades (`C3_REAL_AUTH_EXPORT_PASS`, `C3_UI_DOWNLOAD_PASS`, `C3_UI_TENANT_PASS`, `UI_BROWSER_E2E_PASS`).

**Conclusão deste escopo:** nenhum finding acionável reproduzível restante nos quatro itens da revisão. Sem auditoria formal de acessibilidade, impressão real em papel, deploy Cloudflare ou avaliação de carga; PR permanece Draft até aprovação de produto.

## Gate restante

PR #40 permanece **Draft** até revisão visual humana e merge manual. Issue #18 permanece aberta até integrar em `main`. Produção hospedada, WCAG formal, carga e Cloudflare remota fora do escopo deste gate.
