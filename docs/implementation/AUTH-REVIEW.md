# Revisão adversarial — PR #31: contas, autenticação e autorização

**Data:** 2026-11-10. **Estado:** revisão adversarial e validação funcional real de Better Auth + Cloudflare D1 local **aprovadas em GitHub Actions**. **Sem deploy remoto; CPU do Workers Free, recuperação de conta, backup/restore e preparação de produção ainda não homologados.**

## Escopo revisado

- Serviço de contas da primeira fatia (#11), valores em centavos, SQL e concorrência.
- Fronteira HTTP de recursos financeiros, autorização por sessão verificada, privacidade nos erros.
- Configuração de Better Auth + Hono/Workers/D1, esquema de tabelas de autenticação e política de origem.
- Testes SQLite locais para isolamento e consistência; não foram feitas chamadas reais de login, logout ou banco remoto.

## Findings acionáveis e tratamento

| ID | Gravidade | Achado | Ação |
|---|---|---|---|
| F-01 | Alta | Serviço de contas recebia `userId` estrutural, sem uma fronteira HTTP que comprovasse a sessão; integrar rota sem verificação possibilitaria personificação entre usuários | Adicionado controlador que obtém o titular exclusivamente de `getSession` do Better Auth, verifica sessão/expiração e ignora `ownerId` e cabeçalhos de identidade fornecidos pelo cliente; teste A/B |
| F-02 | Alta | Ao adicionar mutações HTTP com cookies, seria necessário bloquear POST de origem cruzada e não confiar no Host enviado pelo navegador | Rejeição fail-closed de `Origin` ausente/inesperado em POST, verificação de origem canônica, sem CORS permissivo; teste de origem forjada |
| F-03 | Média | Erros SQL/constraint e payloads irrestritos poderiam vazar dados internos ou consumir recursos indevidos | Respostas genéricas sem SQL, leitura de corpo com limite de 4 KiB, parsing/validação rígidos; testes de corpo grande, inválido, saldo insuficiente e conta de outro titular |
| F-04 | Alta | Limite de tentativas em memória é insuficiente num runtime serverless | Configuração do Better Auth com rate limit persistido no banco e migração `rateLimit`; **precisa validação operacional real antes do deploy** |
| F-05 | Média | Cadastro público livre e ausência de verificação de e-mail poderiam permitir abertura abusiva ou identificação falsa | `ALLOW_SIGN_UP` desabilitado por padrão, senhas mínimas de 12 caracteres e `autoSignIn: false`. **Não abrir cadastro público antes de validar política de verificação/convites e recuperação de conta.** |
| F-06 | Alta (risco de disponibilidade) | Workers Free possui 10 ms de CPU por request e versões anteriores de Better Auth com scrypt em JS excediam o limite ao criar/autenticar senha | **Bloqueio de implantação, não correção criptográfica:** inspecionar o bundle da versão pinada e medir signup/login em Workers Free real. A resolução de empacotamento de maio/2026 precisa ser conferida na combinação efetiva de dependências; se ainda exceder 10 ms, optar por um provedor de identidade externo/OAuth ou infraestrutura com cota adequada, sem enfraquecer o hash. |

Após as correções acima, a revisão estática e as regressões locais não revelaram outro defeito comprovadamente corrigível dentro do núcleo testável. Isso **não** significa zero risco ou autenticação homologada.

## Homologação adicional em GitHub Actions (2026-11-10)

**Execução comprovada:** [Run #42832851510](https://github.com/carloshgalves/cashControl/actions/runs/42832851510), job `local-worker-integration`, conclusão **success**.

- `npm install --no-audit --no-fund`: **66 pacotes instalados** no runner Node 22.
- `npm run typecheck`: **PASS** no projeto completo, incluindo Better Auth, Hono e Worker.
- `npm test`: **20 PASS, 0 FAIL**.
- `npx wrangler d1 migrations apply DB --local`: **PASS**; migrações 0001/0002 aplicadas à instância descartável de D1 local.
- `npx wrangler dev --local`: Worker iniciado no Workerd/Miniflare.
- `node scripts/e2e-auth.mjs`: **AUTH_E2E_PASS** com cadastros e logins REAIS de Alice e Bob, cookies distintos, criação e consulta de conta por Alice, recusa de leitura por Bob, requisição cross-origin rejeitada, logout de Alice e revogação efetiva de seu cookie; Bob permaneceu autenticado.
- **Finding F-07 corrigido antes da homologação:** o `better-auth-cloudflare` habilita por padrão `autoDetectIpAddress` e `geolocationTracking`, exigindo `cf` não fornecido pela integração e coletando dados desnecessários. Ambos desabilitados; o E2E real passou. A proteção por sessão e rate limiting em banco permanecem.
- **CI:** este run foi executado; não relatar mais `CI_NOT_RUN` como estado geral. Entretanto, nenhuma pipeline de deploy/produção foi executada.

**Limites dessa evidência:** os testes de integração usam **D1 local**, não D1 remoto nem o enforcement real de quotas Cloudflare Workers Free. Ainda não houve execução do fluxo de recuperação/validação de e-mail; signup foi habilitado apenas no ambiente descartável pelo `ALLOW_SIGN_UP=true`, enquanto o padrão do produto continua fechado.

## Verificações anteriores (histórico — superadas parcialmente pelo run acima)



- `npm test`: **20 testes aprovados, 0 falhas**, usando Node 22.16 + SQLite experimental em memória. Exercita: centavos, saldo geral/realocação, rollbacks, chaves de idempotência, concorrência modelada, usuário A/B, acesso por ID estrangeiro, sessão inválida/expirada/sujeito inconsistente (simulada), CSRF/origem, payloads e unicidade/FK no esquema de autenticação.
- `npm run typecheck:core`: **PASS** para domínio e controlador HTTP, TypeScript 5.8.3 instalado localmente.
- `npm run typecheck`: **NÃO PASSOU** no ambiente executor por ausência de `node_modules`/pacotes Hono, Better Auth, better-auth-cloudflare e types Cloudflare. Não converter esse bloqueio em PASS.
- `npm install`: **NÃO EXECUTADO**, rede para registry não disponível neste executor.
- **CI_NOT_RUN**: não há evidência de job real executado para esta revisão.
- D1 real / Wrangler Workerd / login/logout pelo Better Auth: **NOT_RUN**. As sessões dos testes HTTP são fake de forma explícita; os testes de autorização **não testam a implementação interna** da biblioteca.

## Gates obrigatórios antes do merge funcional/deploy

1. Instalar dependências com lockfile gerado e auditado, pinando versões de segurança (Better Auth 1.7.18, Hono 4.13.17, better-auth-cloudflare 0.4.1).
2. Executar `npm run typecheck` completo, build e testar Worker/Hono no `wrangler dev --local`.
3. Comparar `migrations/0002_better_auth.sql` com schema gerado pela versão pinada; executar migrações em **D1 local** e numa base descartável de homologação. Não assumir equivalência só pelo SQLite.
4. Provar signup controlado, login, sessão válida, expiração, logout/revogação e erro de credenciais (preferencialmente e-mail alternativo) em testes de integração com Better Auth **real**.
5. Medir CPU real do fluxo de criação de conta e login no **Workers Free**; não sacrificar custos da função de hash. Verificar resolver do bundle e eventos `exceededCpu`.
6. Executar dois usuários A/B no Worker real: GET list/detail, POST com ID alheio, POST cross-origin, SQL injection, chaves de idempotência simultâneas, falhas de rede e validade de sessão.
7. Definir verificação de e-mail, recuperação de acesso, procedimento independente de backup e restauração testada, antes de beta público.
8. A PR permanece Draft, sem frontend: apresentar propostas de telas para aprovação antes de iniciar qualquer UI.

## Referências consultadas

- https://better-auth.com/docs/integrations/hono
- https://better-auth.com/docs/authentication/email-password
- https://better-auth.com/docs/reference/security
- https://better-auth.com/docs/concepts/rate-limit
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://better-auth.com/blog/security-release-2026-11-03

- https://developers.cloudflare.com/workers/platform/limits/
- https://github.com/better-auth/better-auth/issues/9649 (resolvido em maio/2026; histórico de exceder CPU, não prova de regressão atual)


## Finding adicional e revisão final de dependências — 2026-11-10

**F-08 (consistência de versões):** o primeiro lockfile transitivo resolveu `@better-auth/core` e `@better-auth/drizzle-adapter` em 1.7.19, enquanto o pacote principal estava em 1.7.18. Para reduzir riscos de incompatibilidade entre pacotes da mesma família, adicionamos overrides exatos para 1.7.18 e regeneramos o lockfile em ambiente com rede.

**Evidência de correção:** [Run #42834462040](https://github.com/carloshgalves/cashControl/actions/runs/42834462040), **SUCCESS**, usando `npm ci` com lockfile corrigido (66 pacotes), `npm run typecheck` PASS, `npm test` 20/20 e `AUTH_E2E_PASS` após as migrações D1 locais. Pacotes `better-auth`, `@better-auth/core` e `@better-auth/drizzle-adapter` resolvidos exatamente em 1.7.18.

O workflow temporário com permissão de escrita usado exclusivamente para versionar o lockfile foi removido em seguida. O workflow normal é de leitura e só roda em alterações intencionais do seu YAML ou disparo manual.

**Resultado da revisão no escopo exercitado:** nenhum finding adicional reprodutível após alinhamento e regressão. O gate de CPU hospedado e itens de prontidão produtiva descritos abaixo permanecem abertos; `D1 local passou` não equivale a `SaaS pronto`.

## Gate de CPU real do Workers Free — PENDENTE

A Cloudflare informa limite de **10 ms de CPU por requisição** no Workers Free. O Workerd local e o tempo total da suíte de integração não provam adequação a essa cota. A medição precisa ocorrer em um **Worker de homologação implantado em uma conta Cloudflare real**, com dados fictícios, pelo painel Analytics ou logs de execução.

1. Implantar apenas Worker de homologação com D1 de teste, sem usuários/dados reais e com conta controlada.
2. Executar cadastro, login correto/incorreto, `get-session` e logout repetidos; observar CPU por invocação, p95 e eventos `exceededCpu`.
3. Reprovar a escolha do Workers Free se ocorrerem estouros ou margens inseguras; considerar alternativa de autenticação gerenciada ou plano apropriado **sem enfraquecer o hash**.
4. Não usar latência HTTP, média da suíte ou temporização de banco como se fossem CPU.

Fonte: https://developers.cloudflare.com/workers/platform/limits/ e https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/
