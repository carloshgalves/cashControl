# Revisão adversarial — PR #31: contas, autenticação e autorização

**Data:** 2026-11-10. **Estado:** revisão de código e testes de unidade/integridade locais concluídos para os componentes verificáveis. **Homologação real de Better Auth e Cloudflare D1 não executada. Não fazer merge/deploy como funcionalidade autenticada pronta.**

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

Após as correções acima, a revisão estática e as regressões locais não revelaram outro defeito comprovadamente corrigível dentro do núcleo testável. Isso **não** significa zero risco ou autenticação homologada.

## Verificações reproduzíveis

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
5. Executar dois usuários A/B no Worker real: GET list/detail, POST com ID alheio, POST cross-origin, SQL injection, chaves de idempotência simultâneas, falhas de rede e validade de sessão.
6. Definir verificação de e-mail, recuperação de acesso, procedimento independente de backup e restauração testada, antes de beta público.
7. A PR permanece Draft, sem frontend: apresentar propostas de telas para aprovação antes de iniciar qualquer UI.

## Referências consultadas

- https://better-auth.com/docs/integrations/hono
- https://better-auth.com/docs/authentication/email-password
- https://better-auth.com/docs/reference/security
- https://better-auth.com/docs/concepts/rate-limit
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://better-auth.com/blog/security-release-2026-11-03
