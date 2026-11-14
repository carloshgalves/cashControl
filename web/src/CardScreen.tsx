import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, allPages, request } from './api.ts';
import type { Account } from './api.ts';
import { money, parseAmount, friendlyDate, monthLabel, today } from './finance.ts';
import './cards.css';
import { InvoicePaymentPanel } from './InvoicePaymentPanel.tsx';

type Card={cardId:string;name:string;institution:string|null;limitCents:number;closingDay:number;dueDay:number};
type Purchase={purchaseId:string;title:string;merchant:string|null;purchasedOn:string;totalCents:number;installments:number};
type Installment={purchaseId:string;title:string;installmentNo:number;installments:number;cycle:string;dueOn:string;amountCents:number};
type Invoice={cardId:string;cycle:string;dueOn:string;totalCents:number;paidCents:number;outstandingCents:number;state:'open'|'partially_paid'|'paid';installmentCount:number;purchaseCount:number};
type Detail={installments:Installment[];invoice?:Invoice;purchase?:Purchase};
type FormKind='card'|'purchase'|null;

export function CardScreen({onUnauthorized,accounts,onPaid,focusCardId,focusCycle,onFocusConsumed}:{
 onUnauthorized:()=>void;accounts:Account[];onPaid:()=>void;focusCardId?:string;focusCycle?:string;
 onFocusConsumed:()=>void;
}){
 const [cards,setCards]=useState<Card[]>([]),[selected,setSelected]=useState<string|null>(null);
 const [invoices,setInvoices]=useState<Invoice[]>([]),[purchases,setPurchases]=useState<Purchase[]>([]);
 const [detail,setDetail]=useState<Detail|null>(null),[form,setForm]=useState<FormKind>(null);
 const [name,setName]=useState(''),[institution,setInstitution]=useState('');
 const [limit,setLimit]=useState(''),[closing,setClosing]=useState('25'),[due,setDue]=useState('5');
 const [title,setTitle]=useState(''),[merchant,setMerchant]=useState(''),[category,setCategory]=useState('');
 const [date,setDate]=useState(today()),[amount,setAmount]=useState(''),[count,setCount]=useState('1');
 const [busy,setBusy]=useState(false),[detailBusy,setDetailBusy]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [refresh,setRefresh]=useState(0);
 const idempotencyKey=useRef(crypto.randomUUID());
 const card=cards.find(c=>c.cardId===selected);
 const fail=(e:unknown)=>{
  if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
  setError(e instanceof ApiError?
   e.status===404?'Cartão ou compra não encontrado para sua sessão.':
   e.status===409?'Não foi possível registrar esta operação. Confira os dados e tente novamente.':
   e.status===413?'Há dados demais para exibir integralmente.':'Dados inválidos ou serviço indisponível.':
   'Falha na consulta. Verifique sua conexão.');
 };
 useEffect(()=>{
  const c=new AbortController();setBusy(true);setError('');
  request<{cards:Card[]}>('/api/cards',{signal:c.signal}).then(x=>{
   if(c.signal.aborted)return;
   setCards(x.cards);setSelected(s=>x.cards.some(card=>card.cardId===focusCardId)?focusCardId!:
     x.cards.some(card=>card.cardId===s)?s:x.cards[0]?.cardId??null);
  }).catch(e=>{if(!c.signal.aborted)fail(e);}).finally(()=>{if(!c.signal.aborted)setBusy(false);});
  return ()=>c.abort();
 },[refresh,onUnauthorized,focusCardId]);
 useEffect(()=>{
  const c=new AbortController();setDetail(null);setInvoices([]);setPurchases([]);
  if(!selected)return;
  setBusy(true);setError('');
  Promise.all([allPages<Invoice>('/api/cards/'+selected+'/invoices','invoices',c.signal),
   allPages<Purchase>('/api/cards/'+selected+'/purchases','purchases',c.signal)])
  .then(([i,p])=>{if(!c.signal.aborted){setInvoices(i);setPurchases(p);}})
  .catch(e=>{if(!c.signal.aborted)fail(e);}).finally(()=>{if(!c.signal.aborted)setBusy(false);});
  return ()=>c.abort();
 },[selected,refresh,onUnauthorized]);
 useEffect(()=>{
  if(!focusCardId||!focusCycle||!cards.some(c=>c.cardId===focusCardId))return;
  const controller=new AbortController();
  request<Detail>('/api/cards/'+focusCardId+'/invoices/'+focusCycle,{signal:controller.signal})
   .then(result=>{
    if(controller.signal.aborted)return;
    setDetail(result);
    // Consume the one-shot alert target; manual card selection stays manual.
    onFocusConsumed();
   })
   .catch(cause=>{if(controller.signal.aborted)return;
    if(cause instanceof ApiError&&cause.status===401)onUnauthorized();
    else setError('A fatura do aviso não está mais disponível. Atualize os cartões.');
   });
  return ()=>controller.abort();
 },[focusCardId,focusCycle,cards,onUnauthorized,onFocusConsumed]);
 async function save(event:FormEvent){
  event.preventDefault();if(busy||!form)return;
  setBusy(true);setError('');setNotice('');
  try{
   if(form==='card'){
    const value=limit.trim()==='0'||limit.trim()==='0,00'?'0.00':parseAmount(limit);
    const close=Number(closing),expiry=Number(due);
    if(!value||!Number.isInteger(close)||close<1||close>31||
       !Number.isInteger(expiry)||expiry<1||expiry>31)throw new RangeError('Invalid card');
    const x=await request<{card:Card}>('/api/cards',{method:'POST',body:{
     idempotencyKey:idempotencyKey.current,name,institution:institution.trim()||null,
     limit:value,closingDay:close,dueDay:expiry,
    }});
    idempotencyKey.current=crypto.randomUUID();setSelected(x.card.cardId);setNotice('Cartão cadastrado sem alterar dinheiro em conta.');
   }else{
    if(!card)throw new Error('Card missing');
    const value=parseAmount(amount),installments=Number(count);
    if(!value||!Number.isInteger(installments)||installments<1||installments>60||
      Number(value.replace('.',''))<installments)throw new RangeError('Invalid installment amount');
    await request('/api/cards/'+card.cardId+'/purchases',{method:'POST',body:{
     idempotencyKey:idempotencyKey.current,title,merchant:merchant.trim()||null,
     category:category.trim()||null,purchasedOn:date,total:value,installments,
    }});
    idempotencyKey.current=crypto.randomUUID();setNotice('Compra registrada: parcelas criadas sem saída de caixa.');
   }
   setForm(null);setRefresh(n=>n+1);
  }catch(e){if(e instanceof RangeError)setError('Confira os dias, o valor e o número de parcelas. Cada parcela precisa ter ao menos R$ 0,01.');else fail(e);}
  finally{setBusy(false);}
 }
 async function openDetail(path:string){
  if(detailBusy)return;setDetailBusy(true);setError('');
  try{setDetail(await request<Detail>(path));}catch(e){fail(e);}finally{setDetailBusy(false);}
 }
 return <section className="credit-screen">
  <div className="credit-title"><div><span className="eyebrow">SPEC-004 · Cartões e faturas</span>
   <h2>Crédito, sem inventar dinheiro.</h2>
   <p>Compras geram compromissos; pagamentos parciais ou integrais debitam apenas o valor confirmado.</p></div>
   <button type="button" className="primary-btn" onClick={()=>{setForm('card');setError('');}}>＋ Novo cartão</button></div>
  {notice&&<p className="credit-notice" role="status">{notice}</p>}
  {error&&<p role="alert" className="form-error">{error} <button className="text-btn" onClick={()=>setRefresh(n=>n+1)}>Tentar novamente</button></p>}
  {form&&<form className="credit-form" aria-label={form==='card'?'Novo cartão':'Nova compra no crédito'} onSubmit={save}>
   <h3>{form==='card'?'Cadastrar cartão':'Compra em '+card?.name}</h3>
   {form==='card'?<>
    <label>Nome do cartão<input autoFocus required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Cartão principal"/></label>
    <label>Instituição (opcional)<input maxLength={80} value={institution} onChange={e=>setInstitution(e.target.value)}/></label>
    <label>Limite informado em reais<input required value={limit} onChange={e=>setLimit(e.target.value)} placeholder="1500,00" inputMode="decimal"/></label>
    <div className="credit-two"><label>Dia de fechamento<input type="number" min={1} max={31} required value={closing} onChange={e=>setClosing(e.target.value)}/></label>
    <label>Dia de vencimento<input type="number" min={1} max={31} required value={due} onChange={e=>setDue(e.target.value)}/></label></div>
   </>:<>
    <label>Descrição<input autoFocus required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Estabelecimento (opcional)<input maxLength={120} value={merchant} onChange={e=>setMerchant(e.target.value)}/></label>
    <label>Categoria (opcional)<input maxLength={80} value={category} onChange={e=>setCategory(e.target.value)}/></label>
    <div className="credit-two"><label>Data da compra<input type="date" required value={date} onChange={e=>setDate(e.target.value)}/></label>
    <label>Parcelas<input type="number" required min={1} max={60} value={count} onChange={e=>setCount(e.target.value)}/></label></div>
    <label>Valor total em reais<input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="100,01"/></label>
   </>}
   <p className="small-note">Não informe número de cartão ou CVV. A compra não movimenta dinheiro; o pagamento registrado confirma o débito.</p>
   <div className="credit-actions"><button type="submit" className="primary-btn" disabled={busy}>{busy?'Registrando…':'Confirmar registro'}</button>
   <button type="button" className="outline-btn" disabled={busy} onClick={()=>setForm(null)}>Cancelar</button></div>
  </form>}
  {busy&&<p className="credit-status" role="status">Carregando dados da sua sessão…</p>}
  {!busy&&!cards.length&&!form&&<div className="credit-empty"><h3>Nenhum cartão cadastrado</h3>
   <p>Este cadastro é opcional. Você pode seguir usando contas, Pix e dinheiro normalmente.</p>
   <button className="outline-btn" onClick={()=>setForm('card')}>Cadastrar primeiro cartão</button></div>}
  {!!cards.length&&<div className="credit-select" role="group" aria-label="Selecionar cartão">
   {cards.map(c=><button className={'credit-card '+(c.cardId===selected?'active':'')} type="button" key={c.cardId} aria-pressed={selected===c.cardId}
    onClick={()=>{setSelected(c.cardId);setForm(null);}}>
    <strong>{c.name}</strong><span>{c.institution??'Sem instituição'}</span>
    <b>{money(c.limitCents)}</b><small>Limite informativo · não é saldo</small></button>)}
  </div>}
  {card&&<><div className="credit-toolbar"><div><h3>{card.name}</h3><p>Fechamento: dia {card.closingDay} · Vencimento: dia {card.dueDay}. Dias inexistentes são ajustados para o último dia do mês.</p></div>
   <button className="primary-btn" type="button" onClick={()=>{setForm('purchase');setError('');}}>＋ Nova compra</button></div>
   <div className="credit-lists">
    <div className="credit-panel"><h3>Faturas por ciclo</h3>{!invoices.length&&<p className="small-note">Nenhuma fatura registrada.</p>}
     {invoices.map(i=><button key={i.cycle} className="credit-item" disabled={detailBusy} type="button"
      onClick={()=>void openDetail('/api/cards/'+card.cardId+'/invoices/'+i.cycle)}>
      <span><strong>{monthLabel(i.cycle)}</strong><small>Vence {friendlyDate(i.dueOn)} · {i.installmentCount} parcelas · {i.state==='paid'?'Quitada':i.state==='partially_paid'?'Parcialmente paga':'Em aberto'}</small></span><b>{money(i.outstandingCents)} pendente</b></button>)}</div>
    <div className="credit-panel"><h3>Compras registradas</h3>{!purchases.length&&<p className="small-note">Nenhuma compra neste cartão.</p>}
     {purchases.map(p=><button key={p.purchaseId} className="credit-item" disabled={detailBusy} type="button"
      onClick={()=>void openDetail('/api/cards/'+card.cardId+'/purchases/'+p.purchaseId)}>
      <span><strong>{p.title}</strong><small>{friendlyDate(p.purchasedOn)} · {p.installments}x</small></span><b>{money(p.totalCents)}</b></button>)}</div>
   </div>
   {detail&&<section className="credit-panel credit-detail" aria-label="Detalhes das parcelas">
    <div className="credit-toolbar"><h3>{detail.invoice?'Fatura de '+monthLabel(detail.invoice.cycle):detail.purchase?.title}</h3>
     <button className="outline-btn" onClick={()=>setDetail(null)}>Fechar detalhe</button></div>
    {detail.installments.map((i,index)=><div className="credit-installment" key={i.purchaseId+'-'+i.installmentNo+'-'+index}>
     <span><strong>{i.title}</strong><small>Parcela {i.installmentNo}/{i.installments} · {monthLabel(i.cycle)} · venc. {friendlyDate(i.dueOn)}</small></span>
     <b>{money(i.amountCents)}</b></div>)}
    {detail.invoice&&<InvoicePaymentPanel key={detail.invoice.cardId+'-'+detail.invoice.cycle} invoice={detail.invoice} accounts={accounts} onPaid={onPaid} onUnauthorized={onUnauthorized}/>}
   </section>}
   <p className="credit-disclaimer">Compras a crédito geram compromissos, não débitos bancários. Pagamentos de fatura debitam uma vez no fluxo de caixa. O painel geral de obrigações ainda mostra apenas compromissos comuns; para o saldo das faturas, consulte esta seção.</p>
  </>}
 </section>;
}