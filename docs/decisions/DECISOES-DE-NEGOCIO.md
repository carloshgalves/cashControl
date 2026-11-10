# cashControl — Registro de Decisões de Negócio (DEC)

> **Natureza:** decisões de produto e domínio financeiro, não ADRs de arquitetura técnica.
>
> **Situação:** DEC-001 a DEC-013 aprovadas em conversa de descoberta de produto até 2026-11-10.
>
> **Fase do projeto:** concepção; este documento **não** autoriza iniciar código nem substitui especificações detalhadas, critérios de aceite, testes ou decisões de arquitetura.

## Como ler e manter este registro

- **DEC** = decisão de negócio acordada com o responsável pelo produto.
- **Aprovada** = regra de negócio confirmada. Pode alimentar especificações posteriores; detalhes não decididos devem permanecer abertos.
- **Proposta/pendente** = não pode ser tratada como requisito fechado nem implementada por inferência.
- Novas decisões devem citar a DEC afetada; mudanças significativas devem preservar a decisão histórica e indicar a substituição, em vez de apagar a justificativa.
- Quando houver ambiguidade, abrir pergunta de produto antes de converter a decisão em ticket implementável.
- Todos os exemplos monetários são **ilustrativos**; valores, percentuais e datas de exemplo não são limites obrigatórios do produto.

## Princípios transversais aprovados

1. Cadastro detalhado é oferecido, mas não obrigatório quando o usuário não dispõe da informação ou do recurso (contas, cartões, emprego formal, trabalho, valor bruto etc.).
2. Diferenciar **saldo efetivo**, **obrigações assumidas**, **reservas preventivas** e **estimativas futuras**; não tratar previsão como receita confirmada.
3. Registrar causa, origem e estado dos eventos relevantes, especialmente mudanças de remuneração, pagamentos parciais, cancelamentos e renegociações.
4. Evitar **dupla contabilização** de transferências próprias, pagamento de fatura, deduções na folha, reserva convertida em compra e renegociação de dívida.
5. Preservar o histórico financeiro necessário à rastreabilidade; correções, pagamentos, estornos e alterações recorrentes não devem reescrever o passado de forma enganosa.
6. Manter a experiência utilizável tanto por quem quer registrar só entradas e saídas quanto por quem deseja vínculos e detalhamentos.

---

## DEC-001 — Controle financeiro híbrido

**Estado:** Aprovada.

**Decisão:** Oferecer primeiro o cadastro individual de contas bancárias, carteiras e cartões, com uma visão geral consolidada de tudo. Quem não possuir, ou não quiser cadastrar, esses recursos pode começar com um saldo geral/carteira de controle; a aplicação deve funcionar inclusive com saldo inicial zero.

**Comportamentos:**
- O usuário pode ter uma única conta, diversas contas, só dinheiro físico, conta sem cartão, conta e cartões, ou nenhum deles.
- Existirão visões individualizadas para os recursos cadastrados e visão consolidada para toda a situação financeira.
- Seções específicas que não se aplicam ao perfil não precisam ocupar espaço na navegação.
- O detalhamento pode ser acrescentado depois, sem duplicar saldos anteriores.
- Transferências entre recursos próprios não geram receitas nem despesas econômicas.

**A detalhar:** fluxo seguro para decompor um saldo geral existente em saldos por conta/carteira; significado de patrimônio x disponibilidade.

## DEC-002 — Compromisso financeiro separado do fluxo de caixa

**Estado:** Aprovada.

**Decisão:** Uma compra ou obrigação pode ser registrada na data em que é assumida, mas a saída de dinheiro só ocorre quando paga. As perspectivas de compromissos assumidos e pagamentos realizados coexistem, sem duplicidade.

**Comportamentos:**
- A aplicação aceita dinheiro físico, Pix, débito, crédito e outras formas pertinentes à movimentação.
- Compra à vista paga imediatamente pode gerar compromisso e quitação no mesmo fluxo.
- Compra a prazo gera obrigação(ões) com vencimento e baixa à medida que houver pagamentos.
- Cancelamento antes do pagamento encerra o compromisso; após pagamento, preservar a transação e registrar eventuais estornos/reembolsos, em vez de apagar que ocorreu.
- Linha do tempo e relatórios diferenciam evento de compra, obrigação e movimentação de dinheiro.

**A detalhar:** semântica de cancelamento parcial, chargeback, devoluções e classificação por regime de competência ou caixa nos relatórios.

