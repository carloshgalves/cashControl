# Interface interativa cashControl — Implementação e revisão

**Data:** 10/11/2026. **Issue:** [#16](https://github.com/carloshgalves/cashControl/issues/16). **Base:** `feat/dashboard-read-model` (PR [#36](https://github.com/carloshgalves/cashControl/pull/36), ainda Draft). **Estado:** frontend implementado e homologado contra **Better Auth + Wrangler/D1 local**; nenhuma implantação Cloudflare remota, mudança em `main` ou merge automático.

## Decisão de UX aprovada

O usuário aprovou o protótipo interativo em vez de painéis genéricos de cartões ou planilhas: panorama editorial de saldo atual; exploração clicável de quatro intervalos semanais, com entradas/saídas distintas; calendário de vencimentos; contas interativas; lançamentos contextualizados; navegação desktop e mobile. O front-end mantém as dimensões do produto separadas: patrimônio registrado **agora**, movimentações **no mês escolhido**, obrigações **pendentes agora**. Estilo editorial com cores contrastantes e uso de texto além da cor para distinguir as ações.

## Tecnologia e contratos reais

- `web/src/App.tsx`: login seguro, saída, panorama, gráfico semanal, atividade, agenda e contas; modal para recebimento, despesa, transferência interna, conta e baixa parcial. Confirmações mostram saldo estimado e evitam lançar transferência como rendimento ou gasto.
- `web/src/finance.ts`: centavos exatos, normalização de quantias BRL, datas civis, semanas 01–07 / 08–14 / 15–21 / 22–último dia, agregação e cruzamento de totais.
- `web/src/api.ts`: HTTP same-origin, `credentials: same-origin`, `cache: no-store`, sessão Better Auth via `/api/auth/get-session`; não guarda tokens, cookies nem finanças em `localStorage`. Páginas dos históricos são recuperadas integralmente; se exceder limite de segurança, a interface falha explicitamente, **nunca exibe total parcial como verdadeiro**.
- `web/src/styles.css`: visual responsivo aprovado, boa legibilidade, estados vazios, inputs rotulados, controles de teclado, foco retido no diálogo, saída acessível também no mobile. Suporte `prefers-reduced-motion`.
- `web/vite.config.ts`: proxy somente local `/api` para Workerd, preservando política de origem estrita do backend. O teste de navegador usa a **compilação estática de produção** servida por `vite preview`, não o servidor de desenvolvimento.
- `web/tests/finance.test.mjs`: testes exatos de valor, mês/bissexto, semanas, reembolso, calendário e prévia de saldo.
- `web/tests/browser-e2e.mjs`: Chromium real, dois usuários fictícios com Better Auth, D1 local; todas as interações desde login até logout.

**Sem dados fictícios em tempo de execução da aplicação**: todos os indicadores e históricos exibidos vêm da API protegida. O backend é a fonte de verdade; o gráfico mensal é validado contra seu fluxo consolidado. A UI não decide o proprietário das operações: o servidor deriva o titular da sessão.

### Exemplos de jornadas

1. Cadastro de primeira carteira geral, sem banco; dinheiro inicial explicitamente diferenciado de realocação entre contas, evitando adicionar patrimônio duas vezes.
2. Receita recebida e despesa paga: contabilidade determinística em centavos; seleção de semana e conferência dos valores.
3. Transferência entre duas contas próprias: a soma dos saldos não muda, e não aparece no resultado de receitas/despesas.
4. Pagamento parcial de obrigação: baixa do valor realmente pago; restante continua pendente e aparece na agenda.
5. Login, logout e isolamento A/B: pessoa B visualiza estado próprio vazio sem leitura dos recursos de A; logout na navegação desktop e mobile revoga a sessão real.

## Adversarial review → correção → re-review

| Achado | Evidência / ação | Situação |
|---|---|---|
| UI-F01 — API do proxy Vite 8 incompatível com a assinatura anterior | `ProxyServer.on` falhou no TS; substituído por `server.proxy.headers` aceito pela configuração tipada | Corrigido, build aprovado |
| UI-T01 — fixture aritmética incorreta | Esperava -750 centavos em prévia de 2500−10000 centavos; corrigida para -7500 sem alterar a regra | Corrigida, testes aprovados |
| UI-T02 — seletor de E2E ambíguo | `Saldo inicial` selecionava campo de origem e de valor; teste passou a usar o campo exato | Corrigido |
| UI-F02 — intervalos semanais inconsistentes | Primeiro intervalo era `01–7`; corrigido para `01–07`, com a mesma regra para todos os intervalos | Corrigido |
| UI-F03 — logout mobile inacessível | Sidebar some no mobile e não havia botão equivalente; adicionado controle mobile e E2E de revogação real da sessão | Corrigido |
| UI-T03 — diálogos sumiam durante o E2E servido por Vite Dev | Log de DOM mostrou tela recarregada após entrada; investigação levou à troca de HMR/dev por `vite preview` da build de produção, com proxy preservado | **CI final verde**, fluxo real concluído |
| UI-T04 — falta de sincronismo do teste e observabilidade | Espera explícita por diálogo, seleção estável, logs diagnósticos só quando há falha, erro não tratado no browser torna teste vermelho | Corrigido |
| Contabilidade — gráfico com histórico incompleto | O gráfico soma somente lançamentos confirmados do mês e verifica soma exata contra `GET /api/dashboard`; divergência gera erro, não números falsos | Testado |
| Segurança — identidade e dados no cliente | Endpoints utilizam cookie de sessão no mesmo host; dados financeiros não persistem em storage do navegador; E2E verifica bloqueio após logout e usuário B isolado | Testado |

### Testes executados e gates

**[GitHub Actions #42941383664 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/42941383664)**

- `npm ci` instalou as dependências exatamente do `package-lock.json` commitado (React 19, ReactDOM 19, Vite 8, Playwright).
- `npm run ui:check` e `npm run ui:build`: TypeScript e compilação de produção aprovados.
- `npm run ui:test`: **5/5** testes da lógica da interface.
- `npm run typecheck` e `npm test`: **104/104** testes de domínio/backend, zero falhas.
- `wrangler d1 migrations apply DB --local`: **0001–0006 aplicadas**, com a biblioteca real do Better Auth.
- `npm run ui:e2e`: **UI_BROWSER_E2E_PASS** — autenticação A/B, criação de carteira, lançamento de receita/despesa, semana selecionada, transferência, pagamento parcial, conciliação de centavos, logout que revoga cookie, segunda identidade e navegação mobile sem overflow.
- O workflow tem **permissão somente leitura**, não faz deploy e usa usuários e banco descartáveis. O workflow temporário de escrita para geração de lockfile foi excluído da branch.

**Resultado de re-review:** não restaram achados acionáveis reproduzíveis nos percursos exercitados pela suíte final. A execução aprovada **não substitui auditoria completa de acessibilidade WCAG, avaliação de UX com usuários reais, teste de carga ou homologação da Cloudflare hospedada**.

## Executar localmente em Debian/Node 22

1. `npm ci`.
2. `cp wrangler.toml.example wrangler.toml` e configure um UUID de D1 **fictício apenas para --local**.
3. Crie `.dev.vars` ignorado pelo Git contendo `BETTER_AUTH_URL=http://127.0.0.1:8787`, segredo criptograficamente aleatório com pelo menos 32 caracteres e `ALLOW_SIGN_UP=true` **somente para cadastro local controlado**.
4. `npx wrangler d1 migrations apply DB --local --config wrangler.toml`.
5. Terminal 1: `npx wrangler dev --local --ip 127.0.0.1 --port 8787 --config wrangler.toml`.
6. Terminal 2: `npm run ui:dev` e abra `http://127.0.0.1:5173`.
7. Para testar exatamente o frontend de produção: `npm run ui:build && npm run ui:preview`; o browser E2E usa esse modo.

Nunca versionar `.dev.vars` ou `wrangler.toml` com segredos reais.

## Limitações e próximas etapas

- O dashboard backend da PR #36 é dependência da UI; **mesclar #36 primeiro** ou revisar o conjunto de PRs empilhadas. Não mesclar direto em `main` ainda.
- A interface não fornece ainda fluxo de recuperação de senha, convite/abertura pública de cadastros, criação visual completa de obrigações, edição/cancelamento de eventos, exportação PDF/XLSX ou sincronização offline; essas funções requerem as respectivas Issues.
- O histórico do mês é calculado a partir de páginas recuperadas pelo cliente. Para volumes históricos muito grandes, planejar endpoint de histórico filtrado no servidor e/ou agregação por semana antes de escalar como SaaS. Até lá, o cliente não aceita apresentar totais parciais como completos.
- Formulários usam API real; **sem armazenamento offline** ou demonstrações que simulam confirmação financeira.
- A etapa de Cloudflare remoto, CPU da autenticação, backup e produção fica adiada conforme decisão do proprietário.

**A interface aprovada foi implementada.** Requisições reais de dados, revisão humana das PRs e continuidade dos tickets permanecem controladas pelo proprietário.


## Revisão de integração e reteste — 11/11/2026

- **PR #36 mesclada** à `main` com commit `cafa272b3b56423cb82e98f614d31a2cb9c55dbb`. PR #37 foi retargeted para `main` e a branch recebeu merge sem conflito da `main`, preservando o código da UI.
- **UI-F04 (valor BRL ambíguo):** o parser de entrada podia interpretar `0.001` como R$ 1,00 pela regra de separador de milhares. Corrigido para não aceitar grupo de milhares iniciado por zero e adicionadas regressões para `0.001`, `00.123`, `001.234` e `0.001,23`. Valores brasileiros válidos permanecem aceitos.
- **UI-F05 (ordem das contas instável):** a consulta do D1 podia ordenar contas criadas no mesmo segundo por UUID, fazendo o formulário escolher conta sem saldo e, eventualmente, a mesma conta como origem/destino da transferência. O default agora prioriza conta com saldo positivo para despesas, pagamentos e transferências e escolhe destino diferente. O navegador confirma que o fluxo debita exatamente a conta de origem e credita a conta de destino.
- **Teste determinístico:** a suíte E2E deixou de selecionar a primeira conta apenas pela posição e passou a verificar o nome das duas opções selecionadas. Saldo da conta principal e reserva são assertados a partir da API real, sem imprimir dados financeiros nos logs.
- **Infraestrutura de teste:** uma execução ficou presa na instalação de dependências do sistema para Chromium; foi substituída pela instalação exclusiva do `headless shell` para rodar a build de produção, sem alterar a semântica financeira testada.
- **[GitHub Actions #43056130777 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43056130777):** `npm ci`, typechecks e build, **5/5 testes de UI**, **104/104 testes de backend**, D1 local 0001–0006 e `UI_BROWSER_E2E_PASS` com Better Auth real, dois usuários, contas, transferências, baixas, logout e mobile. Nenhum finding acionável reproduzível no escopo desta execução.

**Gate de merge:** como o único commit posterior à execução final é documentação, a implementação validada permanece idêntica à do último CI. Revisão formal de acessibilidade, produção remota e testes de carga seguem fora do escopo da PR #37.
