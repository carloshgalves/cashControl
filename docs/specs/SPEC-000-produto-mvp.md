# SPEC-000 — cashControl: contrato do produto e plano incremental

**Status:** proposta de especificação para implementação, extraída das DEC-001…DEC-014 aprovadas em 2026-11-10.  
**Fonte canônica:** [Decisões de negócio](../decisions/DECISOES-DE-NEGOCIO.md).  
**Regra:** este documento operacionaliza decisões já tomadas; não aprova integrações, tecnologia, colaboração familiar, regras fiscais ou automações não discutidas.

## Problem Statement

Usuários com finanças simples ou complexas precisam registrar entradas, saídas, compromissos, vencimentos e a proveniência de renda, sem perder controle quando possuem várias contas, só dinheiro físico, rendas irregulares, cartões, dívidas ou valores a receber. Uma planilha indiferenciada confunde dinheiro real com expectativa e frequentemente duplica custos ao pagar faturas, transferir valores, renegociar dívidas ou lançar descontos em folha.

## Solution

Aplicação web multiusuário para controle financeiro individual. Cada pessoa tem dados próprios e pode operar sem banco, cartão ou emprego formal. O produto terá saldo efetivo, obrigações, receitas esperadas, intenções e reservas como conceitos distintos; oferecerá dashboard consolidado, linha do tempo e relatório XLSX/PDF. Capabilidades avançadas serão entregues progressivamente como descrito abaixo. Não há implementação ainda.

## User stories (panorama)

- US-01: como usuário, quero acessar apenas minhas finanças, sem visualizar dados de terceiros.
- US-02: quero iniciar com saldo geral/zero ou cadastrar contas e cartões, podendo individualizar depois.
- US-03: quero registrar uma entrada efetiva, sua origem e meio de recebimento, mesmo sem vínculo empregatício.
- US-04: quero registrar gasto imediato ou obrigação futura, liquidando-a parcialmente ou totalmente.
- US-05: quero conferir saldo consolidado e cronologia de eventos reais e futuros, com vencimentos.
- US-06: quero exportar meu próprio histórico filtrado em XLSX e PDF.
- US-07: quero acompanhar compras, parcelas e faturas de cartão e conciliar diferenças informadas pelo banco.
- US-08: quero registrar trabalho/serviço opcional e despesas associadas, distinguindo realizado de recebido.
- US-09: quero distinguir salário-base, aumentos permanentes, horas extras, bruto opcional e descontos em folha.
- US-10: quero planejar compras e ativar/desativar reservas preventivas sem movimentar dinheiro.
- US-11: quero ver estimativas conservadoras opcionais de renda variável, sem tratá-las como saldo.
- US-12: quero controlar dívidas, renegociações e empréstimos concedidos/valores a receber.

## Termos e invariantes

1. **Saldo efetivo** = movimentações confirmadas em conta/carteira; nunca soma limite de cartão, previsões ou reservas.
2. **Obrigação a pagar** = dívida assumida, com vencimento, saldo aberto e baixas. Sua criação não debita automaticamente caixa; só o pagamento o faz (salvo liquidação comprovada diretamente em folha).
3. **Direito a receber** = expectativa/ativo a cobrar; não equivale a saldo disponível. Devolução de principal emprestado não é receita de trabalho.
4. **Expectativa de renda** = evento futuro sem crédito bancário; receita recebida exige confirmação de entrada.
5. **Intenção** = possível compra sem dívida. **Reserva preventiva** = alocação virtual opcional para essa intenção, distinta de dinheiro saído ou obrigação.
6. **Movimentação efetiva** = evento de dinheiro confirmado. Transferências internas reduzem um saldo e aumentam outro, mas não alteram resultado de receitas/despesas.
7. Uma compra no cartão gera parcelas/obrigações; o pagamento da fatura liquida essas obrigações e **não** vira nova despesa de consumo.
8. Renegociação substitui a programação do saldo remanescente, preservando rastreabilidade; não duplica o principal.
9. Desconto em folha confirmado pode liquidar obrigação vinculada, sem debitar novamente conta bancária.
10. Reembolso/estorno preserva o evento original, registra compensação e evita reescrever movimento histórico de forma enganosa.
11. **Isolamento por usuário** abrange leitura, gravação, busca, agregação, exportação, relatórios, histórico, referências e erros. Nenhuma referência fornecida pelo cliente autoriza acesso entre usuários.
12. **Valores monetários** precisam ser exatos na unidade centesimal; não admitir arredondamento silencioso de números de ponto flutuante.
13. Um cadastro complementar é opcional sempre que a DEC disser que é (banco, cartão, emprego, trabalho, salário bruto, vínculo a empréstimo, reserva etc.).
14. Estimativas nunca são receita efetiva e devem distinguir certeza de premissas; nunca contabilizar a mesma expectativa específica e o componente histórico que a contém.

## Identidade, autorização e privacidade

- DEC-014 determina múltiplas contas independentes, sem compartilhamento no MVP.
- Qualquer operação sobre um recurso existente de outro usuário deve negar acesso sem expor conteúdo, saldos nem existência sensível; não confiar em IDs do navegador.
- Sessões, recuperação, mecanismo de autenticação e escolha de stack seguem pendentes de decisão **técnica**, antes de implementar.
- Não incluir dados financeiros sensíveis, nomes de clientes, valores completos nem documentos financeiros em logs ou telemetria por padrão.
- Dados exportados são acessíveis apenas ao titular autenticado e respeitam seus filtros.

