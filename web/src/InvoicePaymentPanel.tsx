import { useEffect,useRef,useState } from 'react';
import type { FormEvent } from 'react';
import type { Account, PaymentMethod } from './api.ts';
import { ApiError, allPages, request } from './api.ts';
import { friendlyDate, money, parseAmount, today } from './finance.ts';

export interface CreditInvoice {
 cardId:string;cycle:string;dueOn:string;totalCents:number;
 paidCents:number;outstandingCents:number;state:'open'|'partially_paid'|'paid';
}
type Payment={paymentId:string;accountId:string;amountCents:number;
 method:PaymentMethod;paidOn:string;createdAt:string;movementId:string};

export function InvoicePaymentPanel({invoice,accounts,onPaid,onUnauthorized}:{
 invoice:CreditInvoice;accounts:Account[];onPaid:()=>void;onUnauthorized:()=>void;
}){
 const [payments,setPayments]=useState<Payment[]>([]);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [accountId,setAccountId]=useState(accounts[0]?.accountId??'');
 const [amount,setAmount]=useState(''),[method,setMethod]=useState<PaymentMethod>('pix');
 const [paidOn,setPaidOn]=useState(today());
 const key=useRef(crypto.randomUUID());
 // Keep the same key only when retrying unchanged data after a network error.
 // Any field edit starts a new logical payment request.
 function edit<T>(setter:(value:T)=>void,value:T){
  key.current=crypto.randomUUID();setter(value);setError('');
 }
 const endpoint='/api/cards/'+invoice.cardId+'/invoices/'+invoice.cycle+'/payments';

 useEffect(()=>{
  const controller=new AbortController();
  setLoading(true);setPayments([]);setError('');setOpen(false);
  allPages<Payment>(endpoint,'payments',controller.signal).then(list=>{
   if(!controller.signal.aborted)setPayments(list);
  }).catch(err=>{
   if(controller.signal.aborted)return;
   if(err instanceof ApiError&&err.status===401){onUnauthorized();return;}
   setError('Não foi possível carregar o histórico de pagamentos.');
  }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return ()=>controller.abort();
 },[endpoint]);
 function start(){
  setOpen(true);setError('');key.current=crypto.randomUUID();
  setAccountId(accounts[0]?.accountId??'');
  const cents=invoice.outstandingCents;
  setAmount(cents<=90_000_000_000?
   String(Math.floor(cents/100))+'.'+String(cents%100).padStart(2,'0'):'');
  setPaidOn(today());setMethod('pix');
 }
 async function submit(e:FormEvent){
  e.preventDefault();if(busy)return;
  const decimal=parseAmount(amount);
  if(!decimal){setError('Informe um valor positivo com até duas casas decimais.');return;}
  const parts=decimal.split('.'),cents=Number(parts[0])*100+Number((parts[1]??'').padEnd(2,'0'));
  if(!Number.isSafeInteger(cents)||cents<=0||cents>invoice.outstandingCents){
   setError('O valor não pode ultrapassar o saldo pendente da fatura.');return;
  }
  if(!accounts.some(a=>a.accountId===accountId)){setError('Selecione uma conta própria.');return;}
  setBusy(true);setError('');
  try{
   await request(endpoint,{method:'POST',body:{
    idempotencyKey:key.current,accountId,amount:decimal,method,paidOn,
   }});
   key.current=crypto.randomUUID();
   setOpen(false);
   onPaid();
  }catch(err){
   if(err instanceof ApiError&&err.status===401){onUnauthorized();return;}
   if(err instanceof ApiError&&err.code==='INVOICE_OVERPAYMENT'){
    setError('O saldo da fatura foi alterado. Feche e abra a fatura novamente.');
   }else setError('Não foi possível confirmar este pagamento. A mesma solicitação poderá ser reenviada sem débito duplicado.');
  }finally{setBusy(false);}
 }
 return <section className="credit-payment-panel" aria-label="Pagamentos da fatura">
  <div className="credit-invoice-balances">
   <span>Total da fatura <strong>{money(invoice.totalCents)}</strong></span>
   <span>Já pago <strong>{money(invoice.paidCents)}</strong></span>
   <span>Em aberto <strong>{money(invoice.outstandingCents)}</strong></span>
  </div>
  <div className="credit-toolbar"><h3>Histórico de pagamentos</h3>
   {invoice.outstandingCents>0&&<button type="button" className="primary-btn" disabled={busy||loading||!accounts.length} onClick={start}>
    Registrar pagamento</button>}
  </div>
  {!accounts.length&&invoice.outstandingCents>0&&<p className="small-note">Cadastre uma conta/carteira para confirmar o débito da fatura.</p>}
  {invoice.outstandingCents===0&&<p className="credit-notice">Fatura integralmente quitada. O sistema impede nova baixa.</p>}
  {loading?<p className="credit-status">Consultando pagamentos…</p>:
   payments.length?payments.map(p=><div className="credit-installment" key={p.paymentId}>
    <span><strong>{money(p.amountCents)} · Confirmado</strong>
     <small>{friendlyDate(p.paidOn)} · {accounts.find(a=>a.accountId===p.accountId)?.name??'Conta própria'} · {p.method}</small></span>
    <span className="credit-payment-badge">Pago</span>
   </div>):<p className="small-note">Nenhuma baixa registrada neste ciclo.</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  {open&&<form className="credit-form" aria-label="Pagar fatura" onSubmit={submit}>
   <h3>Confirmar pagamento de fatura</h3>
   <p className="small-note">Este pagamento gera somente uma saída de caixa; a compra no crédito não foi debitada.</p>
   <label>Conta de débito<select required value={accountId} onChange={e=>edit(setAccountId,e.target.value)}>
    <option value="">Selecione uma conta</option>
    {accounts.map(a=><option key={a.accountId} value={a.accountId}>{a.name} · {money(a.balanceCents)}</option>)}
   </select></label>
   <label>Valor do pagamento em reais<input required inputMode="decimal" value={amount} onChange={e=>edit(setAmount,e.target.value)} placeholder="900,00"/></label>
   <div className="credit-two">
    <label>Meio de pagamento<select value={method} onChange={e=>edit(setMethod,e.target.value as PaymentMethod)}>
     <option value="pix">Pix</option><option value="cash">Espécie</option>
     <option value="debit">Débito</option><option value="bank_transfer">Transferência externa</option>
    </select></label>
    <label>Data do pagamento<input required type="date" value={paidOn} onChange={e=>edit(setPaidOn,e.target.value)}/></label>
   </div>
   <p className="small-note">Pendente antes desta baixa: {money(invoice.outstandingCents)}. Um pagamento parcial mantém o restante em aberto.</p>
   {(() => {
     const source=accounts.find(a=>a.accountId===accountId);
     const decimal=parseAmount(amount);
     const parts=decimal?.split('.')??[];
     const cents=decimal?Number(parts[0])*100+Number((parts[1]??'').padEnd(2,'0')):0;
     return source&&cents>source.balanceCents?
      <p className="form-error">A baixa fará o saldo desta conta ficar negativo. Registre apenas pagamentos que realmente ocorreram.</p>:null;
   })()}
   <div className="credit-actions">
    <button className="primary-btn" disabled={busy} type="submit">{busy?'Registrando…':'Confirmar pagamento'}</button>
    <button className="outline-btn" disabled={busy} type="button" onClick={()=>setOpen(false)}>Cancelar</button>
   </div>
  </form>}
 </section>;
}
