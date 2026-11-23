import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {ApiError,allPages,request} from './api.ts';
import {money,parseBankInvoiceAmount} from './finance.ts';
import './planning.css';
type State='planning'|'reserved'|'converted'|'excluded';
type Action='reserve'|'plan'|'exclude'|'convert';
type Intention={
 intentionId:string;title:string;description:string|null;amountCents:number;plannedOn:string;
 state:State;reservedCents:number;obligationId:string|null;createdAt:string;
};
type Event={eventId:string;intentionId:string;action:Action;reservedCents:number;obligationId:string|null;createdAt:string};
type Summary={
 cashBalanceCents:number;obligationsCents:number;cardInvoicesCents:number;activeReserveCents:number;
 freeMarginCents:number;activeReserveCount:number;
 basis:'current_cash_minus_current_commitments_and_active_reserves';
};
const names:Record<State,string>={planning:'Planejamento',reserved:'Reserva ativa',converted:'Compra concretizada',excluded:'Retirada do planejamento'};
const actions:Record<Action,string>={reserve:'Reserva ativada/ajustada',plan:'Retorno ao planejamento',exclude:'Intenção retirada',convert:'Compra concretizada'};
const blank={title:'',description:'',amount:'',plannedOn:''};
const parse=(v:string)=>{
 const d=parseBankInvoiceAmount(v);
 return d!==null&&BigInt(d.replace('.',''))<=9000000000000n?d:null;
};
export function PlanningScreen({refreshKey,onChanged,onUnauthorized}:{
 refreshKey:number;onChanged:()=>void;onUnauthorized:()=>void;
}){
 const [intentions,setIntentions]=useState<Intention[]>([]);
 const [summary,setSummary]=useState<Summary|null>(null);
 const [events,setEvents]=useState<Event[]>([]);
 const [selected,setSelected]=useState<string|null>(null);
 const [draft,setDraft]=useState(blank),[createOpen,setCreateOpen]=useState(false);
 const [reserveValue,setReserveValue]=useState('');
 const [confirmed,setConfirmed]=useState(false);
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[revision,setRevision]=useState(0);
 const keys=useRef({create:crypto.randomUUID(),action:crypto.randomUUID()});
 const current=intentions.find(i=>i.intentionId===selected)??null;
 const usable=ready&&!loading&&!busy;
 function fail(e:unknown){
  if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
  setError(e instanceof ApiError&&e.status===409?'O planejamento mudou ou a operação conflita com o histórico. Confira os valores.':
   e instanceof ApiError&&e.status===413?'Existem registros demais para exibir um resultado completo.':
   'Não foi possível atualizar o planejamento. Confira a conexão e tente novamente.');
 }
 useEffect(()=>{
  const c=new AbortController();setLoading(true);setReady(false);setError('');
  Promise.all([
   allPages<Intention>('/api/intentions','intentions',c.signal),
   request<{summary:Summary}>('/api/planning-summary',{signal:c.signal}),
  ]).then(([records,s])=>{
   if(c.signal.aborted)return;
   setIntentions(records);setSummary(s.summary);
   setSelected(prev=>records.some(i=>i.intentionId===prev)?prev:null);
   setReady(true);
  }).catch(e=>{if(!c.signal.aborted)fail(e);})
   .finally(()=>{if(!c.signal.aborted)setLoading(false);});
  return ()=>c.abort();
 },[revision,refreshKey,onUnauthorized]);
 useEffect(()=>{
  const c=new AbortController();setEvents([]);
  if(!selected)return()=>c.abort();
  allPages<Event>('/api/intentions/'+selected+'/events','events',c.signal)
   .then(v=>{if(!c.signal.aborted)setEvents(v);})
   .catch(e=>{if(!c.signal.aborted)fail(e);});
  return()=>c.abort();
 },[selected,revision,refreshKey,onUnauthorized]);
 async function commit(url:string,body:unknown,complete:()=>void){
  if(!usable)return;setBusy(true);setError('');
  try{
   await request(url,{method:'POST',body});
   const [records,s]=await Promise.all([
    allPages<Intention>('/api/intentions','intentions'),
    request<{summary:Summary}>('/api/planning-summary'),
   ]);
   setIntentions(records);setSummary(s.summary);complete();setRevision(x=>x+1);onChanged();
  }catch(e){fail(e);}
  finally{setBusy(false);}
 }
 function edit(field:keyof typeof draft,v:string){
  keys.current.create=crypto.randomUUID();setDraft(d=>({...d,[field]:v}));
 }
 async function create(e:FormEvent){
  e.preventDefault();const amount=parse(draft.amount);
  if(!amount||amount==='0.00'){setError('Informe valor estimado positivo em reais.');return;}
  await commit('/api/intentions',{idempotencyKey:keys.current.create,title:draft.title.trim(),
    description:draft.description.trim()||null,amount,plannedOn:draft.plannedOn},()=>{
    keys.current.create=crypto.randomUUID();setDraft(blank);setCreateOpen(false);
  });
 }
 function choose(i:Intention){
  setSelected(i.intentionId);setReserveValue((i.reservedCents>0?i.reservedCents:i.amountCents)/100+'');
  setConfirmed(false);keys.current.action=crypto.randomUUID();
 }
 async function transition(action:Action){
  if(!current||!usable)return;
  const amount=action==='reserve'?parse(reserveValue):null;
  if(action==='reserve'&&(!amount||amount==='0.00')){setError('Informe uma reserva virtual positiva.');return;}
  if(action==='convert'&&!confirmed){setError('Confirme a intenção de assumir a obrigação.');return;}
  await commit('/api/intentions/'+current.intentionId+'/events',{
   idempotencyKey:keys.current.action,action,
   ...(amount?{reserveAmount:amount}:{}),
  },()=>{
   keys.current.action=crypto.randomUUID();setConfirmed(false);
   setReserveValue('');
  });
 }
 return <section className="planning-screen" aria-label="Intenções e reservas preventivas">
  <header className="planning-header">
   <div><h2>Planejamento de compras</h2>
    <p>Intenções não são dívidas. Reservas reduzem somente sua margem projetada e nunca bloqueiam ou movimentam dinheiro real.</p></div>
   <button className="primary-btn" onClick={()=>setCreateOpen(x=>!x)} disabled={!usable}>＋ Nova intenção</button>
  </header>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {loading&&<p role="status" className="loading-panel">Atualizando reservas e obrigações…</p>}
  {!loading&&!ready&&<button className="outline-btn" onClick={()=>setRevision(x=>x+1)}>Tentar novamente</button>}
  {summary&&ready&&<section aria-label="Margem preventiva projetada" className="planning-summary">
   <div><small>Saldo real atual</small><strong>{money(summary.cashBalanceCents)}</strong></div>
   <div><small>Obrigações em aberto</small><strong>{money(summary.obligationsCents)}</strong></div>
   <div><small>Faturas de cartão pendentes</small><strong>{money(summary.cardInvoicesCents)}</strong></div>
   <div><small>Reservas ativas ({summary.activeReserveCount})</small><strong>{money(summary.activeReserveCents)}</strong></div>
   <div className="planning-margin"><small>Margem preventiva, não saldo bancário</small>
    <strong className={summary.freeMarginCents<0?'negative':''}>{money(summary.freeMarginCents)}</strong></div>
   {summary.freeMarginCents<0&&<p role="status">A margem projetada ficou negativa. Isso é um alerta de planejamento, não bloqueio de compra.</p>}
   <p className="small-note">Critério conservador F1: saldo atual − obrigações abertas − faturas pendentes − reservas ativas, sem somar salários apenas previstos. Cenários com datas e renda futura são da F2.</p>
  </section>}
  {createOpen&&<form aria-label="Cadastrar intenção de compra" className="planning-form" onSubmit={create}>
   <fieldset disabled={busy}>
    <label>O que pretende comprar?<input required maxLength={120} value={draft.title} onChange={e=>edit('title',e.target.value)}/></label>
    <label>Descrição opcional<textarea maxLength={500} value={draft.description} onChange={e=>edit('description',e.target.value)} rows={2}/></label>
    <label>Valor estimado (R$)<input required inputMode="decimal" placeholder="500,00" value={draft.amount} onChange={e=>edit('amount',e.target.value)}/></label>
    <label>Data possível da compra<input required type="date" value={draft.plannedOn} onChange={e=>edit('plannedOn',e.target.value)}/></label>
    <p className="small-note">Cadastrar não reservará dinheiro e não criará uma obrigação.</p>
    <button className="primary-btn" type="submit" disabled={!usable}>Salvar no planejamento</button>
   </fieldset>
  </form>}
  {ready&&<div className="planning-layout">
   <section aria-label="Lista de intenções" className="planning-list">
    <h3>Minhas intenções</h3>
    {!intentions.length&&<p>Nenhuma intenção cadastrada. Você pode começar sem conta ou cartão.</p>}
    {intentions.map(i=><button type="button" key={i.intentionId} aria-pressed={selected===i.intentionId}
     className={'planning-item '+(selected===i.intentionId?'selected':'')}
     onClick={()=>choose(i)}>
     <span><strong>{i.title}</strong><small>{names[i.state]} · Compra possível: {i.plannedOn}</small></span>
     <span><strong>{money(i.amountCents)}</strong><small>{i.reservedCents>0?'Reservado: '+money(i.reservedCents):i.state==='converted'?'Convertida em obrigação':'Sem reserva ativa'}</small></span>
    </button>)}
   </section>
   {current&&<section aria-label="Detalhe da intenção" className="planning-detail">
    <h3>{current.title}</h3>
    <p>{current.description??'Sem descrição complementar.'}</p>
    <p className="small-note">Data possível: {current.plannedOn} · Valor previsto: {money(current.amountCents)}</p>
    {current.state==='converted'&&<p>Compra concretizada: a reserva virtual foi substituída por uma obrigação real.
     O compromisso pode ser acompanhado na Agenda e no Panorama; seu pagamento é registrado separadamente.</p>}
    {current.state==='excluded'&&<p>Intenção retirada do planejamento. Seu histórico foi preservado e nenhuma compra ou pagamento foi apagado.</p>}
    {['planning','reserved'].includes(current.state)&&<>
     <div className="planning-actions">
      <label>Reservar virtualmente (R$)<input inputMode="decimal" value={reserveValue}
       onChange={e=>{setReserveValue(e.target.value);keys.current.action=crypto.randomUUID();}}/></label>
      <button type="button" className="outline-btn" disabled={!usable} onClick={()=>transition('reserve')}>
       {current.state==='reserved'?'Ajustar reserva':'Ativar reserva preventiva'}</button>
      {current.state==='reserved'&&<button type="button" className="outline-btn" disabled={!usable} onClick={()=>transition('plan')}>
       Desativar reserva e voltar ao planejamento</button>}
     </div>
     <div className="planning-conversion">
      <h4>Concretizar compra</h4>
      <p>A compra assumirá uma obrigação de {money(current.amountCents)} com vencimento em {current.plannedOn}.
       A reserva virtual será removida no mesmo registro, sem lançar pagamento nem alterar saldo bancário.</p>
      <label><input type="checkbox" disabled={!usable} checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);keys.current.action=crypto.randomUUID();}}/>
       Confirmo que a compra foi concretizada e quero registrar o compromisso.</label>
      <button type="button" className="primary-btn" disabled={!usable||!confirmed}
       onClick={()=>transition('convert')}>Converter em obrigação sem duplicar reserva</button>
     </div>
     <button type="button" className="text-btn" disabled={!usable} onClick={()=>transition('exclude')}>
      Retirar intenção do planejamento (preservar histórico)</button>
    </>}
    <h4>Histórico de transições</h4>
    {!events.length&&<p className="small-note">Nenhuma mudança. A intenção continua em planejamento.</p>}
    {events.map(e=><div className="planning-event" key={e.eventId}>
      <span>{actions[e.action]}</span><small>{new Date(e.createdAt).toLocaleString('pt-BR')}</small>
      {e.action==='reserve'&&<strong>{money(e.reservedCents)}</strong>}
    </div>)}
   </section>}
  </div>}
 </section>;
}
