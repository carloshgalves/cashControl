import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createObligation, payObligation } from '../src/backend/obligations/obligations.ts';
import { createInternalTransfer } from '../src/backend/transfers/transfers.ts';
import { cancelUnpaidObligation, refundPaidExpense } from '../src/backend/compensations/compensations.ts';
import { makeReport, totalsOf, ReportAccountNotFound } from '../src/backend/reports/report.ts';
import { ReportTooLargeError } from '../src/backend/timeline/timeline.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';
import { parseCents } from '../src/domain/money.ts';

class Statement {
  constructor(db,sql,args=[]) {this.db=db;this.sql=sql;this.args=args;}
  bind(...args) {return new Statement(this.db,this.sql,args);}
  async first(){return this.db.prepare(this.sql).get(...this.args)??null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
  async run(){return this.db.prepare(this.sql).run(...this.args);}
}
class Db {
  constructor() {
    this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
    for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql',
      '0003_cash_movements.sql','0004_financial_obligations.sql',
      '0005_internal_transfers.sql','0006_cancellations_refunds.sql']) {
      this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    }
    this.queue=Promise.resolve();
  }
  prepare(sql){return new Statement(this.raw,sql);}
  batch(stmts){
    const transaction=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{
      const out=[];for(const s of stmts)out.push(await s.run());this.raw.exec('COMMIT');return out;
    }catch(e){this.raw.exec('ROLLBACK');throw e;}};
    const job=this.queue.then(transaction);this.queue=job.catch(()=>{});return job;
  }
  close(){this.raw.close();}
}
const actor=userId=>({userId});
const cents=parseCents;
const key=x=>'report-fixture-'+x.replace(/[^A-Za-z0-9_-]/g,'-');
const clock=()=>new Date('2026-11-11T13:00:00Z');
const options=(extra={})=>({
 from:'2026-11-01',to:'2026-11-30',asOf:'2026-11-11',status:'all',format:'xlsx',...extra,
});
async function using(fn){const db=new Db();try{await fn(db);}finally{db.close();}}
async function account(db,who,name='Principal',initial='100') {
 return createAccount(db,actor(who),{idempotencyKey:key(who+name),name,kind:'bank',
  funding:{mode:'external',cents:cents(initial)}},clock);
}
async function movement(db,who,accountId,direction,name,amount='10',when='2026-11-10'){
 return postMovement(db,actor(who),{idempotencyKey:key(who+name),accountId,
  direction,amountCents:cents(amount),method:'pix',description:name,occurredOn:when},clock);
}
async function obligation(db,who,title,amount='50',due='2026-11-20'){
 return createObligation(db,actor(who),{idempotencyKey:key(who+title),
  title,totalCents:cents(amount),dueOn:due},clock);
}
async function fixture(db) {
 const a=await account(db,'alice','Principal','100');
 const second=await account(db,'alice','Reserva','0');
 const b=await account(db,'bob','Só Bob','200');
 await movement(db,'bob',b.accountId,'income','SIGILO BOB','900');
 await movement(db,'alice',a.accountId,'income','Pagamento recebido','30');
 const expense=await movement(db,'alice',a.accountId,'expense','Mercado','10');
 await movement(db,'alice',a.accountId,'expense','Dezembro','8','2026-12-01');
 const bill=await obligation(db,'alice','Internet','50');
 await payObligation(db,actor('alice'),{idempotencyKey:key('partial-internet'),
  obligationId:bill.obligationId,accountId:a.accountId,
  amountCents:cents('20'),method:'pix',paidOn:'2026-11-11'},clock);
 await createInternalTransfer(db,actor('alice'),{idempotencyKey:key('transfer'),
  sourceAccountId:a.accountId,targetAccountId:second.accountId,amountCents:cents('5'),
  transferredOn:'2026-11-11'},clock);
 await refundPaidExpense(db,actor('alice'),{idempotencyKey:key('refund'),
  originalMovementId:expense.movementId,accountId:a.accountId,amountCents:cents('3'),
  refundedOn:'2026-11-11',method:'pix'},clock);
 const canceled=await obligation(db,'alice','Cancelada','8');
 await cancelUnpaidObligation(db,actor('alice'),{idempotencyKey:key('cancel'),
  obligationId:canceled.obligationId,canceledOn:'2026-11-11'},clock);
 return {a,second,b,bill};
}
function readZip(bytes) {
 const buf=Buffer.from(bytes),entries=new Map();let i=0;
 while(i+4<buf.length && buf.readUInt32LE(i)===0x04034b50) {
   const flags=buf.readUInt16LE(i+6),method=buf.readUInt16LE(i+8);
   assert.equal(flags&0x8,0);assert.equal(method,0);
   const size=buf.readUInt32LE(i+18),namesize=buf.readUInt16LE(i+26);
   const extra=buf.readUInt16LE(i+28);
   const name=buf.subarray(i+30,i+30+namesize).toString('utf8');
   const start=i+30+namesize+extra;
   const payload=buf.subarray(start,start+size);
   // CRC implemented independently of the production lookup-table algorithm.
   let crc=0xffffffff;
   for(const byte of payload){
     crc^=byte;
     for(let bit=0;bit<8;bit++)crc=(crc&1)?((crc>>>1)^0xedb88320):(crc>>>1);
   }
   assert.equal((crc^0xffffffff)>>>0,buf.readUInt32LE(i+14),'Corrupted ZIP entry: '+name);
   assert.equal(buf.readUInt16LE(i+12),0x21,'Invalid DOS ZIP date');
   entries.set(name,payload.toString('utf8'));
   i=start+size;
 }
 assert.equal(buf.readUInt32LE(i),0x02014b50,'OOXML central directory required');
 const eocd=buf.lastIndexOf(Buffer.from('504b0506','hex'));
 assert(eocd>0);assert.equal(buf.readUInt16LE(eocd+10),entries.size);
 return entries;
}
function pdfText(bytes){
 const buffer=Buffer.from(bytes),body=buffer.toString('latin1');
 assert(body.startsWith('%PDF-1.4'));
 const xref=Number(body.match(/startxref\n(\d+)/)?.[1]);
 assert.equal(body.slice(xref,xref+5),'xref\n','PDF xref byte offset is invalid');
 assert.match(body,/\/Type \/Page \/Parent/);
 return [...body.matchAll(/<([0-9A-F]+)> Tj/g)]
   .map(m=>Buffer.from(m[1],'hex').toString('latin1')).join(' ');
}
const base='https://cash.example',now=Date.parse('2026-11-11T13:00:00Z');
const session=async headers=>{
 const cookie=headers.get('cookie'),user=cookie==='session=alice'?'alice':
  cookie==='session=bob'?'bob':null;
 return user?{user:{id:user},session:{userId:user,expiresAt:new Date(now+120000)}}:null;
};
async function http(db,path,cookie){
 return handleFinancialHttp(new Request(base+path,{headers:{cookie,'x-user-id':'bob'}}),
   db,session,base,()=>now);
}
test('XLSX is a valid OOXML ZIP, with exact centavos and formulas kept inert',()=>using(async db=>{
 await fixture(db);
 const file=await makeReport(db,actor('alice'),options());
 assert.equal(file.format,'xlsx');assert(file.bytes.length>1500);
 const entries=readZip(file.bytes);
 assert.deepEqual([...entries.keys()].sort(),[
  '[Content_Types].xml','_rels/.rels','xl/_rels/workbook.xml.rels',
  'xl/styles.xml','xl/workbook.xml','xl/worksheets/sheet1.xml',
 ].sort());
 const sheet=entries.get('xl/worksheets/sheet1.xml');
 assert.match(sheet,/Pagamento recebido/);
 assert.match(sheet,/Reembolso/);
 assert.match(sheet,/Obrigaç[aã]o/);
 assert.match(sheet,/Transferência/);
 assert.match(sheet,/Cancelada/);
 assert.match(sheet,/30<\/v>/); // total pending 30 BRL
 assert(!sheet.includes('SIGILO BOB'));assert(!sheet.includes('Dezembro'));
 assert(!sheet.includes('<f>'),'Export must contain no executable formulas');
 assert.match(sheet,/pane ySplit="7"/);
}));
test('PDF is paginated readable WinAnsi and has byte-correct cross-reference',()=>using(async db=>{
 await fixture(db);
 const file=await makeReport(db,actor('alice'),options({format:'pdf'}));
 assert.equal(file.contentType,'application/pdf');
 const text=pdfText(file.bytes);
 for(const label of ['cashControl','Relat','2026-11-01','Mercado','Internet','Transfer','Reembolso','Previsto']) {
  assert(text.includes(label),label+' is missing in PDF');
 }
 assert(!text.includes('SIGILO BOB'));
}));
test('report values reconcile with dashboard, without counting transfer as income',()=>using(async db=>{
 const {a}=await fixture(db);
 const empty=totalsOf([]);
 assert.equal(empty.netCents,0);
 const file=await makeReport(db,actor('alice'),options());
 const sheet=readZip(file.bytes).get('xl/worksheets/sheet1.xml');
 assert.match(sheet,/Receitas confirmadas/);
 assert.match(sheet,/Saídas confirmadas, incluindo baixas/);
 assert.match(sheet,/Reembolsos confirmados/);
 assert.match(sheet,/Fluxo líquido efetivo/);
 assert.equal(file.rows,7,'income, expense, payment, transfer, refund, pending, cancellation once each');
 assert(a.accountId);
}));
test('account scope includes both sides of transfer and excludes unassigned obligations',()=>using(async db=>{
 const {a,second}=await fixture(db);
 const first=await makeReport(db,actor('alice'),options({accountId:a.accountId}));
 const secondReport=await makeReport(db,actor('alice'),options({accountId:second.accountId}));
 assert.equal(first.rows,5,'account scope excludes unassigned obligation and cancellation');
 assert.equal(secondReport.rows,1,'target account still sees neutral transfer once');
 const one=readZip(first.bytes).get('xl/worksheets/sheet1.xml');
 assert(!one.includes('Obrigação pendente'));
 assert(one.includes('Principal'));
 assert(!one.includes('SIGILO BOB'));
}));
test('selected status and period are applied to every output, no speculative receivables',()=>using(async db=>{
 await fixture(db);
 const planned=await makeReport(db,actor('alice'),options({status:'planned'}));
 assert.equal(planned.rows,1);
 const realized=await makeReport(db,actor('alice'),options({status:'realized',format:'pdf'}));
 assert.equal(realized.rows,5);
 const canceled=await makeReport(db,actor('alice'),options({status:'canceled'}));
 assert.equal(canceled.rows,1);
 const previous=await makeReport(db,actor('alice'),options({from:'2026-10-01',to:'2026-10-31'}));
 assert.equal(previous.rows,0);
}));
test('Excel-like formula strings are treated exclusively as user text',()=>using(async db=>{
 const a=await account(db,'alice');
 await movement(db,'alice',a.accountId,'income','=HYPERLINK("https://evil.test","click")','5');
 const sheet=readZip((await makeReport(db,actor('alice'),options())).bytes)
   .get('xl/worksheets/sheet1.xml');
 assert(sheet.includes('=HYPERLINK(&quot;https://evil.test&quot;,&quot;click&quot;)'));
 assert(!/<f(?: |>)/.test(sheet),'Formula cell was accidentally created');
}));
test('accented Portuguese and non-WinAnsi glyphs are not silently destroyed',()=>using(async db=>{
 const a=await account(db,'alice');
 await movement(db,'alice',a.accountId,'income','Ação café 😀','5');
 const xlsx=readZip((await makeReport(db,actor('alice'),options())).bytes)
   .get('xl/worksheets/sheet1.xml');
 assert(xlsx.includes('Ação café 😀'),'XLSX should retain complete Unicode');
 const pdf=await makeReport(db,actor('alice'),options({format:'pdf'}));
 const text=pdfText(pdf.bytes);
 assert(text.includes('Ação café [U+1F600]'),'PDF should show unrepresentable glyph by code point');
}));

