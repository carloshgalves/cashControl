import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createSource,getSource,listSources,createManualExpectation,listCalendar,changeExpectation,linkIncomeReceipt,
 listExpectationEvents,listExpectationReceipts,listAvailableIncomeMovements,IncomeNotFound,IncomeConflict}
 from '../src/backend/income/income.ts';
import {createAccount} from '../src/backend/accounts/accounts.ts';
import {postMovement} from '../src/backend/movements/movements.ts';
import {getDashboard} from '../src/backend/dashboard/dashboard.ts';
import {refundPaidExpense} from '../src/backend/compensations/compensations.ts';
import {readExportTimeline} from '../src/backend/timeline/timeline.ts';
import {makeReport} from '../src/backend/reports/report.ts';
import {handleFinancialHttp} from '../src/backend/http/accounts-handler.ts';
class Stmt {
 constructor(db,sql,params=[]){this.db=db;this.sql=sql;this.params=params;}
 bind(...params){return new Stmt(this.db,this.sql,params);}
 async first(){return this.db.prepare(this.sql).get(...this.params)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.params)};}
 async run(){return this.db.prepare(this.sql).run(...this.params);}
}
class Db{
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
    '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
    '0007_credit_cards_installments.sql','0008_card_invoice_payments.sql',
    '0009_invoice_bank_reconciliation.sql','0010_work_services.sql','0011_income_expectations.sql']){
   this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  this.queue=Promise.resolve();
 }
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(stmts){
  const op=this.queue.then(async()=>{
   this.raw.exec('BEGIN IMMEDIATE');
   try{const result=[];for(const s of stmts)result.push(await s.run());this.raw.exec('COMMIT');return result;}
   catch(e){this.raw.exec('ROLLBACK');throw e;}
  });
  this.queue=op.catch(()=>{});return op;
 }
 close(){this.raw.close();}
}
async function using(fn){const db=new Db();try{await fn(db);}finally{db.close();}}
const actor=id=>({userId:id}),clock=()=>new Date('2026-11-11T13:00:00.000Z');
const key=x=>'reconciliation-key-'+x;


const period={from:'2026-11-01',to:'2026-11-30'};
const monthly=(tag='clt')=>({idempotencyKey:key('salary-'+tag),name:'Salário CLT',
 relationship:'employment',payKind:'fixed',periodicity:'monthly',anchorOn:'2026-01-31',fixedNetCents:300000});
const freelance=()=>({idempotencyKey:key('freelance'),name:'Freelancer',
 relationship:'freelance',payKind:'variable',periodicity:'none'});
async function account(db,user='alice'){return createAccount(db,actor(user),{idempotencyKey:key('account-'+user),
 name:'Conta',kind:'general',funding:{mode:'external',cents:0}},clock);}
async function income(db,a,tag,cents,user='alice'){return postMovement(db,actor(user),{
 idempotencyKey:key(tag.replaceAll(' ','-')),accountId:a.accountId,direction:'income',
 amountCents:cents,method:'pix',description:tag,occurredOn:'2026-11-11'},clock);}
