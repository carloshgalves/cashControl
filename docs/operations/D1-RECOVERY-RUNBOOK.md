# A1 — Backup independente do Cloudflare D1: ensaio de recuperação local

**Ticket:** [#8](https://github.com/carloshgalves/cashControl/issues/8) · **Estado:** implementação de procedimento local e teste automatizado; **portão operacional de produção permanece aberto**.

## Objetivo e isolamento

Demonstrar, sem credenciais remotas e sem dados reais, a sequência completa **migrações versionadas → dados sintéticos em D1 local → exportação SQL → criptografia autenticada → descarte do SQL claro → validação do ciphertext → restauração numa instância D1 local nova → comparação estrutural e financeira**.

O procedimento é **diferente de Time Travel e de backups internos do provedor**. A origem e o alvo são workspaces temporários independentes, com a vinculação fictícia `DB` / ID `00000000-0000-0000-0000-000000000001`; nenhum comando usa `--remote`. Ambos são removidos no encerramento do processo; nunca são carregados como artefatos do GitHub Actions. O script não lê dados financeiros do repositório nem credenciais Cloudflare.

### Demonstração reproduzível

Requer Node 22.16+, dependências do `package-lock.json` e Wrangler 4.159.0. Na raiz do repositório:

```sh
npm ci
node --test tests/d1-backup-crypto.test.mjs
node --experimental-sqlite scripts/d1-recovery-drill.mjs
```

Evidências esperadas, **apenas após teste realmente executado**:

- `A1_LOCAL_EXPORT_RESTORE_PASS` — SQL exportado via Wrangler, importado em D1 local totalmente novo e comparado.
- `A1_SEALED_BACKUP_TAMPER_REJECTED` — criptografia autenticada não aceita chave errada, alteração de arquivo nem cabeçalho truncado.
- `A1_DB_SCHEMA_AND_FINANCIAL_BALANCES_MATCH` — mesmas tabelas, objetos, linhas e saldos derivados; `PRAGMA integrity_check` e `PRAGMA foreign_key_check` sem erros.
- `NO_REMOTE_D1 NO_PRODUCTION_DEPLOY NO_REAL_USER_DATA` — nenhum ambiente real consultado ou modificado.

Além do ensaio, `npm test`, `npm run typecheck`, `npm run ui:check` e `npm run ui:test` continuam sendo executados no CI. A evidência deve vincular o **SHA testado**, não apenas o nome da branch.

### Cifragem para arquivos SQL exportados

`scripts/d1-backup-crypto.mjs` fornece três operações sem conectividade à nuvem:

```sh
# Gerar a chave LOCALMENTE no gerenciador de segredos, sem gravá-la no Git.
# A variável é exemplo de nome, não uma chave ou configuração de produção.
export CASHCONTROL_BACKUP_KEY_HEX="<64 caracteres hexadecimais de origem criptográfica>"
node scripts/d1-backup-crypto.mjs seal    /caminho/seguro/export.sql /caminho/seguro/export.sealed
node scripts/d1-backup-crypto.mjs verify  /caminho/seguro/export.sealed
node scripts/d1-backup-crypto.mjs restore /caminho/seguro/export.sealed /caminho/isolado/restore.sql
```

Formato versionado: marcador não sensível, IV aleatório de 96 bits, ciphertext AES-256-GCM e tag de autenticação. Os arquivos de saída usam modo `0600` e abertura exclusiva: **não substituem nem apagam arquivos preexistentes**. Em caso de ciphertext adulterado ou chave incorreta, a restauração falha e remove o SQL parcialmente decriptado. A chave **não** é incluída no arquivo, no GitHub ou em logs. A operação usa streaming (não precisa carregar toda a exportação em RAM).

**Atenção:** `verify` verifica autenticidade criptográfica e legibilidade, **não** garante que todas as tabelas voltam nem testa validade dos dados. Somente uma restauração isolada com verificação de esquema, restrições e invariantes financeiros serve de ensaio.

## Operação futura de produção — NÃO AUTOMATIZADA

Antes de lidar com dados reais, o responsável deve aprovar por escrito: ambiente de destino, custodiante da chave, armazenamento externo cifrado, política de retenção, rotação de chaves, periodicidade, RPO/RTO, resposta a falhas, classificação LGPD, procedimento de apagamento e quem pode autorizar restauração.

A documentação Cloudflare indica `wrangler d1 export <DB> --remote --output=...` e `wrangler d1 execute <DB> --remote --file=...` como mecanismos de exportação/importação SQL, mas alerta sobre bloqueio de requisições enquanto uma exportação está em andamento, incompatibilidade com tabelas virtuais e limite de tamanho por instrução SQL. **Não usar diretamente esses comandos contra produção por este ticket**. O restore operacional deverá ocorrer **primeiro em banco remoto vazio e segregado de homologação**, autorizado pelo responsável, com conferência de constraints, dados, versionamento, compatibilidade de schema/DDL e medição de tempo de recuperação; somente então se discutirá uma janela real de mudança. Nunca executar dump de produção em CI público nem publicar SQL, nomes, extratos ou credenciais como artefatos.

A exportação remota, armazenagem externa, revisão de permissões, monitoramento de sucesso de backups, prova de rotação/recuperação da chave, ensaio de restore remoto e teste de CPU do Workers hospedado **não foram executados**. Logo, #8 e os portões #9/#10 **não devem ser fechados** por este trabalho.

### Referências técnicas

- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/d1/reference/time-travel/

## Registro de revisão adversarial

1. Exportar e restaurar todas as 16 migrações; confirmar **duas identidades sintéticas**, uma movimentação confirmada, uma obrigação aberta, saldo de Alice e saldo de Bob independentes.
2. Recusar ciphertext adulterado, tag alterada, senha/chave errada, arquivo incompleto e tentativa de sobrescrever backup ou SQL existente.
3. Restaurar em D1 local separado e conferir objetos (tabelas, views, triggers e índices), linhas e fingerprint SHA-256 de estados lógico-financeiros, além de `integrity_check` e `foreign_key_check`. Não basta a importação retornar exit code zero.
4. Revisar se o CI não usa token Cloudflare, `--remote`, `wrangler deploy` nem arquivos reais; verificar que o SQL claro foi apagado e nenhum backup/segredo é publicado.
5. Corrigir findings reproduzíveis, repetir execução no último commit e registrar os resultados reais na PR.
