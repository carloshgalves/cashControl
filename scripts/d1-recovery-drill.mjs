// Destructive restore drill against TWO THROWAWAY LOCAL D1 databases only.
// Never accepts an existing DB/configuration, remote credentials or user records.
import {mkdtemp,mkdir,cp,writeFile,readFile,unlink,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sealSql,verifySealedSql,restoreSealedSql} from './d1-backup-crypto.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const WRANGLER=join(ROOT,'node_modules','.bin','wrangler');
const CONFIG=`name = "cashcontrol-recovery-drill"
main = "worker.mjs"
compatibility_date = "2026-11-10"
compatibility_flags = ["nodejs_compat"]
[[d1_databases]]
binding = "DB"
database_name = "cashcontrol-recovery-drill-only"
database_id = "00000000-0000-0000-0000-000000000001"
migrations_dir = "migrations"
`;
const FIXTURE=`
INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
 VALUES ('fixture-alice','Alice Exemplo','alice@example.invalid',0,1795000000,1795000000);
INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
 VALUES ('fixture-bob','Bob Exemplo','bob@example.invalid',0,1795000000,1795000000);
INSERT INTO financial_accounts(owner_user_id,account_id,creation_key,display_name,kind,initial_mode,initial_amount_cents,opening_cents,created_at)
 VALUES ('fixture-alice','11111111-1111-4111-8111-111111111111','recovery-fixture-account-alice','Carteira Alice','general','external',50000,50000,'2026-11-24T00:00:00.000Z');
INSERT INTO financial_accounts(owner_user_id,account_id,creation_key,display_name,kind,initial_mode,initial_amount_cents,opening_cents,created_at)
 VALUES ('fixture-bob','22222222-2222-4222-8222-222222222222','recovery-fixture-account-bob','Carteira Bob','general','external',30000,30000,'2026-11-24T00:00:00.000Z');
INSERT INTO posted_cash_movements(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,occurred_on,created_at)
 VALUES ('fixture-alice','33333333-3333-4333-8333-333333333333','recovery-fixture-income','11111111-1111-4111-8111-111111111111','income',1234,'pix','Entrada fictícia','2026-11-24','2026-11-24T00:00:00.000Z');
INSERT INTO financial_obligations(owner_user_id,obligation_id,creation_key,title,total_cents,due_on,created_at)
 VALUES ('fixture-alice','44444444-4444-4444-8444-444444444444','recovery-fixture-bill','Obrigação fictícia',4200,'2026-12-10','2026-11-24T00:00:00.000Z');
`;

