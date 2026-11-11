import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertText, alertBand, eventValue, findPayable, filterOptions,
  trailURL, alertsURL, statusLabel, kindLabel,
} from '../src/trail.ts';
const event=(overrides={})=>({
  id:'obligation:123',date:'2026-11-16',kind:'obligation',status:'planned',
  title:'Energia',amountCents:8500,accountId:null,obligationId:'ob-1',relatedId:null,...overrides,
});
test('event labels identify past, projected and canceled explicitly without income illusion',()=>{
  assert.equal(statusLabel.planned,'Previsto');
  assert.equal(statusLabel.canceled,'Cancelado');
  assert.equal(statusLabel.overdue,'Atrasado');
  assert.equal(kindLabel.transfer,'Transferência interna');
  assert.equal(eventValue(event()),'R$ 85,00');
  assert.equal(eventValue(event({kind:'cancellation',status:'canceled',amountCents:0})),'Sem débito');
  assert.equal(eventValue(event({kind:'income',status:'realized',amountCents:1050})),'+R$ 10,50');
  assert.equal(eventValue(event({kind:'payment',status:'realized',amountCents:1050})),'−R$ 10,50');
  assert.equal(eventValue(event({kind:'refund',status:'realized',amountCents:1050})),'+R$ 10,50');
  assert.equal(eventValue(event({kind:'transfer',status:'realized',amountCents:1050})),'R$ 10,50');
  assert.deepEqual(filterOptions.map(x=>x.value),['all','realized','pending','overdue','planned','canceled']);
});
test('D-10 / D-5 and overdue text is accessible without relying only on a color or badge',()=>{
  assert.equal(alertBand({level:'D-10'}),'D-10');
  assert.equal(alertBand({level:'D-5'}),'D-5');
  assert.equal(alertBand({level:'overdue'}),'Atrasado');
  assert.equal(alertText({daysUntil:0}),'Vence hoje');
  assert.equal(alertText({daysUntil:1}),'Vence em 1 dia');
  assert.equal(alertText({daysUntil:5}),'Vence em 5 dias');
  assert.equal(alertText({daysUntil:-1}),'Atrasada há 1 dia');
});
test('payment CTA only for a currently open obligation, not paid/canceled/transfer records',()=>{
  const obligations=[
    {obligationId:'ob-1',outstandingCents:8500},
    {obligationId:'ob-2',outstandingCents:0},
  ];
  assert.equal(findPayable(event(),obligations)?.obligationId,'ob-1');
  assert.equal(findPayable(event({obligationId:'ob-2'}),obligations),undefined);
  assert.equal(findPayable(event({kind:'cancellation',obligationId:'ob-1'}),obligations),undefined);
  assert.equal(findPayable(event({kind:'transfer',obligationId:'ob-1'}),obligations),undefined);
});
test('month queries include explicit civil reference and bounded page, no owner identifier',()=>{
  const page=trailURL('2026-11','2026-11-11','pending',30);
  const parsed=new URL('https://cash.example'+page);
  assert.equal(parsed.searchParams.get('from'),'2026-11-01');
  assert.equal(parsed.searchParams.get('to'),'2026-11-30');
  assert.equal(parsed.searchParams.get('asOf'),'2026-11-11');
  assert.equal(parsed.searchParams.get('status'),'pending');
  assert.equal(new URL('https://cash.example'+trailURL('2026-11','2026-11-11','overdue')).searchParams.get('status'),'overdue');
  assert.equal(parsed.searchParams.get('limit'),'30');
  assert.equal(parsed.searchParams.get('offset'),'30');
  assert(!parsed.searchParams.has('ownerId'));
  assert.equal(new URL('https://cash.example'+alertsURL('2026-11-11')).searchParams.get('limit'),'20');
});
