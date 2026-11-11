# SPEC-004 / D1 — Cartões de crédito e compras parceladas

**Issue:** #19 · **Base:** main após merge PR #40 · **Estado:** entrega vertical completa em branch, PR Draft, sem merge/deploy remoto.

## Regra operacional de ciclo (DEC-011)

1. Todos os dias são **datas civis locais**, sem inferir hora bancária; compra no dia de fechamento entra no ciclo deste mês.
2. Para mês com menos dias, fechamento e vencimento são ajustados ao último dia válido (por exemplo fechamento 31 em fevereiro = dia 28, ou 29 em ano bissexto).
3. Compra após fechamento entra no ciclo seguinte. As parcelas seguintes seguem meses consecutivos, sem deslocamento silencioso.
4. Vencimento estritamente posterior ao fechamento efetivo ocorre no próprio mês do ciclo; caso contrário, no mês seguinte. Ex.: fechamento 25 / vencimento 5 -> compra em 20/11 entra na fatura de novembro, vencendo 05/12; compra em 26/11 entra na de dezembro, vencendo 05/01.
5. Partilha de centavos: piso(total/count) para todas as partes e resto distribuído como +R$0,01 nas primeiras; nenhuma parcela de valor zero (valor total precisa ter ao menos um centavo por parcela), máximo técnico de 60 parcelas.

Essa regra operacional foi escolhida e registrada para tornar D1 testável e determinística, sem simular horário de autorização do emissor. Alterações de fechamento/vencimento de cartões existentes precisam de uma regra própria de versionamento antes de serem implementadas.

## Persistência, API e integridade

- Migração `0007_credit_cards_installments.sql`: cartão, compra e parcela com PK/FK compostas incluindo `owner_user_id`, índices por ciclo e criação; gatilho impede soma superior ao total de compra e alterações/destruição de histórico.
- Serviço `src/backend/cards/cards.ts`: idempotência separada por titular, confronto de payloads conflitantes e batch D1 atômico para compra + todas as parcelas. Sem escrita em `posted_cash_movements`, `financial_obligations` ou saldo bancário.
- HTTP e Worker: sessão Better Auth verificada no DB (sem confiar em headers ou IDs passados), Origin estrito em POST, corpo JSON limitado, parâmetros GET validados, nenhuma fuga da existência de cartões de outro usuário. Erros tratados como 400/401/403/404/409/413.
- UI React: cartão visual com limite meramente informativo, formulários opcionais de cartão/compra, seleção de faturas e detalhamento por parcela; responsive e sem número completo/CVV.

## Evidências e regressões

- `npm test`: 139 aprovações, zero falhas (inclui legado C3 e testes D1 de calendário 28/29/31, 10x, centavos, batch atômico, disputa de chave, titularidade A/B, SQL imutável, HTTP e nenhuma saída financeira).
- `npm run ui:test`: 16 aprovações, zero falhas; `npm run typecheck`, `npm run ui:check`, `npm run ui:build`: aprovados.
- [GitHub Actions #43113995387 — SUCCESS](https://github.com/carloshgalves/cashControl/actions/runs/43113995387): migrações locais 0001–0007, Worker/D1 descartáveis, Chromium com Alice/Bob, compra em 10x, fatura, saldo inalterado, IDOR 404 e mobile sem overflow (`D1_CREDIT_UI_PASS`, `D1_CREDIT_TENANT_PASS`).
- Achados do ciclo implementa/revisa/corrige: `due_on` com máscara SQL incompleta (rejeitava datas válidas), tipagem `noUncheckedIndexedAccess` de meses e parâmetro URLSearchParams não disponível no `lib` configurado — corrigidos e regressão reexecutada. Corrigido teste C3 legado que confundia células do quadro-resumo/cabeçalho com valores da tabela PDF; a verificação de largura e caracteres não foi enfraquecida.

## Limites explícitos / próximos tickets

- D1 representa compromissos em faturas **não liquidadas**. O saldo atual e fluxo de caixa P0 não mudam, o que é intencional. Até D2 (#20) não há pagamentos parciais, baixas bancárias ou saldo remanescente de fatura.
- O dashboard e o histórico XLSX/PDF P0 ainda não incluem as obrigações do novo módulo de cartão; o detalhamento próprio de faturas é a fonte na D1. A integração contábil consolidada pertence à evolução D2, sem dupla despesa.
- D3 (#21) é conciliação opcional do valor informado pelo banco. Chargebacks/estornos, antecipação, cartões adicionais, mudança de ciclos e recalculação são assuntos não decididos aqui.
- Segurança e prontidão de produção: o teste local verifica autorização e transação, não demonstra limite CPU Free hospedado, backup/restore, auditoria WCAG ou carga. Não utilizar dados bancários sensíveis, nem fazer deploy até esses gates.

**Parecer de implementação:** íntegra na suíte local/CI revisada; aguarda revisão visual humana e merge manual. Issue #19 continua aberta até integração em `main`.

**Revisão adversarial adicional — dados sensíveis:** não existem campos de PAN/CVV. Entretanto, a revisão encontrou que texto livre poderia receber acidentalmente um número completo de cartão. A validação agora rejeita sequências de 13 a 19 dígitos (com espaços/hífens) que passem no algoritmo de Luhn em nomes, instituição e demais rótulos, sem armazená-las nem registrá-las em logs. Testes cobrem PAN válido e identificador longo legítimo.
