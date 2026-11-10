# ADR-0001 — Arquitetura mínima web, sem serviço permanente pago

**Estado:** direção de arquitetura aprovada pelo responsável do produto em conversa de 2026-11-10; **integração operacional ainda não homologada**. Referências: [#8](https://github.com/carloshgalves/cashControl/issues/8), [DEC-001…014](../../decisions/DECISOES-DE-NEGOCIO.md).

## Contexto

O cashControl começa como ferramenta de uso pessoal, mas poderá virar produto comercial. O custo fixo deve ser mínimo; o processamento consiste majoritariamente em cálculos determinísticos, calendários e transações curtas. Segurança multiusuário e recuperabilidade não podem ser simplificadas por economia.

## Decisão

- **Web/PWA:** React, TypeScript e Vite, com interface responsiva. **Nenhuma interface será implementada antes da aprovação visual de telas pelo responsável do produto.**
- **API:** Hono executando em Cloudflare Workers, sem serviço dedicado ocioso.
- **Persistência:** Cloudflare D1 (SQLite) com migrações SQL versionadas. Não usar SQLite de execução local como banco de produção.
- **Identidade:** utilizar biblioteca de autenticação consolidada, inicialmente Better Auth, sujeita à validação de compatibilidade com D1 e geração de migrações. Sem implementar senhas, hashing, emissão de tokens ou gestão de sessão manualmente.
- **Domínio:** centavos inteiros seguros, datas de negócio explícitas e mudanças de saldo representadas por eventos rastreáveis; transações que atravessam mais de um registro devem ser atômicas e idempotentes.
- **Separação:** serviços do domínio recebem um ator **confiável**, obtido pelo middleware de autenticação, nunca o ID escolhido no navegador. Toda leitura/gravação de dados financeiros é condicionada ao proprietário, com restrições adicionais no banco quando aplicáveis.
- **Execução incremental:** código de domínio pode ser testado isoladamente antes de disponibilizar endpoints; não expor rotas de movimentação financeira até autorização e teste A/B (#9/#10) estarem prontos.

## Por quê

Sem necessidade atual de microsserviços, contêineres em produção, fila de tarefas, Redis ou processamento contínuo. A solução reduz custo inicial e preserva evolução. O D1 **não tem RLS nativo**, então o isolamento é uma responsabilidade fundamental do backend e dos testes de autorização. Os modelos de sessão e de autenticação não devem ser improvisados.

## Guardas de consistência

- Todas as operações que mexem no dinheiro devem respeitar idempotência, centavos, falhas intermediárias e histórico.
- D1 `batch()` é transacional conforme a documentação atual; requer teste de integração real com Wrangler/D1 antes de implantação em produção. Os testes locais nesta etapa usam SQLite real e um adaptador que reproduz semântica transacional de batch.
- Duplicação de saldo geral ao individualizar contas é evitada por realocação atômica; novo dinheiro externo só entra quando marcado **explicitamente** como valor de abertura externo. O front-end deverá explicar a diferença antes de permitir esse caminho.
- Nunca manter número completo de cartão/CVV, dados sensíveis em logs nem segredos no repositório.
- Não usar variáveis de cliente como fonte de `owner_user_id`; verificar A/B em API, consultas, relatórios e exportações.

## Estratégia de testes, backup e recuperação

- Testar domínio localmente com SQLite em memória, migrações reais e cenários adversariais de concorrência, falhas e IDs de outro usuário.
- Antes da primeira disponibilização: rodar migrations e testes de integração em D1 local via Wrangler e validar uma implantação de homologação separada.
- Construir procedimento de backup **independente** de Time Travel e ensaio de restauração; backups cifrados e com retenção definida antes de armazenar dados reais de terceiros. Os limites de retenção da oferta gratuita não substituem esse processo.
- Caso CI não execute por cota/runner, registrar `CI_NOT_RUN`, resultados locais e códigos de saída, sem alegar cobertura de execução inexistente.

## Limites deste ADR

- Não há credenciais, domínio ou banco de produção provisionados neste commit.
- Mecanismo preciso de autenticação, configuração de cookies, CSRF, rate limiting, migração do schema da biblioteca e política de recuperação ainda requerem validação antes de #9 ser considerada entregue.
- Sem sincronização offline, gestão familiar, acesso a contas de terceiros ou integrações bancárias.

## Referências técnicas consultadas

- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- https://developers.cloudflare.com/d1/platform/limits/
- https://better-auth.com/blog/1-5
