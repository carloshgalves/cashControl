# F3 / SPEC-006 — Parecer e proposta matemática (pré-homologação)
Issue #28 · DEC-004 · branch `feat/f3-historical-potential-income`.

## Natureza
Implementação de uma **candidata determinística**, sob **opt-in explícito por requisição** via `POST /api/planning/potential`, sem escrita e sem efeito nas simulações conservadora/planejada da F2. A DEC-004 deixa fórmula, amostra mínima e janela **a detalhar**; por isso o método abaixo é **proposta técnica, não regra de negócio aprovada**, e a nova UI não será disponibilizada antes de aceite visual e matemático.

## Metodologia candidata v0 (não normatizada)
- Selecionar uma única fonte individual do titular com `payKind` **variable** ou **occasional**. Fontes fixas/mistas não entram sem decomposição explícita da remuneração.
- Amostra de **12 semanas civis completas** (segunda a domingo) anteriores à data de referência; somente receitas reais de movimentos financeiros **vinculados àquela fonte**. Dinheiro sem vínculo e estornos são excluídos. Semanas sem recebimento = zero, inclusive períodos em que atividades ou expectativas foram canceladas.
- **Insuficiência**: menos de quatro semanas positivas, ou ausência de receita no primeiro terço de quatro semanas da amostra. Não gerar estimativas nesse caso. Registrar `zeroWeeks`, `positiveWeeks` e quantidade de expectativas canceladas, sem imputar dinheiro por trabalho cancelado.
- **P25 por nearest rank** dos 12 valores semanais. O resultado não utiliza IA, correlação, tendência ou receita fictícia. Algumas distribuições esparsas produzem P25=0 mesmo após a amostra mínima.
- Para cada **semana completa futura** (máximo 13 semanas), a parcela potencial adicional é `max(0, P25 − total de expectativas explícitas remanescentes da mesma fonte naquela semana)`; expectativas canceladas não entram. Semanas parciais não são extrapoladas.
- O resultado divulga toda a série semanal, método, insuficiência e avisos sobre custos não atribuídos, vínculos ausentes e imprecisão. **Não altera renda efetiva, saldo, pagamentos ou reservas.**

## Gates adversariais
- Semana com 0, 1 e 3 trabalhos e período completamente nulo; fontes variáveis e fixas, contas de Alice/Bob.
- Expectativa futura igual/superior ao P25 impede acréscimo, recebimentos de outra fonte excluídos, expectativa cancelada não é receita.
- Soma estrita em centavos, sem arredondamento; dados demais retornam erro, datas inválidas e horizonte excessivo falham.
- Testes de código TypeScript, SQLite D1, API real Better Auth/CSRF e frontend continuam obrigatórios.
- **Não houve tela implementada**: a UI de seleção de fonte, opt-in e avisos precisa de aprovação visual; não fechar #28 até a entrega vertical.