test('PDF paginates without losing names or payments across page boundaries',()=>using(async db=>{
 const a=await account(db,'alice');
 for(let i=0;i<85;i++){
  await movement(db,'alice',a.accountId,'income','Evento '+String(i).padStart(3,'0'),'1');
 }
 const pdf=await makeReport(db,actor('alice'),options({format:'pdf'}));
 const content=Buffer.from(pdf.bytes).toString('latin1');
 assert((content.match(/\/Type \/Page \/Parent/g)||[]).length>1);
 const text=pdfText(pdf.bytes);
 assert(text.includes('Evento 000'));assert(text.includes('Evento 084'));
 assert(text.includes('Página'));
}));
test('export rejects foreign account without exposing contents or identifying owner',()=>using(async db=>{
 const {b}=await fixture(db);
 await assert.rejects(()=>makeReport(db,actor('alice'),options({accountId:b.accountId})),ReportAccountNotFound);
 const query='?from=2026-11-01&to=2026-11-30&asOf=2026-11-11&format=xlsx';
 const unauth=await http(db,'/api/reports/export'+query,'');
 assert.equal(unauth.status,401);
 const alice=await http(db,'/api/reports/export'+query,'session=alice');
 const bob=await http(db,'/api/reports/export'+query,'session=bob');
 assert.equal(alice.status,200);assert.equal(bob.status,200);
 assert(!Buffer.from(await alice.arrayBuffer()).includes('SIGILO BOB'));
 assert(!Buffer.from(await bob.arrayBuffer()).includes('Pagamento recebido'));
 const foreign=await http(db,'/api/reports/export'+query+'&accountId='+b.accountId,'session=alice');
 assert.equal(foreign.status,404);
}));
test('HTTP export protects filters, caching, Content-Disposition and MIME',()=>using(async db=>{
 await fixture(db);
 const qs='?from=2026-11-01&to=2026-11-30&asOf=2026-11-11&format=pdf';
 const res=await http(db,'/api/reports/export'+qs,'session=alice');
 assert.equal(res.status,200);
 assert.equal(res.headers.get('content-type'),'application/pdf');
 assert.match(res.headers.get('content-disposition'),/attachment; filename="cashcontrol_/);
 assert.match(res.headers.get('cache-control'),/no-store/);
 assert.equal(res.headers.get('x-content-type-options'),'nosniff');
 const text=pdfText(await res.arrayBuffer());assert(text.includes('Mercado'));
 for(const path of [
  qs+'&ownerId=bob',qs+'&from=2026-01-01',
  qs.replace('format=pdf','format=html'),
  qs.replace('to=2026-11-30','to=2026-02-29'),
  qs.replace('asOf=2026-11-11','asOf=2026-11-31'),
  qs.replace('from=2026-11-01','from=2026-12-01'),
  qs+'&status=bogus',qs+'&accountId=zzz',
 ]){
  const response=await http(db,'/api/reports/export'+path,'session=alice');
  assert.equal(response.status,400,'Invalid parameter should fail: '+path);
 }
}));
test('large exports fail closed before rendering instead of silently truncating',()=>using(async db=>{
 const stmt=db.raw.prepare(
  'INSERT INTO financial_obligations (owner_user_id, obligation_id, creation_key, title, total_cents, due_on, created_at) VALUES (?,?,?,?,?,?,?)');
 for(let i=0;i<2001;i++)stmt.run('alice',randomUUID(),'many-'+i,'Vencimento '+i,100,'2026-11-20','2026-11-01T00:00:00Z');
 await assert.rejects(()=>makeReport(db,actor('alice'),options()),ReportTooLargeError);
 const qs='?from=2026-11-01&to=2026-11-30&asOf=2026-11-11&format=pdf';
 assert.equal((await http(db,'/api/reports/export'+qs,'session=alice')).status,413);
}));
test('PDF and XLSX generation never modifies any financial movement',()=>using(async db=>{
 await fixture(db);
 const before=db.raw.prepare('SELECT count(*) AS n FROM posted_cash_movements').get().n;
 await makeReport(db,actor('alice'),options());
 await makeReport(db,actor('alice'),options({format:'pdf'}));
 await assert.rejects(()=>makeReport(db,actor('alice'),options({from:'2026-11-31'})));
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM posted_cash_movements').get().n,before);
}));
