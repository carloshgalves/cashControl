# Primeiro incremento de backend — contas e carteiras

Este documento acompanha uma implementação **parcial** do ticket [#11](https://github.com/carloshgalves/cashControl/issues/11). **Ainda não há interface nem implantação D1 de produção.** O backend inclui rotas HTTP protegidas e integração funcional com Better Auth/Hono: o teste E2E real de autenticação e isolamento passou em Wrangler + D1 local no GitHub Actions. Não houve deploy nem medição de CPU real no Workers Free. Não tratar como funcionalidade disponível a usuários finais.

## O que já funciona (serviço backend, não publicado)

- Criar carteira geral com zero ou valor de abertura.
- Criar conta bancária ou carteira em espécie.
- Consultar contas e saldos por proprietário confiável.
- Distinguir dinheiro externo no saldo inicial de **realocação** de uma conta preexistente (que preserva o total consolidado).
- Rejeitar realocação acima do saldo disponível, com SQL condicionado e batch atômico.
- Reaplicar chave de idempotência sem duplicar conta/realocação, inclusive sob concorrência; rejeitar a mesma chave com outra intenção.

**Cuidados de uso:**
- `external` representa valor ainda não contabilizado em outra conta. Não é transferência; pode aumentar o patrimônio consolidado. Deve ser opção explícita do usuário.
- `reallocate` só movimenta valor de abertura **já contabilizado** em conta própria; se o saldo geral era de R$ 2.000 e R$ 700 passam a um banco, o total continua R$ 2.000.
- `AuthenticatedActor` **não é um sistema de autenticação**. Em uma API futura ele só poderá ser construído a partir de sessão verificada, jamais do corpo da requisição.
- As consultas consideram **apenas saldos iniciais e realocações**; receitas, despesas e faturas entrarão em incrementos posteriores.

## Executar testes locais

- Node.js >=22.16.0 e TypeScript instalado.
- `npm test` usa Node `node:sqlite` experimental para aplicar a migração real em memória e simular o contrato transacional de `D1.batch()`; o banco de testes não persiste.
- `npm run typecheck` valida os módulos TypeScript.
- Com rede: `npm install` instala a dependência de desenvolvimento de TypeScript. Nenhuma dependência externa é necessária para executar os testes com Node.

## Integração HTTP e identidade (em revisão)

- `src/worker.ts` expõe somente rotas `/api/auth/*`, `GET/POST /api/accounts` e `GET /api/accounts/:accountId`, protegidas por origem canônica.
- `src/backend/auth/worker-auth.ts` configura Better Auth, senha, sessão e rate limit persistido no D1. Cadastro público desabilitado por padrão; liberar apenas de forma controlada após revisão de e-mail/recuperação.
- `src/backend/http/accounts-handler.ts` constrói a identidade a partir do resultado verificado de `auth.api.getSession`, jamais de dados fornecidos pelo navegador; rejeita sessões inválidas, origens cruzadas e recursos de outro titular.
- `migrations/0002_better_auth.sql` adiciona tabelas de autenticação; verificar sua equivalência ao gerador da versão pinada **antes** de qualquer deploy.
- **Verificação em runner GitHub Actions:** `npm install` instalou 66 pacotes, `npm run typecheck` completo passou, `npm test` 20/20 passou, migrações no D1 local passaram e `node scripts/e2e-auth.mjs` passou com autenticação/isolamento/logout reais. [Execução #42832851510](https://github.com/carloshgalves/cashControl/actions/runs/42832851510).
- Revisão de segurança, achados corrigidos e gates pendentes: [AUTH-REVIEW.md](AUTH-REVIEW.md).

## Próximos bloqueios

1. [#9](https://github.com/carloshgalves/cashControl/issues/9): sessão, cadastro, login e logout reais foram validados localmente em Wrangler/D1; ainda faltam política de verificação de e-mail, recuperação de conta e medição de CPU no Workers Free hospedado.
2. [#10](https://github.com/carloshgalves/cashControl/issues/10): gate de autorização e testes A/B com cookies reais passaram no Worker/D1 local; não há produção ou exportações para homologar nesta etapa.
3. [#11](https://github.com/carloshgalves/cashControl/issues/11): migrações D1 locais e criação de contas com sessão autenticada passaram; interface de onboarding ainda depende de sua aprovação visual antes da implementação.

Não mesclar este incremento como conclusão de #9/#10/#11 nem disponibilizar operações financeiras em produção antes da validação real desses gates.