function runD1(workspace,args,step){
 const command=['d1',...args,'--local','--config','wrangler.toml'];
 // Hard-coded, local-only CLI allowlist; no --remote, --env or caller-provided config.
 if(command.includes('--remote')||command.includes('--preview')||args.some(x=>x.startsWith('--env')))
  throw new Error('Remote D1 operation forbidden');
 const result=spawnSync(WRANGLER,command,{
  cwd:workspace,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,
  env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',
   CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''},
 });
 if(result.status!==0||result.error)throw new Error('LOCAL_D1_STEP_FAILED:'+step+
  ' (only local synthetic data is used; inspect the Wrangler step in a disposable environment)');
 return result.stdout;
}
async function setup(dir,migrate){
 await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(join(dir,'wrangler.toml'),CONFIG,{mode:0o600});
 await writeFile(join(dir,'worker.mjs'),"export default {fetch(){return new Response('local drill')}};\n",{mode:0o600});
 await cp(join(ROOT,'migrations'),join(dir,'migrations'),{recursive:true});
 if(migrate)runD1(dir,['migrations','apply','DB'],'source-migrations');
}
async function findSqlite(root){
 const found=[];
 async function scan(dir,depth=0){
  if(depth>8)return;
  for(const x of await readdir(dir,{withFileTypes:true})){
   const p=join(dir,x.name);
   if(x.isDirectory())await scan(p,depth+1);
   else if(x.isFile()&&/\.sqlite$/.test(x.name))found.push(p);
  }
 }
 await scan(join(root,'.wrangler'));
 for(const p of found){
  const db=new DatabaseSync(p,{readOnly:true});
  try{if(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='financial_accounts'").get().n===1)return p;}
  finally{db.close();}
 }
 throw new Error('LOCAL_D1_FILE_NOT_FOUND');
}
function snapshot(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const objects=db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE type IN ('table','view','index','trigger')
      AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV'
    ORDER BY type,name`).all();
  const tableNames=objects.filter(x=>x.type==='table').map(x=>x.name);
  const has=name=>tableNames.includes(name);
  assert(has('financial_accounts')&&has('posted_cash_movements')&&has('financial_obligations'));
  assert(has('debt_renegotiations')&&has('personal_loans')&&has('user'));
  const rows={};
  for(const name of tableNames){
   // Objects are SQLite's own identifiers, but still always quote them.
   const quoted='"'+name.replaceAll('"','""')+'"';
   const values=db.prepare('SELECT * FROM '+quoted).all();
   rows[name]=values.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>
    [k,typeof v==='bigint'?v.toString():Buffer.isBuffer(v)?v.toString('hex'):v]))).map(x=>JSON.stringify(x)).sort();
  }
  const canon=JSON.stringify({objects,rows});
  const hash=createHash('sha256').update(canon).digest('hex');
  const alice=db.prepare("SELECT balance_cents FROM financial_account_balances WHERE owner_user_id='fixture-alice'").get();
  const bob=db.prepare("SELECT balance_cents FROM financial_account_balances WHERE owner_user_id='fixture-bob'").get();
  const due=db.prepare("SELECT outstanding_cents FROM financial_active_due_items WHERE owner_user_id='fixture-alice' AND domain='obligation'").get();
  assert.equal(alice.balance_cents,51234);
  assert.equal(bob.balance_cents,30000);
  assert.equal(due.outstanding_cents,4200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user").get().n,2);
  return {hash,tables:tableNames.length,objects:objects.length,fixtures:6};
 }finally{db.close();}
}

export async function runRecoveryDrill(){
 const tmp=await mkdtemp(join(tmpdir(),'cashcontrol-a1-recovery-'));
 const source=join(tmp,'source'),target=join(tmp,'restore');
 const plaintext=join(tmp,'export.sql'),sealed=join(tmp,'protected.bin'),decrypted=join(tmp,'verified.sql');
 const key=randomBytes(32);
 try{
  await setup(source,true);
  await writeFile(join(source,'fixture.sql'),FIXTURE,{mode:0o600});
  runD1(source,['execute','DB','--file','fixture.sql'],'source-fixture');
  await unlink(join(source,'fixture.sql'));
  const sourceFingerprint=snapshot(await findSqlite(source));
  runD1(source,['export','DB','--output',plaintext],'source-export');
  assert((await stat(plaintext)).size>0);
  await sealSql(plaintext,sealed,key);
  await unlink(plaintext);
  const verified=await verifySealedSql(sealed,key);
  assert(verified.bytes>0);
  await assert.rejects(verifySealedSql(sealed,randomBytes(32)),/./);
  await cp(sealed,join(tmp,'corrupted.bin'));
  const corrupted=join(tmp,'corrupted.bin'),fd=await readFile(corrupted);
  fd[fd.length-1]^=0x01;await writeFile(corrupted,fd,{mode:0o600});
  await assert.rejects(restoreSealedSql(corrupted,join(tmp,'must-not-exist.sql'),key),/./);
  await assert.rejects(stat(join(tmp,'must-not-exist.sql')),{code:'ENOENT'});
  await restoreSealedSql(sealed,decrypted,key);
  await setup(target,false);
  // Import into a genuinely EMPTY, independently persisted D1 instance.
  runD1(target,['execute','DB','--file',decrypted],'empty-d1-restore');
  const restored=snapshot(await findSqlite(target));
  assert.deepEqual(restored,sourceFingerprint,'Restored schema SQL definitions, rows and derived money must match');
  // A green import must fail validation if it changes any restored row.
  runD1(target,['execute','DB','--command',
   "UPDATE user SET name='Alteração adversarial' WHERE id='fixture-bob'"],'tamper-detection');
  assert.notEqual(snapshot(await findSqlite(target)).hash,sourceFingerprint.hash,
   'Independent fingerprint must detect even an unrelated restored row mutation');
  console.log('A1_LOCAL_EXPORT_RESTORE_PASS');
  console.log('A1_RESTORED_CONTENT_TAMPER_DETECTED');
  console.log('A1_SEALED_BACKUP_TAMPER_REJECTED');
  console.log('A1_DB_SCHEMA_AND_FINANCIAL_BALANCES_MATCH');
  console.log('NO_REMOTE_D1 NO_PRODUCTION_DEPLOY NO_REAL_USER_DATA');
  return {status:'LOCAL_PASS',schemaObjects:restored.objects,tables:restored.tables};
 }finally{
  key.fill(0);
  await rm(tmp,{recursive:true,force:true,maxRetries:2,retryDelay:100});
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==2)throw new Error('No arguments are accepted for the local-only recovery drill');
  await runRecoveryDrill();
 }catch(error){
  console.error('A1_LOCAL_RECOVERY_DRILL_FAILED:',error?.message?.slice(0,220)??'unexpected error');
  process.exitCode=1;
 }
}