## Data, concurrency and failure semantics

- Entrada/saída, quitação parcial, transferência, pagamento de fatura, cancelamento, renegociação e vínculo de desconto devem preservar consistência mesmo diante de requisições repetidas ou falhas intermediárias.
- Repetir uma operação de pagamento por erro de rede não deve gerar pagamento duplicado; especificar mecanismo de idempotência no desenho técnico.
- Se o usuário editar um compromisso depois de ter pagamentos registrados, preservar saldos e histórico e rejeitar estados inconsistentes.
- Edição de renda-base com data de vigência não altera retroativamente recebimentos passados.
- Se a exportação falhar, não alterar os lançamentos financeiros.
- Vencimentos e competências devem ser definidos por datas locais de negócio com fuso/horário explícito na solução técnica, sem prometer cálculo tributário.

## Entregas sequenciadas, não todos os recursos de uma vez

### P0 — Primeiro incremento utilizável
- [ ] Autenticação e isolamento entre usuários (SPEC-001).
- [ ] Saldo geral/conta/carteira, receitas e despesas reais, obrigações e baixas básicas, transferências internas (SPEC-002).
- [ ] Dashboard, linha do tempo, alertas in-app de vencimento e exportações XLSX/PDF (SPEC-003).

### P1 — Domínio aprovado, incremento seguinte
- [ ] Cartões, parcelas, faturas e conciliação opcional (SPEC-004).
- [ ] Trabalhos, renda recorrente/variável, componentes salariais, custos vinculados e descontos em folha (SPEC-005).
- [ ] Intenções e reservas preventivas, simulação financeira e cenários explícitos (SPEC-006).
- [ ] Empréstimos, valores a receber, encargos e renegociações informados (SPEC-007).

### P2 — Evolução delimitada
- [ ] Estimativa histórica conservadora **opcional** de renda extra (parte da SPEC-006 após histórico suficiente).
- [ ] Possibilidade de gestão familiar futura demanda nova decisão de produto, não entra em tickets de implementação atual.
- [ ] Amortizações detalhadas e cálculo automático de juros não estão aprovados para MVP.

## Testing Decisions e critérios de aceite transversais

- **Autorização:** testes de integração com ao menos dois usuários, incluindo busca, exportação, dashboard e recursos referenciados por ID cruzado.
- **Domínio:** testes de centavos, transferências, liquidações parciais, estornos, não duplicação de faturas/renegociações/descontos; testes reais de persistência/transações quando definidos.
- **UI:** jornadas automatizadas acessíveis: novo usuário sem banco; usuário com conta; pagamento de obrigação; exportação; cartão; cancelamento de intenção.
- **Segurança:** verificar que logs/erros não expõem dados financeiros alheios. Sessões e cache devem respeitar troca de usuário.
- **Infra e CI:** distinguir testes falhos de testes não executados por indisponibilidade de runner/cota. Manter evidência local de comandos, exit codes e fixtures isoladas; sem merge automático sem critérios mínimos.
- **Dados:** possuir exportação válida em XLSX e PDF; somas, datas e categorias coerentes com filtros e visões da UI.
- **Gate de P0:** titular consegue usar com saldo zero, cadastrar entradas e contas a pagar, quitar, visualizar saldo e linha do tempo e exportar seus próprios dados; outro usuário não consegue ver nada disso.

## Out of scope inicial

- Compartilhamento familiar, multi-moeda/câmbio, conexão automática a bancos/Open Finance, importação bancária automática, integração de cartões com instituições, prestação de contas fiscal, planejamento tributário e investimentos automatizados.
- Previsões de rendimento como dinheiro garantido, cálculo automático de juros não informados, decisões financeiras automáticas e IA obrigatória.
- Fórmulas de previsão estatística avançada e gestão contábil completa de financiamentos no primeiro incremento.

## Dependencies e decisões abertas

- Prioridade P0: definir arquitetura mínima viável, autenticação, segurança e rotina de backup/recuperação. Isso é escolha de engenharia antes de codificar, não entrevista extensa de produto.
- Regra exata para desmontar um saldo geral em contas individuais, estratégia de exclusão/arquivamento e fuso de competência são detalhes a especificar na slice correspondente sem duplicar dinheiro.
- Regra de alerta além de D-10/D-5, notificações externas e cálculos estatísticos devem ser tratados como decisões locais, não presumidos.
- Manter o trabalho incremental: cada ticket vertical implementa comportamento verificável, incluindo todas as camadas necessárias, e mantém a branch utilizável.

## Specification map

- SPEC-001: identidade, autorização e isolamento.
- SPEC-002: contas, saldos, movimentações e obrigações fundamentais.
- SPEC-003: dashboard, cronologia, vencimentos e relatórios.
- SPEC-004: cartões, compras parceladas e conciliação.
- SPEC-005: renda, trabalho e remuneração.
- SPEC-006: intenção de compra, reservas e projeções.
- SPEC-007: dívidas, valores a receber e renegociação.

Os respectivos **Issues pais** documentam o recorte detalhado por SPEC; as Issues menores são tickets verticais de implementação e incluem dependências explícitas.
