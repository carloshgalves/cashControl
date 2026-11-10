# Backlog do cashControl — SPEC → tickets (2026-11-10)

**Estado:** planejamento registrado; nenhuma funcionalidade implementada.  
**Base:** [SPEC-000](../specs/SPEC-000-produto-mvp.md) · [DEC-001 a DEC-014](../decisions/DECISOES-DE-NEGOCIO.md)

## Estrutura

As Issues **#1–#7** são os épicos/Issues pais (especificações por domínio); **#8–#30** são tickets de comportamento observável, cada um com `Parent`, critérios de aceite, bloqueios, validação e exclusões. As Issues pais têm checklists com referências `#n` para as filhas. **Esses checklists NÃO são relações nativas de sub-issue**, pois a conexão GitHub atual não disponibiliza ação de criação de subissue; o vínculo nativo deve ser feito posteriormente na interface GitHub ou por ferramenta com permissão e suporte à operação.

## P0 — primeiro produto utilizável

- [Épico #1 — acesso e isolamento](https://github.com/carloshgalves/cashControl/issues/1): #8 (ADR de arquitetura/segurança) → #9 (autenticação/sessões) → #10 (autorização e isolamento A/B).
- [Épico #2 — núcleo financeiro](https://github.com/carloshgalves/cashControl/issues/2): #11 (saldo/contas/carteira) → #12 (entrada/gasto efetivo) → #13 (obrigações/baixas); #14 (transferências) deriva de #12; #15 (cancelamentos/estornos) deriva de #13.
- [Épico #3 — visões e relatórios](https://github.com/carloshgalves/cashControl/issues/3): #16 (dashboard), #17 (timeline/alertas), #18 (XLSX/PDF; depende de #16 e #17).

**Gate de P0:** usuário com ou sem banco consegue entrar na própria conta, registrar recursos, receber/pagar, consultar compromissos e exportar relatórios; usuário B não vê dados do usuário A, nem por referências diretas ou exportação. Saldo real ≠ obrigação ≠ expectativa.

## P1 — comportamento financeiro avançado aprovado

- [Épico #4 — cartões e faturas](https://github.com/carloshgalves/cashControl/issues/4): #19 (cartão + parcelas) → #20 (pagamento de fatura) → #21 (conciliação).
- [Épico #5 — trabalho e remuneração](https://github.com/carloshgalves/cashControl/issues/5): #22 (trabalhos e custos), #23 (recorrência e expectativa) → #24 (remuneração base, bruto opcional e componentes) → #25 (desconto em folha ligado a obrigação).
- [Épico #6 — planejamento e reservas](https://github.com/carloshgalves/cashControl/issues/6): #26 (intenções e reservas) → #27 (cenários e simulações).
- [Épico #7 — dívidas e recebíveis](https://github.com/carloshgalves/cashControl/issues/7): #29 (empréstimos/direitos a receber) → #30 (renegociação e encargos), com dependência também da fatura parcial #20 para o cenário de cartão.

## P2 — evolução circunscrita

- #28 — estimativa conservadora e opcional de renda variável, depois de #23 e #27, sem usar expectativas como saldo bancário.
- Compartilhamento familiar e permissões específicas **não possuem ticket de implementação**, pois são somente possibilidade futura da DEC-014.
- Cálculo automático de juros e amortização detalhada são evoluções não aprovadas para o primeiro produto.

## Checklist de execução

1. Revisar e aprovar a ADR técnica do #8; executar o preflight local.
2. Para cada ticket: verificar pré-requisitos reais, preservar autorização e confidencialidade, executar testes determinísticos e de integração com evidência dos exit codes.
3. Se CI não puder executar por cota/runner, registrar **CI_NOT_RUN** de forma separada de teste falho, sem declarar verde nem mesclar às cegas.
4. Não encerrar automaticamente um épico por ter sido decomposto. Só fechar tickets após verificação de critérios.
5. Não inventar decisões de produto além das DEC-001–014; ambiguidades materiais retornam à especificação antes da implementação.

## Critérios para decomposição adicional

A estrutura foi dimensionada para reduzir overengineering. Não criar Issue para cada campo de UI ou camada interna. Somente dividir ticket quando não for realizável em uma sessão concentrada ou envolver múltiplos fluxos de falha independentes; nesse caso manter rastreabilidade com o mesmo pai.