test('E2 monthly fixed net salary clamps Jan31/Feb28/Mar31/Apr30 without creating cash',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),monthly(),clock);
 assert.equal(s.relationship,'employment');assert.equal(s.payKind,'fixed');
 const data=await listCalendar(db,actor('alice'),'2026-01-01','2026-04-30');
 assert.deepEqual(data.expectations.map(x=>x.currentOn),['2026-01-31','2026-02-28','2026-03-31','2026-04-30']);
 assert.deepEqual(data.totals,{expectedCents:1200000,receivedCents:0,remainingCents:1200000});
 assert.equal(data.basis,'user_defined_expectations_not_cash');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,0);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,0);
}));
test('E2 variable employment does not imply fixed pay; fixed freelancer can recur',()=>using(async db=>{
 const a=await createSource(db,actor('alice'),{...monthly('variable'),payKind:'variable',fixedNetCents:null},clock);
 const b=await createSource(db,actor('alice'),{...monthly('freelancer'),relationship:'freelance'},clock);
 const c=await createSource(db,actor('alice'),{...monthly('mixed'),payKind:'mixed'},clock);
 const cal=await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30');
 assert.equal(cal.expectations.length,2);
 assert.equal(cal.expectations.some(x=>x.sourceId===a.sourceId),false);
 assert.equal(cal.expectations.some(x=>x.sourceId===b.sourceId),true);
 assert.equal(cal.expectations.some(x=>x.sourceId===c.sourceId),true);
 await assert.rejects(()=>createSource(db,actor('alice'),{...freelance(),fixedNetCents:100},clock),TypeError);
}));
test('E2 freelancers 0/1/3 weekly expectations, empty periods do not invent received zeros',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),freelance(),clock);
 assert.equal((await listCalendar(db,actor('alice'),...['2026-11-01','2026-11-30'])).expectations.length,0);
 const dates=['2026-11-10','2026-11-17','2026-11-18','2026-11-20'];
 for(let i=0;i<4;i++)await createManualExpectation(db,actor('alice'),s.sourceId,{
  idempotencyKey:key('manual-'+i),expectedOn:dates[i],amountCents:[5000,10000,15000,20000][i]},clock);
 const cal=await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30');
 assert.deepEqual(cal.expectations.map(e=>e.currentOn),dates);
 assert.equal(cal.expectations.filter(e=>e.currentOn>='2026-11-16'&&e.currentOn<='2026-11-22').length,3);
 assert.equal(cal.expectations.filter(e=>e.currentOn>='2026-11-23'&&e.currentOn<='2026-11-29').length,0);
 assert.equal(cal.totals.receivedCents,0);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,0);
}));
test('E2 confirmation is not receipt; postponed date keeps original identity and history',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),monthly(),clock),occ='scheduled_2026-11-30';
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('confirm'),state:'confirmed'},clock);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('delay'),state:'delayed',newOn:'2026-12-05',reason:'Folha adiada'},clock);
 assert.equal((await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations.length,0);
 const dec=await listCalendar(db,actor('alice'),'2026-12-01','2026-12-31');
 assert.equal(dec.expectations.length,2);
 assert.deepEqual(dec.expectations.find(x=>x.occurrenceKey===occ)&&['delayed','2026-11-30','2026-12-05'],['delayed','2026-11-30','2026-12-05']);
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('reconfirm'),state:'confirmed'},clock);
 const history=await listExpectationEvents(db,actor('alice'),s.sourceId,occ);
 assert.deepEqual(history.map(x=>x.state),['confirmed','delayed','confirmed']);
 assert.equal(history[1].reason,'Folha adiada');
}));
test('E2 canceled expectation preserves actual partial receipts and never reverses income',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),monthly(),clock),a=await account(db),occ='scheduled_2026-11-30';
 const m=await income(db,a,'partial receipt',100000);
 await linkIncomeReceipt(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('link-one'),movementId:m.movementId},clock);
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('cancel'),state:'canceled',reason:'Contrato suspenso'},clock);
 const e=(await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations[0];
 assert.deepEqual([e.state,e.receivedCents,e.remainingCents],['canceled',100000,200000]);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,100000);
 await assert.rejects(()=>changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('reopen'),state:'confirmed'},clock),IncomeConflict);
 const later=await income(db,a,'later receipt',20000);
 await assert.rejects(()=>linkIncomeReceipt(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('link-later'),movementId:later.movementId},clock),IncomeConflict);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,120000);
}));
test('E2 actual receipts may be partial; no duplicate cash/dashboard/timeline/XLSX/PDF',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),monthly(),clock),a=await account(db);
 const one=await income(db,a,'first',100000),two=await income(db,a,'second',150000);
 const before=await getDashboard(db,actor('alice'),period);
 const filter={...period,asOf:'2026-11-11',status:'all'};
 const timeline=await readExportTimeline(db,actor('alice'),filter),occ='scheduled_2026-11-30';
 await Promise.all(Array.from({length:3},()=>linkIncomeReceipt(db,actor('alice'),s.sourceId,occ,{
  idempotencyKey:key('identical'),movementId:one.movementId},clock)));
 await linkIncomeReceipt(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('second'),movementId:two.movementId},clock);
 const e=(await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations[0];
 assert.deepEqual([e.expectedCents,e.receivedCents,e.remainingCents],[300000,250000,50000]);
 assert.equal((await listExpectationReceipts(db,actor('alice'),s.sourceId,occ)).length,2);
 const extra=await createManualExpectation(db,actor('alice'),s.sourceId,{idempotencyKey:key('extra'),expectedOn:'2026-11-20',amountCents:50000},clock);
 await assert.rejects(()=>linkIncomeReceipt(db,actor('alice'),s.sourceId,extra,{idempotencyKey:key('double-link'),movementId:one.movementId},clock),IncomeConflict);
 assert.deepEqual(await getDashboard(db,actor('alice'),period),before);
 assert.deepEqual(await readExportTimeline(db,actor('alice'),filter),timeline);
 for(const format of ['pdf','xlsx'])assert.equal((await makeReport(db,actor('alice'),{...filter,format})).rows,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,2);
}));
test('E2 cross-owner source, plan, event and posted movement are inaccessible',()=>using(async db=>{
 const a=await createSource(db,actor('alice'),monthly(),clock),bank=await account(db);
 const m=await income(db,bank,'salary income',10000);
 await assert.rejects(()=>getSource(db,actor('bob'),a.sourceId),IncomeNotFound);
 await assert.rejects(()=>createManualExpectation(db,actor('bob'),a.sourceId,{idempotencyKey:key('wrong'),expectedOn:'2026-11-12',amountCents:100},clock),IncomeNotFound);
 await assert.rejects(()=>changeExpectation(db,actor('bob'),a.sourceId,'scheduled_2026-11-30',{idempotencyKey:key('wrong-event'),state:'confirmed'},clock),IncomeNotFound);
 await assert.rejects(()=>linkIncomeReceipt(db,actor('bob'),a.sourceId,'scheduled_2026-11-30',{idempotencyKey:key('wrong-link'),movementId:m.movementId},clock),IncomeNotFound);
 await assert.rejects(()=>changeExpectation(db,actor('alice'),a.sourceId,'scheduled_2026-11-29',{idempotencyKey:key('fake-day'),state:'confirmed'},clock),IncomeNotFound);
 assert.equal((await listSources(db,actor('bob'))).length,0);
 assert.equal((await listAvailableIncomeMovements(db,actor('bob'))).length,0);
}));
test('E2 SQL UPDATE/DELETE/REPLACE cannot rewrite source or expectation history',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),monthly(),clock);
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO income_sources(owner_user_id,source_id,creation_key,display_name,relationship_kind,pay_kind,periodicity,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('alice',s.sourceId,key('new-key'),'Overwritten','freelance','variable','none',clock().toISOString()),/INCOME_IMMUTABLE/);
 assert.throws(()=>db.raw.exec("DELETE FROM income_sources WHERE owner_user_id='alice'"),/INCOME_IMMUTABLE/);
 assert.throws(()=>db.raw.exec("UPDATE income_sources SET display_name='other'"),/INCOME_IMMUTABLE/);
 assert.equal((await getSource(db,actor('alice'),s.sourceId)).name,'Salário CLT');
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const session=async h=>{const v=h.get('cookie'),u=v==='u=alice'?'alice':v==='u=bob'?'bob':null;
 return u?{user:{id:u},session:{userId:u,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{cookie:user?'u='+user:'',origin,'x-user-id':'bob',
 ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('E2 HTTP auth, CSRF, malformed filters, replay, 404 and amounts',()=>using(async db=>{
 assert.equal((await http(db,'/api/income-sources','')).status,401);
 const payload={idempotencyKey:key('http-source'),name:'Salário',relationship:'employment',
  payKind:'fixed',periodicity:'monthly',anchorOn:'2026-11-30',fixedNet:'3000.00'};
 assert.equal((await http(db,'/api/income-sources','alice','POST',payload,'https://evil.example')).status,403);
 assert.equal((await http(db,'/api/income-sources','alice','POST',{...payload,ownerId:'bob'})).status,400);
 assert.equal((await http(db,'/api/income-sources','alice','POST',{...payload,fixedNet:'NaN'})).status,400);
 assert.equal((await http(db,'/api/income-sources?limit=1&limit=2')).status,400);
 assert.equal((await http(db,'/api/income-calendar?from=2026-11-01&to=2026-11-30&unknown=1')).status,400);
 const create=await http(db,'/api/income-sources','alice','POST',payload);
 assert.equal(create.status,201);const source=(await create.json()).source;
 assert.equal((await http(db,'/api/income-sources','alice','POST',payload)).status,201);
 assert.equal((await http(db,'/api/income-sources/'+source.sourceId,'bob')).status,404);
 assert.equal((await http(db,'/api/income-sources/'+source.sourceId+'/expectations','bob','POST',{idempotencyKey:key('steal'),expectedOn:'2026-11-17',amount:'10.00'})).status,404);
 const calendar=await http(db,'/api/income-calendar?from=2026-11-01&to=2026-11-30');
 assert.equal(calendar.status,200);assert.equal((await calendar.json()).calendar.expectations.length,1);
 const update='/api/income-sources/'+source.sourceId+'/expectations/scheduled_2026-11-30/events';
 assert.equal((await http(db,update,'alice','POST',{idempotencyKey:key('confirm-http'),state:'confirmed'})).status,201);
 assert.equal((await http(db,update,'bob')).status,404);
 assert.equal((await http(db,'/api/income-sources','alice','POST',{...payload,name:'Alterado'})).status,409);
}));


test('E2 weekly, fortnightly, custom intervals and end date are explicit and deterministic',()=>using(async db=>{
 const base={idempotencyKey:key('weekly'),name:'Semanal',relationship:'continuous',payKind:'fixed',
  periodicity:'weekly',anchorOn:'2026-11-01',fixedNetCents:10000};
 const weekly=await createSource(db,actor('alice'),base,clock);
 const fortnightly=await createSource(db,actor('alice'),{...base,idempotencyKey:key('fortnightly'),name:'Quinzenal',periodicity:'fortnightly'},clock);
 const custom=await createSource(db,actor('alice'),{...base,idempotencyKey:key('custom'),name:'Customizado',
  periodicity:'custom',intervalDays:10,anchorOn:'2026-11-03',endOn:'2026-11-25'},clock);
 const nov=(await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations;
 const dates=id=>nov.filter(x=>x.sourceId===id).map(x=>x.originalOn);
 assert.deepEqual(dates(weekly.sourceId),['2026-11-01','2026-11-08','2026-11-15','2026-11-22','2026-11-29']);
 assert.deepEqual(dates(fortnightly.sourceId),['2026-11-01','2026-11-15','2026-11-29']);
 assert.deepEqual(dates(custom.sourceId),['2026-11-03','2026-11-13','2026-11-23']);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal((await listCalendar(db,actor('alice'),'2026-12-01','2026-12-31')).expectations.filter(x=>x.sourceId===custom.sourceId).length,0);
}));
test('E2 SQL forbids fabricated scheduled amount or invented recurrence date',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),monthly(),clock);
 const sql='INSERT INTO income_expectations(owner_user_id,source_id,occurrence_key,creation_key,kind,original_on,expected_cents,created_at) VALUES(?,?,?,?,?,?,?,?)';
 const args=(day,amount,tag)=>['alice',src.sourceId,'scheduled_'+day,key(tag),'scheduled',day,amount,clock().toISOString()];
 assert.throws(()=>db.raw.prepare(sql).run(...args('2026-02-27',300000,'fake-day')),/INCOME_SCHEDULE_INVALID/);
 assert.throws(()=>db.raw.prepare(sql).run(...args('2026-02-28',300001,'fake-money')),/INCOME_SCHEDULE_INVALID/);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,0);
 await changeExpectation(db,actor('alice'),src.sourceId,'scheduled_2026-02-28',{idempotencyKey:key('valid'),state:'confirmed'},clock);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,1);
}));
test('E2 duplicate confirmation is rejected but replay of original after later delay is safe',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),monthly(),clock),occ='scheduled_2026-11-30';
 const confirm={idempotencyKey:key('confirmation'),state:'confirmed'};
 await changeExpectation(db,actor('alice'),src.sourceId,occ,confirm,clock);
 await assert.rejects(()=>changeExpectation(db,actor('alice'),src.sourceId,occ,{idempotencyKey:key('new-confirm'),state:'confirmed'},clock),IncomeConflict);
 await changeExpectation(db,actor('alice'),src.sourceId,occ,{idempotencyKey:key('postpone'),state:'delayed',newOn:'2026-12-03'},clock);
 const replay=await changeExpectation(db,actor('alice'),src.sourceId,occ,confirm,clock);
 assert.equal(replay.state,'delayed','replay does not return an obsolete confirmed state or duplicate event');
 assert.equal((await listExpectationEvents(db,actor('alice'),src.sourceId,occ)).length,2);
}));
test('E2 failed INSERT of receipt rolls back implicit generated expectation creation',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),monthly(),clock),a=await account(db),m=await income(db,a,'cash',10000);
 db.raw.exec("CREATE TRIGGER e2_fault BEFORE INSERT ON income_receipt_links BEGIN SELECT RAISE(ABORT,'E2_INJECTED_FAILURE'); END");
 await assert.rejects(()=>linkIncomeReceipt(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{
  idempotencyKey:key('retry-after-fault'),movementId:m.movementId,
 },clock),/E2_INJECTED_FAILURE/);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_receipt_links').get().n,0);
 db.raw.exec('DROP TRIGGER e2_fault');
 await linkIncomeReceipt(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{
  idempotencyKey:key('retry-after-fault'),movementId:m.movementId,
 },clock);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
}));
test('E2 refund credits are ineligible as paychecks or freelance receipts',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),monthly(),clock),a=await account(db);
 const expense=await postMovement(db,actor('alice'),{idempotencyKey:key('cost'),accountId:a.accountId,
  direction:'expense',amountCents:10000,method:'pix',description:'Compra',
  occurredOn:'2026-11-11'},clock);
 const refund=await refundPaidExpense(db,actor('alice'),{
  idempotencyKey:key('refund'),originalMovementId:expense.movementId,
  accountId:a.accountId,amountCents:2000,method:'pix',refundedOn:'2026-11-12',
 },clock);
 assert.deepEqual(await listAvailableIncomeMovements(db,actor('alice')),[]);
 await assert.rejects(()=>linkIncomeReceipt(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{
  idempotencyKey:key('wrong-refund-link'),movementId:refund.refundMovementId,
 },clock),IncomeNotFound);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_receipt_links').get().n,0);
}));
test('E2 SQL rejects any receipt link pushing an occurrence beyond exact safe cents',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),monthly(),clock);
 await changeExpectation(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{idempotencyKey:key('prepare'),state:'confirmed'},clock);
 const a=await account(db);
 const raw=db.raw.prepare("INSERT INTO posted_cash_movements(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,occurred_on,created_at) VALUES(?,?,?,?,'income',?,'pix','Large receipt','2026-11-11',?)");
 const assign=db.raw.prepare('INSERT INTO income_receipt_links(owner_user_id,source_id,occurrence_key,movement_id,creation_key,created_at) VALUES(?,?,?,?,?,?)');
 db.raw.exec('BEGIN IMMEDIATE');
 for(let n=0;n<1000;n++){
  const mid=crypto.randomUUID();
  raw.run('alice',mid,key('large-'+n),a.accountId,9000000000000,clock().toISOString());
  assign.run('alice',src.sourceId,'scheduled_2026-11-30',mid,key('link-'+n),clock().toISOString());
 }
 const last=crypto.randomUUID();
 raw.run('alice',last,key('large-last'),a.accountId,9000000000000,clock().toISOString());
 db.raw.exec('COMMIT');
 await assert.rejects(()=>linkIncomeReceipt(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{
  idempotencyKey:key('overflow'),movementId:last,
 },clock),IncomeConflict);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_receipt_links').get().n,1000);
 assert.equal(db.raw.prepare('SELECT received_cents FROM income_expectation_totals').get().received_cents,9000000000000000);
}));


