import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {sealSql,verifySealedSql,restoreSealedSql,backupKey} from '../scripts/d1-backup-crypto.mjs';

async function sandbox(fn){
 const dir=await mkdtemp(join(tmpdir(),'cc-d1-crypto-test-'));
 try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
const key=()=>randomBytes(32);
test('A1 AES-GCM keeps a multiline D1 SQL dump exact, private and encrypted at rest',()=>sandbox(async dir=>{
 const sql=join(dir,'source.sql'),enc=join(dir,'backup.enc'),restored=join(dir,'restored.sql');
 const input=Buffer.concat([Buffer.from('CREATE TABLE example(v TEXT);\nINSERT INTO example VALUES (\'SENSITIVE_FIXTURE_ONLY\');\n'),randomBytes(1024*1024)]);
 await writeFile(sql,input,{mode:0o600});
 const secret=key();
 assert.equal((await sealSql(sql,enc,secret)).bytes,input.length);
 assert.equal((await verifySealedSql(enc,secret)).bytes,input.length);
 assert.equal((await restoreSealedSql(enc,restored,secret)).bytes,input.length);
 assert.deepEqual(await readFile(restored),input);
 const encrypted=await readFile(enc);
 assert.equal(encrypted.includes('SENSITIVE_FIXTURE_ONLY'),false);
 if(process.platform!=='win32')assert.equal((await stat(enc)).mode&0o777,0o600);
}));
test('A1 wrong key, changed ciphertext, changed tag and truncated header fail closed',()=>sandbox(async dir=>{
 const sql=join(dir,'data.sql'),enc=join(dir,'sealed.enc'),restored=join(dir,'restored.sql');
 await writeFile(sql,'CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (123);');
 const secret=key();await sealSql(sql,enc,secret);
 await assert.rejects(verifySealedSql(enc,key()));
 await assert.rejects(restoreSealedSql(enc,restored,key()));
 await assert.rejects(stat(restored),{code:'ENOENT'});
 const full=await readFile(enc);
 for(const [label,offset] of [['payload',30],['tag',full.length-1],['header',1]]){
  const corrupt=Buffer.from(full);corrupt[offset]^=0x40;
  const file=join(dir,label+'.enc');await writeFile(file,corrupt);
  await assert.rejects(verifySealedSql(file,secret));
  await assert.rejects(restoreSealedSql(file,restored,secret));
  await assert.rejects(stat(restored),{code:'ENOENT'});
 }
 await writeFile(join(dir,'truncated.enc'),full.subarray(0,14));
 await assert.rejects(verifySealedSql(join(dir,'truncated.enc'),secret));
}));
test('A1 backups and restore cannot clobber or delete preexisting files',()=>sandbox(async dir=>{
 const sql=join(dir,'input.sql'),enc=join(dir,'protected.enc'),target=join(dir,'existing.sql');
 const secret=key();await writeFile(sql,'CREATE TABLE demo(id INTEGER);');
 await writeFile(enc,'EXISTING_ENCRYPTED_BACKUP');
 await assert.rejects(sealSql(sql,enc,secret),{code:'EEXIST'});
 assert.equal((await readFile(enc,'utf8')),'EXISTING_ENCRYPTED_BACKUP');
 await writeFile(target,'EXISTING_RESTORED_SQL');
 await assert.rejects(restoreSealedSql(enc,target,secret),{code:'EEXIST'});
 assert.equal((await readFile(target,'utf8')),'EXISTING_RESTORED_SQL');
}));
test('A1 key input must be 64 exact hex digits, not logged or inferred',()=>{
 assert.throws(()=>backupKey('short'));
 assert.throws(()=>backupKey('z'.repeat(64)));
 assert.deepEqual(backupKey('a'.repeat(64)),Buffer.alloc(32,0xaa));
});
