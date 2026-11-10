# Primeiro incremento de backend — contas e carteiras

Este documento acompanha uma implementação **parcial** do ticket [#11](https://github.com/carloshgalves/cashControl/issues/11). **Ainda não há interface, endpoints HTTP, autenticação nem integração D1 de produção.** Não tratar como funcionalidade disponível a usuários finais.

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

## Próximos bloqueios

1. [#9](https://github.com/carloshgalves/cashControl/issues/9): autenticação real, migrações da biblioteca, cookies e sessões com segurança adequada.
2. [#10](https://github.com/carloshgalves/cashControl/issues/10): gate de autorização na API e testes A/B end-to-end.
3. [#11](https://github.com/carloshgalves/cashControl/issues/11): validação do adaptador D1 via Wrangler e interface de onboarding que deverá ser submetida à aprovação visual antes da implementação.

Não mesclar este incremento como conclusão de #11 nem expor operações financeiras em rota pública antes desses gates.
