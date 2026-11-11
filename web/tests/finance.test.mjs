import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, money, monthBounds, shiftMonth, weekOf, weekRange,
  groupWeeks, validateWeekReconciliation, dueOn, timeline, accountBalancePreview,
} from '../src/finance.ts';
const mk = (id, occurredOn, amountCents, direction, eventKind='ordinary')=>({
  movementId:id, accountId:'account-a', occurredOn, amountCents, direction,
  eventKind, method:'pix', description:'Registro '+id, sourceLabel:null,category:null,
  refundOfMovementId:null,refundedCents:0,createdAt:'2026-11-10T12:00:00Z',
});
test('Brazilian money input parses integer centavos, grouped BRL and rejects ambiguity',()=>{
  assert.equal(parseAmount('R$ 1.234,56'),'1234.56');
  assert.equal(parseAmount('12,3'),'12.30');
  assert.equal(parseAmount('0,01'),'0.01');
  assert.equal(parseAmount('40'),'40.00');
  assert.equal(parseAmount('1.234,5'),'1234.50');
  assert.equal(parseAmount('12.34'),'12.34');
  for(const v of ['0','0,00','-1','1.2.3','12,345','1e3','','Infinity','9'.repeat(15)]){
    assert.equal(parseAmount(v),null,v);
  }
  assert.equal(money(123456),'R$ 1.234,56');
  assert.equal(money(-121),'−R$ 1,21'.replace('−','-')); // Intl may use ordinary hyphen in Node
});
test('month arithmetic, leap years and four complete weekly buckets',()=>{
  assert.deepEqual(monthBounds('2024-02'),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(monthBounds('2026-02'),{from:'2026-02-01',to:'2026-02-28'});
  assert.deepEqual(monthBounds('2026-11'),{from:'2026-11-01',to:'2026-11-30'});
  assert.equal(shiftMonth('2026-12',1),'2027-01');
  assert.equal(shiftMonth('2026-01',-1),'2025-12');
  assert.deepEqual(weekRange('2026-11',3),{from:'2026-11-22',to:'2026-11-30',title:'22–30'});
  assert.deepEqual([7,8,14,15,21,22,30].map(x=>weekOf('2026-11-'+String(x).padStart(2,'0'))),[0,1,1,2,2,3,3]);
  assert.throws(()=>monthBounds('2026-13'));
  assert.throws(()=>weekRange('2026-11',4));
});
test('week bars classify reimbursements separately and reconcile all centavos exactly',()=>{
  const movements=[
    mk('a','2026-11-01',101,'income'),
    mk('b','2026-11-08',75,'expense'),
    mk('c','2026-11-22',35,'income','refund'),
    mk('d','2026-12-01',250,'income'),
    mk('e','2026-11-30',20,'expense'),
  ];
  const w=groupWeeks(movements,'2026-11');
  assert.deepEqual(w.map(x=>x.netCents),[101,-75,0,15]);
  assert.equal(w[3].refundsCents,35);
  assert.equal(w[3].count,2);
  assert(validateWeekReconciliation(w,{incomeCents:101,expensesCents:95,refundsCents:35,netCents:41}));
  assert(!validateWeekReconciliation(w,{incomeCents:102,expensesCents:95,refundsCents:35,netCents:42}));
  assert.throws(()=>groupWeeks([mk('z','2026-11-10',1.5,'income')],'2026-11'));
});
test('calendar due dates omit canceled/paid obligations and movement timeline merges transfers once',()=>{
  const obligations=[
    {obligationId:'a',title:'A',dueOn:'2026-11-25',outstandingCents:2000},
    {obligationId:'b',title:'B',dueOn:'2026-11-25',outstandingCents:0},
    {obligationId:'c',title:'C',dueOn:'2026-12-01',outstandingCents:1000},
  ];
  assert.deepEqual(dueOn(obligations,'2026-11-25').map(x=>x.obligationId),['a']);
  const accounts=[{accountId:'account-a',name:'Banco',balanceCents:10000},
    {accountId:'account-b',name:'Dinheiro',balanceCents:0}];
  const transfers=[{transferId:'t',sourceAccountId:'account-a',targetAccountId:'account-b',
    transferredOn:'2026-11-12',amountCents:1050}];
  const items=timeline([mk('m','2026-11-11',350,'expense')],transfers,accounts,'2026-11');
  assert.deepEqual(items.map(x=>x.kind),['transfer','expense']);
  assert.equal(items[0].subtitle,'Banco → Dinheiro');
});
test('preview does not mutate source balances or allow invalid value to be displayed as confirmed',()=>{
  const account={accountId:'a',name:'Banco',balanceCents:2500};
  assert.equal(accountBalancePreview(account,'10,05','expense'),1495);
  assert.equal(accountBalancePreview(account,'10,05','income'),3505);
  assert.equal(accountBalancePreview(account,'100,00','transfer'),-750);
  assert.equal(accountBalancePreview(account,'12,345','expense'),null);
  assert.equal(account.balanceCents,2500);
});
