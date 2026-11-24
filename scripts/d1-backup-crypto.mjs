// Authenticated, streaming encryption of an exported D1 SQL snapshot.
// This module NEVER accesses Cloudflare or the network and never prints SQL.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open,stat,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const MAGIC=Buffer.from('CASHCONTROL-D1-SEALED-V1\n','ascii');
const IV_LEN=12,TAG_LEN=16;
const HEADER_LEN=MAGIC.length+IV_LEN;

export function backupKey(hex=process.env.CASHCONTROL_BACKUP_KEY_HEX){
 if(typeof hex!=='string'||!/^[a-fA-F0-9]{64}$/.test(hex))
  throw new TypeError('A 32-byte backup key in CASHCONTROL_BACKUP_KEY_HEX is required');
 return Buffer.from(hex,'hex');
}

async function append(handle,data){
 // writeFile handles partial writes and advances the FileHandle's position.
 await handle.writeFile(data);
}
async function cleanClose(handle){
 try{await handle?.close();}catch{}
}

export async function sealSql(input,output,key=backupKey()){
 if(!Buffer.isBuffer(key)||key.length!==32)throw new TypeError('Invalid backup key');
 const original=await stat(input);
 if(!original.isFile()||original.size<1)throw new Error('Empty or invalid SQL export');
 // Never overwrite a previous backup. Files stay owner-readable only.
 let out;
 try{
  out=await open(output,'wx',0o600);
  const iv=randomBytes(IV_LEN),cipher=createCipheriv('aes-256-gcm',key,iv);
  await append(out,Buffer.concat([MAGIC,iv]));
  for await(const chunk of createReadStream(input).pipe(cipher))await append(out,chunk);
  await append(out,cipher.getAuthTag());
  await out.sync();await out.close();out=null;
  return {format:'cashcontrol-d1-sealed-v1',bytes:original.size};
 }catch(error){
  await cleanClose(out);
  try{await unlink(output);}catch{}
  throw error;
 }
}

async function decipherFile(input,key,onChunk){
 if(!Buffer.isBuffer(key)||key.length!==32)throw new TypeError('Invalid backup key');
 const size=(await stat(input)).size;
 if(size<=HEADER_LEN+TAG_LEN)throw new Error('Invalid encrypted backup');
 const src=await open(input,'r');
 let iv,tag;
 try{
  const header=Buffer.alloc(HEADER_LEN),tail=Buffer.alloc(TAG_LEN);
  if((await src.read(header,0,HEADER_LEN,0)).bytesRead!==HEADER_LEN ||
     (await src.read(tail,0,TAG_LEN,size-TAG_LEN)).bytesRead!==TAG_LEN ||
     !header.subarray(0,MAGIC.length).equals(MAGIC))
    throw new Error('Invalid encrypted backup header');
  iv=header.subarray(MAGIC.length);tag=tail;
 }finally{await src.close();}
 const dec=createDecipheriv('aes-256-gcm',key,iv);
 dec.setAuthTag(tag);
 let n=0;
 for await(const chunk of createReadStream(input,{start:HEADER_LEN,end:size-TAG_LEN-1}).pipe(dec)){
  n+=chunk.length;
  await onChunk(chunk);
 }
 if(n===0)throw new Error('Backup did not contain SQL');
 return n;
}

export async function verifySealedSql(input,key=backupKey()){
 const bytes=await decipherFile(input,key,async()=>{});
 return {format:'cashcontrol-d1-sealed-v1',bytes};
}

export async function restoreSealedSql(input,output,key=backupKey()){
 let out;
 try{
  out=await open(output,'wx',0o600);
  const bytes=await decipherFile(input,key,async chunk=>{await append(out,chunk);});
  await out.sync();await out.close();out=null;
  return {format:'cashcontrol-d1-sealed-v1',bytes};
 }catch(error){
  await cleanClose(out);
  try{await unlink(output);}catch{}
  throw error;
 }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const [verb,input,output,...extra]=process.argv.slice(2);
 if(extra.length||(verb!=='seal'&&verb!=='verify'&&verb!=='restore')||
    !input||(verb!=='verify'&&!output)||(verb==='verify'&&output)){
  console.error('Usage: node scripts/d1-backup-crypto.mjs seal <export.sql> <encrypted.bin> | verify <encrypted.bin> | restore <encrypted.bin> <target.sql>');
  process.exitCode=2;
 }else{
  try{
   if(verb==='seal')await sealSql(input,output);
   else if(verb==='verify')await verifySealedSql(input);
   else await restoreSealedSql(input,output);
   console.log('BACKUP_'+(verb==='seal'?'SEALED':verb==='verify'?'VERIFIED':'DECRYPTED')+'_PASS');
  }catch{
   console.error('BACKUP_OPERATION_FAILED');
   process.exitCode=1;
  }
 }
}
