# F1 / SPEC-006 — Revisão adversarial de intenções, reservas e conversões

**Issue:** [#26](https://github.com/carloshgalves/cashControl/issues/26); **épico:** #6. **Base:** `main` depois da PR #47 (E4). **Branch:** `feat/f1-purchase-intentions-preventive-reserves`. **Gate:** PR Draft, sem merge/deploy ou migração remota.

## Contrato aprovado

DEC-001/002/003 e SPEC-000: intenção de compra é planejamento, reserva preventiva é apenas dedução de margem projetada e compromisso é obrigação real assumida; **nenhum dos três** movimenta banco até pagamento explícito. Um usuário pode não cadastrar banco/cartão e ainda assim planejar com margem atual zero ou negativa. Valores em centavos, data civil de negócio e titular autenticado. O cadastro inclui título/objeto, descrição opcional, preço estimado e data possível; a conversão exige escolher a **data de vencimento da dívida**, que não é necessariamente a data planejada para a compra.

**Estados:** `planning` (reserva zero) → `reserved` (reserva total/parcial), `reserved` → `planning` (desativação), `planning/reserved` → `excluded` (retirada lógica) ou `converted` (compra concretizada). Estados finais não permitem exclusão física nem conversão dupla; toda transição é evento imutável. O título/valor planejados não são alterados arbitrariamente; para correções antes da compra, retira-se a intenção e cria-se outra, conservando trilha de auditoria. Nenhum evento real de compra/baixa pode ser apagado pela tela de planejamento.

A margem F1 **não é previsão temporal**. Uma consulta coerente soma `financial_account_balances`, `financial_obligation_balances`, `credit_invoice_balances` e reservas **somente** de intenções no estado `reserved`: `cash − bills − invoices − reserves`. Um valor negativo é aviso, sem veto à compra; não recebe salários potenciais. O cenário de calendário, incerteza e renda futura é da F2/#27/F3/#28.

## Persistência e consistência

- `migrations/0014_purchase_intentions.sql`: intenção inicial imutável, transições `reserve`, `plan`, `exclude` e `convert`, projeção `purchase_intention_balances` da última ação, FKs por `owner_user_id` e restrições de centavos/valor. O histórico de intenção excluída ou convertida permanece. A reserva é derivada do último evento, **nunca** acumulada em eventos sucessivos.
- Converter exige evento vinculado à obrigação criada pela mesma chave, com valor/título exatos e vencimento expressamente informado. `db.batch` contém duas inserções: uma obrigação em `financial_obligations` e um evento `convert`. Se o segundo falhar, a primeira inserção é revertida; se uma conversão concorrente vencer, a outra não deixa compromisso órfão. Não cria `posted_cash_movements`.
- Trigger de pré-inserção com detecção explícita de evento/ID já existente impede `INSERT OR REPLACE` de reescrever reserva anterior mesmo que `PRAGMA recursive_triggers=OFF`. `UPDATE` e `DELETE` são sempre rejeitados. Transições após exclusão/compra, reserva superior à intenção, conversão direta forjada e plano sem reserva ativa falham.
- Idempotência: criação e transição com mesma chave/payload retornam a mesma intenção/evento, mesmo com tentativas simultâneas. Reutilizar chave com valor, tipo, destinatário ou vencimento distinto causa conflito. Isolamento A/B em GET, POST, leitura histórica, referência de obrigação e agregação. Origem obrigatória nos POSTs; não há dados de intenção nos logs ou integrações externas.

## Findings acionáveis encontrados → corrigidos

| Achado | Correção e regressão |
|---|---|
| Concor­rência de duas conversões e teste SQL com aspas de identificador | Corrigiu asserção SQLite; prova uma obrigação criada e nenhuma órfã |
| Um checkbox de confirmação podia ser marcado enquanto a reserva anterior ainda era gravada | Controle desabilitado durante a mutação; Chromium real passou a conclusão da reserva antes de confirmar compra, eliminando perda da confirmação |
| Data pretendida de compra era usada tacitamente como vencimento obrigatório | Campo editável/obrigatório de vencimento na conversão, armazenamento append-only da data confirmada, idempotência e CHECK SQL; regressão com compra em novembro/vencimento em dezembro |
| Margem negativa poderia ser rejeitada se conta tivesse saldo bancário negativo | Consulta aceita dinheiro real negativo, sem mascarar risco; os compromissos e reservas permanecem não negativos |
| `INSERT OR REPLACE` poderia contornar o gatilho de DELETE no SQLite | Guardas antes de INSERT com rejeição por chave/evento antigo; teste com `recursive_triggers=OFF` |
| Conversão após exclusão ou segunda compra poderia duplicar passivo | Estado terminal protegidos pelo banco e regressões de corrida/idempotência |
| Conversão falha poderia deixar obrigação criada sem evento | Falha injetada entre comandos prova rollback integral do D1 batch |
| Planejamento de reserva poderia ser confundido com desembolso em relatórios | Comparação com dashboard/timeline/XLSX/PDF e teste Chromium mostra ausência de movimento até pagamento efetivo |

## Evidência e limites

Testes determinísticos: intenção sem movimento, reserva R$ 500 e reversão, parcial R$ 200, valores zero, saldo livre negativo, múltiplas reservas, obrigações antigas, idempotência concorrente, duas conversões distintas, SQL direto forjado, valores/data, rollback por trigger, cancelamento de planejamento e nenhuma exclusão de compra efetiva; HTTP com Better Auth, Origin, JSON allowlist e A/B 404. Chromium em D1 local com Better Auth real reproduz reserva/retirada/conversão e pagamento depois via endpoint original, confirma margem sem duplicação, histórico preservado, atualização de panorama, mobile e A/B.

A revisão não constitui homologação da versão em produção, certificação universal de bugs, análise de carga Cloudflare ou avaliação jurídica de compra e crédito. F2 controla cenários de renda/tempo e risco; F1 apenas margem corrente, com aviso quando negativa. Sem recursos externos, integrações bancárias ou dinheiro real.

**Portão:** CI verde no SHA final, novo exame do diff sem findings acionáveis nos cenários auditados, revisão visual humana e **merge manual**. Issue #26 permanece aberta até estar em `main`.