## DEC-003 — Intenção de compra, planejamento e reserva preventiva

**Estado:** Aprovada.

**Decisão:** Uma intenção de compra começa como planejamento separado. O usuário pode optar por transformá-la em **comprometimento preventivo**, que reserva virtualmente dinheiro nas projeções, sem alterar saldo real. Antes da compra efetiva, pode desfazer a reserva, retornar ao planejamento ou excluir a intenção.

**Comportamentos:**
- Intenção registra o que se pretende adquirir, preço/valor estimado, data pretendida e informações opcionais de planejamento.
- O usuário pode simular o impacto de uma compra na margem restante, considerando obrigações; o sistema alerta para saldo negativo ou margem reduzida sem bloquear automaticamente a decisão.
- A intenção em planejamento não vira dívida real; a reserva reduz o **saldo livre projetado**, jamais o saldo efetivo.
- A reserva pode ser parcial ou gradativa como objetivo de compra, sujeita a detalhamento futuro.
- Quando a compra se concretizar, substituir o comprometimento virtual pela obrigação real correspondente, sem duplicar valores.

**A detalhar:** datas de projeção e nível configurável de alerta; múltiplas reservas concorrentes e regras de priorização.

## DEC-004 — Rendas recorrentes, variáveis, previstas e projeção conservadora

**Estado:** Aprovada.

**Decisão:** A aplicação atende rendas fixas, variáveis, mistas e avulsas, com ou sem periodicidade definida. Previsões históricas de renda variável são **opcionais** e aparecem como cenário potencial, não como dinheiro garantido.

**Comportamentos:**
- Separar fonte/proveniência da renda, expectativa de recebimento, execução da atividade quando houver, e dinheiro efetivamente recebido.
- Recebimentos podem ter periodicidade semanal, quinzenal, mensal, personalizada ou nenhuma; a frequência não deve ser inventada para trabalhadores eventuais.
- Registrar valores previstos, recebidos, parcialmente recebidos, adiados, não realizados e cancelados, com motivo se conhecido.
- Atividades inicialmente previstas ou confirmadas ainda podem ser canceladas ou impedidas.
- Usar histórico para uma faixa/estimativa conservadora apenas quando houver dados suficientes; considerar períodos sem recebimento e variabilidade, sem transformar média passada em promessa.
- Separar cenário conservador de valores efetivos/obrigações conhecidas, cenário planejado com expectativas explícitas e cenário potencial com estimativas históricas opcionais.
- Evitar incluir duas vezes um evento cadastrado individualmente e uma estimativa histórica que já o abrange.

**A detalhar:** fórmula, período mínimo de histórico, faixas, método para semanas sem atividade e horizonte da previsão. Não há autorização para pressupor uso de IA/ML; preferir inicialmente mecanismo determinístico e auditável.

## DEC-005 — Cadastro opcional de trabalhos e serviços

**Estado:** Aprovada.

**Decisão:** O usuário pode cadastrar o trabalho/serviço que origina a renda, mas também pode lançar receita diretamente sem nenhum vínculo profissional ou serviço cadastrado.

**Comportamentos:**
- Ficha opcional com nome/descrição, contratante, valor combinado, datas previstas, categoria, observações e outros dados opcionais pertinentes.
- Diferenciar trabalho previsto, confirmado, realizado, cancelado/adiado, e estado do respectivo pagamento (pendente, parcial, recebido). Estado de trabalho e estado de recebimento são independentes.
- Uma atividade pode gerar um ou vários recebimentos, inclusive parciais ou atrasados; um trabalho realizado não deve ser automaticamente considerado pago.
- Cancelamentos e diferenças entre o valor esperado e o efetivo permanecem disponíveis ao histórico e às análises.

**A detalhar:** cardinalidade e estados completos das atividades e recebimentos; anexos/comprovantes.

## DEC-006 — Despesas vinculadas opcionalmente à geração de renda

**Estado:** Aprovada.

**Decisão:** Uma despesa pode, se o usuário quiser, ser associada a um trabalho/serviço para demonstrar seu resultado financeiro líquido; associação não é obrigatória.

**Comportamentos:**
- Exemplo: serviço recebido de R$ 300, com R$ 40 de combustível e R$ 60 de material: resultado líquido de R$ 200.
- A mesma despesa continua aparecendo nas despesas gerais, sem ser contada duas vezes por também integrar o custo de um trabalho.
- A ausência do vínculo não impede registrar ou classificar a despesa.