test('E2 over-receipt stays visibly above expectation; cancellation never implies collectible debt',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),freelance(),clock);
 const occ=await createManualExpectation(db,actor('alice'),s.sourceId,{
  idempotencyKey:key('small'),expectedOn:'2026-11-20',amountCents:5000,
 },clock);
 const a=await account(db),m=await income(db,a,'higher income',7000);
 await linkIncomeReceipt(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('higher'),movementId:m.movementId},clock);
 let e=(await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations[0];
 assert.deepEqual([e.expectedCents,e.receivedCents,e.remainingCents,e.differenceCents],[5000,7000,0,2000]);
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('cancel-higher'),state:'canceled'},clock);
 e=(await listCalendar(db,actor('alice'),'2026-11-01','2026-11-30')).expectations[0];
 assert.deepEqual([e.state,e.receivedCents,e.differenceCents],['canceled',7000,2000]);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,7000);
}));


test('E2 final Gregorian year 9999 is a valid calendar bound, not a false size error',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),{...monthly('end-of-year'),
  anchorOn:'9999-12-31'},clock);
 const cal=await listCalendar(db,actor('alice'),'9999-12-01','9999-12-31');
 assert.equal(cal.expectations.length,1);
 assert.equal(cal.expectations[0].sourceId,s.sourceId);
 assert.equal(cal.expectations[0].originalOn,'9999-12-31');
 assert.equal(cal.totals.expectedCents,300000);
}));