**A detalhar:** rateio de uma despesa entre vários trabalhos e custos previstos versus reais (gestão orçamentária detalhada não foi aprovada para o MVP).

## DEC-007 — Vínculo profissional, tipo de remuneração e periodicidade independentes

**Estado:** Aprovada quanto ao princípio; opções de cadastro são proposta de detalhamento.

**Decisão:** O cadastro de trabalho deve informar se o vínculo é fixo/contínuo ou eventual, diferenciando isso da regularidade e composição da remuneração. O tipo de vínculo **não determina sozinho** a previsão de receita.

**Comportamentos:**
- Possíveis tipos de vínculo: emprego CLT, cargo público, contrato contínuo, autônomo/freelancer e outros.
- Remuneração pode ser fixa, variável ou mista, com periodicidade própria (mensal, quinzenal, semanal, personalizada ou nenhuma).
- Parte fixa recorrente gera expectativas futuras até o vínculo terminar/ser suspenso; isso **não** credita dinheiro automaticamente.
- Extras, comissões e serviços de frequência irregular dependem de informação real ou previsão explicitamente identificada.

**A detalhar:** enums finais e regras para férias, suspensão, encerramento, ciclos especiais e contratos de remuneração variável recorrente.

## DEC-008 — Motivo do adicional e versionamento da remuneração-base

**Estado:** Aprovada.

**Decisão:** Quando o valor recebido divergir do esperado, identificar a proveniência da diferença: aumento permanente, horas extras, gratificação, outras verbas ou redução/desconto, conforme pertinente.

**Comportamentos:**
- Se a diferença decorre de **aumento salarial**, atualizar a remuneração-base recorrente a partir de uma data de vigência informada, preservando valores históricos anteriores.
- Se decorre de **horas extras** ou outro adicional pontual, registrar o componente nesse recebimento, sem alterar os próximos valores-base.
- Admitir múltiplos componentes do mesmo recebimento e variações negativas; não inferir automaticamente que toda diferença é aumento.
- Manter rastreabilidade entre componente adicional, origem e pagamento.

**A detalhar:** reajustes retroativos, recorrência dos componentes extras e tipos de descontos.

## DEC-009 — Bruto opcional, líquido como referência e descontos discriminados

**Estado:** Aprovada.

**Decisão:** No mesmo modal, exibir campo de **salário líquido** e campo opcional de **salário bruto**, sem checkbox, configuração prévia ou fluxo obrigatório para habilitar o detalhamento. O líquido é a referência para saldo e projeções de dinheiro disponível.

**Comportamentos:**
- O usuário pode informar apenas salário líquido; bruto vazio é ignorado.
- Quando quiser discriminar o bruto, pode informar descontos individualizados, como INSS, IRRF, previdência de servidor, consignado, plano de saúde etc., conforme se apliquem ao caso.
- Para remuneração detalhada, validar/conferir a relação entre bruto, descontos e líquido; destacar divergências em vez de conciliá-las silenciosamente.
- Descontos já retidos antes do crédito do salário não podem gerar nova saída bancária automática.

**A detalhar:** como armazenar a conciliação pendente ou incompleta, descontos facultativos e precisão decimal.

## DEC-010 — Descontos em folha associados opcionalmente a obrigações

**Estado:** Aprovada.

**Decisão:** Um desconto salarial, como empréstimo consignado, pode ser associado a uma dívida/parcela cadastrada.

**Comportamentos:**
- A baixa parcial ou total da obrigação só ocorre quando a retenção/pagamento for efetivamente confirmado.
- O saldo bancário recebe somente o líquido depositado; a parcela paga via folha não é debitada novamente da conta.
- Manter a origem do pagamento como **desconto em folha** e o histórico da obrigação.
- Sem bruto/desconto informado, não inventar retenções nem presumir quitação.

**A detalhar:** como conciliar descontos não confirmados, faltas de holerite e vínculo com múltiplas parcelas.

## DEC-011 — Cartões, faturas consolidadas, compras e conciliação opcional

**Estado:** Aprovada — opção C.

**Decisão:** Manter gestão individual por cartão e por compra, com faturas consolidadas por ciclo, pagamentos e conciliação opcional contra valores informados pelo banco.

**Comportamentos:**
- Cadastrar cartão, instituição, limite, datas de fechamento e vencimento.
- Registrar compra, estabelecimento, categoria, data, valor e parcelas; distribuir obrigações por ciclo de fatura.
- Fatura lista compras/parcelas, pagamentos e saldo; admite pagamento integral ou parcial.
- O pagamento de fatura é liquidação financeira das obrigações, não uma nova despesa de consumo duplicada.
- Conciliação compara valor do sistema ao valor fornecido pelo usuário; divergências são mostradas e examinadas, não corrigidas automaticamente por suposição.
- Quem não tem cartão continua usando o sistema sem essas telas.

**A detalhar:** reabertura/fechamento de ciclo, antecipação de parcelas, estornos, mudanças de vencimento e cartão adicional.

## DEC-012 — Pagamentos parciais, encargos reais e renegociações

**Estado:** Aprovada — opção B; estimativa automática de juros **não aprovada**.

**Decisão:** Permitir saldos pendentes, juros e multas realmente informados, renegociação, parcelamento de fatura e mudança do cronograma de pagamento.

**Comportamentos:**
- Pagamento parcial reduz o devido; não marca quitação total.
- Encargos são lançados separadamente, com origem e valor informado pelo usuário/instituição; não calcular arbitrariamente taxa futura.
- Renegociação preserva a obrigação original e os pagamentos anteriores, mas substitui o cronograma de saldo remanescente para evitar somar duas dívidas equivalentes.
- Exemplo: saldo R$ 600 + encargos informados R$ 90 -> acordo de R$ 690 em três parcelas de R$ 230, sem cobrança simultânea de R$ 600 original + R$ 690 novo.

**A detalhar:** estados da renegociação, pagamentos realizados durante transição, tarifas e dívidas com encargos variáveis.

## DEC-013 — Obrigações próprias e valores a receber

**Estado:** Aprovada — opção B, com possibilidade de evoluir para C no futuro.

**Decisão:** Gerenciar dívidas e compromissos que o usuário deve pagar **e** valores que terceiros devem ao usuário, incluindo empréstimos informais entre pessoas, com vencimento, parcelas, recebimentos e pagamentos parciais.

**Comportamentos:**
- Registrar empréstimos, financiamentos, compras parceladas e outras obrigações próprias.
- Registrar empréstimos concedidos a amigos/familiares e outros direitos de recebimento, sem tratá-los como saldo imediatamente disponível.
- Dinheiro emprestado a terceiro não é automaticamente despesa de consumo; devolução do principal não é nova remuneração/receita de trabalho.
- Preservar saldo a receber, vencimentos, pagamentos parciais e histórico.
- A alternativa C (composição completa de principal, juros, amortização e evolução detalhada de financiamentos) é **possível evolução futura**, não parte aprovada do escopo inicial.

**A detalhar:** classificação de juros recebidos, inadimplência, perdão de dívida, contratos e modelo detalhado de amortização.

---

## Necessidades iniciais do produto (explicitadas na conversa)

- Dashboard de entradas, saídas, saldo, obrigações e perspectivas futuras.
- Linha do tempo cronológica com eventos recebidos, enviados, pendentes e planejados, visivelmente diferenciados.
- Registro da proveniência e do valor de cada receita.
- Contas a pagar com datas de vencimento e alertas, incluindo aviso de 10 e 5 dias antes (cadência e canal de notificação ainda a detalhar).
- Exportação de relatórios em **XLSX** (planilha) e **PDF**.
- Experiência progressiva: o usuário pode iniciar sem banco, cartão, vínculo formal ou bruto informado.

## Pendências deliberadamente NÃO decididas

1. Arquitetura, frameworks, hospedagem, autenticação, criptografia, backup, política de retenção e segregação de dados financeiros.
2. Definição exata do MVP, ordem de entregas e plano de testes.
3. Especificação contábil completa do livro de eventos e dos cálculos para todas as modalidades de pagamento, cancelamento e estorno.
4. Política de exclusão versus arquivamento com implicação sobre trilha histórica e consistência.
5. Detalhes de projeção estatística de renda variável, limiares de confiança e margem mínima de segurança para alertas.
6. Comportamento avançado de cartões, detalhamento de financiamentos e importação/integração bancária; nenhuma integração automática foi aprovada.
7. Interface final, fluxos de acessibilidade, filtros de relatório e formatos detalhados de exportação.
8. Alertas fora da aplicação, permissões de compartilhamento e uso multiusuário.

## Próxima etapa

Converter decisões aprovadas em especificações observáveis com histórias de usuário, invariantes verificáveis, casos de falha, critérios de aceite e testes. Separar os temas grandes em tickets somente depois de resolver as pendências que afetam suas regras de negócio. Não iniciar implementação a partir deste registro isoladamente.
