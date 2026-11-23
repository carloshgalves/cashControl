import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {ApiError,allPages,request} from './api.ts';
import {money,monthBounds,parseBankInvoiceAmount} from './finance.ts';
import './cards.css';

type Source={
 sourceId:string;name:string;relationship:string;payKind:string;periodicity:string;
 anchorOn:string|null;endOn:string|null;intervalDays:number|null;fixedNetCents:number|null;
};
type Item={
 sourceId:string;sourceName:string;occurrenceKey:string;kind:'manual'|'scheduled';
 originalOn:string;currentOn:string;expectedCents:number;receivedCents:number;
 remainingCents:number;state:'planned'|'confirmed'|'delayed'|'canceled';
};
type Calendar={basis:string;expectations:Item[];totals:{expectedCents:number;receivedCents:number;remainingCents:number}};
type Move={movementId:string;amountCents:number;occurredOn:string;description:string};
type Event={state:string;newOn:string;reason:string|null;createdAt:string};
const types:{[k:string]:string}={
 employment:'Emprego CLT',public:'Cargo público',continuous:'Contrato contínuo',
 freelance:'Freelancer/autônomo',other:'Outro vínculo',
 fixed:'Fixa',variable:'Variável',mixed:'Mista',occasional:'Avulsa',
 none:'Sem periodicidade',weekly:'Semanal',fortnightly:'Quinzenal',monthly:'Mensal',custom:'Intervalo próprio',
 planned:'Prevista',confirmed:'Expectativa confirmada (não recebida)',
 delayed:'Adiada',canceled:'Cancelada',
};
const blank={name:'',relationship:'employment',payKind:'fixed',periodicity:'monthly',anchorOn:'',endOn:'',intervalDays:'',fixedNet:''};
const manualBlank={sourceId:'',expectedOn:'',amount:''};
const eventBlank={state:'confirmed',newOn:'',reason:''};
function parseForecast(raw:string):string|null{
 const normalized=parseBankInvoiceAmount(raw);
 if(!normalized)return null;
 const cents=BigInt(normalized.replace('.',''));
 return cents<=9000000000000n?normalized:null;
}
export function IncomeScreen({month,onUnauthorized,onRecordIncome,refreshKey}:{
 month:string;onUnauthorized:()=>void;onRecordIncome:()=>void;refreshKey:number;
}){
 const [sources,setSources]=useState<Source[]>([]);
 const [calendar,setCalendar]=useState<Calendar|null>(null);
 const [available,setAvailable]=useState<Move[]>([]);
 const [history,setHistory]=useState<Event[]>([]),[receipts,setReceipts]=useState<Move[]>([]);
 const [selected,setSelected]=useState<string|null>(null);
 const [sourceForm,setSourceForm]=useState(false),[manualForm,setManualForm]=useState(false);
 const [draft,setDraft]=useState(blank),[plan,setPlan]=useState(manualBlank),[event,setEvent]=useState(eventBlank);
 const [movementId,setMovementId]=useState('');
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const keys=useRef({source:crypto.randomUUID(),manual:crypto.randomUUID(),event:crypto.randomUUID(),link:crypto.randomUUID()});
 const canAct=ready&&!loading&&!busy;
 const chosen=calendar?.expectations.find(e=>e.sourceId+'|'+e.occurrenceKey===selected)??null;
 const endpoint=chosen?'/api/income-sources/'+chosen.sourceId+'/expectations/'+chosen.occurrenceKey:null;
 function fail(e:unknown){
  if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
  setError(e instanceof ApiError&&e.status===409?'O registro mudou ou já foi vinculado. Atualize e confira as informações.':
   e instanceof ApiError&&e.status===413?'Há registros demais no período. Escolha um período menor.':
   'Não foi possível confirmar ou consultar os dados. Confira a conexão e tente novamente.');
 }
 useEffect(()=>{
  const c=new AbortController();setLoading(true);setReady(false);setError('');
  const {from,to}=monthBounds(month);
  Promise.all([
   allPages<Source>('/api/income-sources','sources',c.signal),
   request<{calendar:Calendar}>('/api/income-calendar?from='+from+'&to='+to,{signal:c.signal}),
   allPages<Move>('/api/income-receipts/available','movements',c.signal),
  ]).then(([s,v,m])=>{
   if(c.signal.aborted)return;
   setSources(s);setCalendar(v.calendar);setAvailable(m);
   setSelected(prev=>v.calendar.expectations.some(x=>x.sourceId+'|'+x.occurrenceKey===prev)?prev:null);
   setReady(true);
  }).catch(e=>{if(!c.signal.aborted)fail(e);})
   .finally(()=>{if(!c.signal.aborted)setLoading(false);});
  return ()=>c.abort();
 },[month,revision,refreshKey,onUnauthorized]);
 useEffect(()=>{
  const c=new AbortController();setHistory([]);setReceipts([]);
  if(!endpoint)return()=>c.abort();
  Promise.all([
   allPages<Event>(endpoint+'/events','events',c.signal),
   allPages<Move>(endpoint+'/receipts','receipts',c.signal),
  ]).then(([h,m])=>{if(!c.signal.aborted){setHistory(h);setReceipts(m);}})
   .catch(e=>{if(!c.signal.aborted)fail(e);});
  return()=>c.abort();
 },[endpoint,revision,onUnauthorized]);
 async function commit<T>(url:string,body:unknown,after:()=>void){
  setBusy(true);setError('');
  try{
   await request<T>(url,{method:'POST',body});
   // A committed POST followed by failed GET must retain the same
   // idempotency key. A retry is safe if the previous write succeeded.
   const {from,to}=monthBounds(month);
   const [s,v,m]=await Promise.all([
    allPages<Source>('/api/income-sources','sources'),
    request<{calendar:Calendar}>('/api/income-calendar?from='+from+'&to='+to),
    allPages<Move>('/api/income-receipts/available','movements')
   ]);
   setSources(s);setCalendar(v.calendar);setAvailable(m);
   setReady(true);after();setRevision(x=>x+1);
  }catch(e){fail(e);}finally{setBusy(false);}
 }
 function srcChange(k:keyof typeof blank,v:string){keys.current.source=crypto.randomUUID();setDraft(d=>({...d,[k]:v}));}
 async function addSource(e:FormEvent){
  e.preventDefault();if(!canAct)return;
  const fixedNet=draft.fixedNet.trim()?parseForecast(draft.fixedNet):null;
  if(draft.fixedNet.trim()&&fixedNet===null){setError('Valor líquido inválido.');return;}
  if(draft.periodicity==='custom'&&!/^(?:[1-9]|[1-9]\d|[1-2]\d\d|3[0-5]\d|36[0-5])$/.test(draft.intervalDays)){setError('Intervalo deve ser de 1 a 365 dias.');return;}
  await commit('/api/income-sources',{
   idempotencyKey:keys.current.source,name:draft.name,relationship:draft.relationship,payKind:draft.payKind,
   periodicity:draft.periodicity,anchorOn:draft.periodicity==='none'?null:draft.anchorOn,
   endOn:draft.periodicity==='none'?null:draft.endOn||null,
   intervalDays:draft.periodicity==='custom'?Number(draft.intervalDays):null,fixedNet
  },()=>{keys.current.source=crypto.randomUUID();setSourceForm(false);setDraft(blank);});
 }
 async function addManual(e:FormEvent){
  e.preventDefault();if(!canAct)return;
  const amt=parseForecast(plan.amount);
  if(amt===null||!plan.sourceId){setError('Informe uma fonte e um valor previsto válido.');return;}
  await commit('/api/income-sources/'+plan.sourceId+'/expectations',{
   idempotencyKey:keys.current.manual,expectedOn:plan.expectedOn,amount:amt,
  },()=>{keys.current.manual=crypto.randomUUID();setManualForm(false);setPlan(manualBlank);});
 }
 async function updateState(e:FormEvent){
  e.preventDefault();if(!canAct||!endpoint||!chosen)return;
  await commit(endpoint+'/events',{
   idempotencyKey:keys.current.event,state:event.state,
   newOn:event.state==='delayed'?event.newOn:null,
   reason:event.state!=='confirmed'?event.reason.trim()||null:null,
  },()=>{keys.current.event=crypto.randomUUID();setEvent(eventBlank);});
 }
 async function associate(e:FormEvent){
  e.preventDefault();if(!canAct||!endpoint||!movementId)return;
  await commit(endpoint+'/receipts',{idempotencyKey:keys.current.link,movementId},
   ()=>{keys.current.link=crypto.randomUUID();setMovementId('');});
 }
 const choose=(e:Item)=>{
  const next=e.sourceId+'|'+e.occurrenceKey;
  if(next===selected)return;
  setSelected(next);setEvent(eventBlank);setMovementId('');
  keys.current.event=crypto.randomUUID();keys.current.link=crypto.randomUUID();
 };
 const updatePlan=(k:keyof typeof manualBlank,v:string)=>{keys.current.manual=crypto.randomUUID();setPlan(s=>({...s,[k]:v}));};
 return <section className="credit-screen income-screen" aria-label="Fontes e expectativas de renda">
  <div className="credit-toolbar"><div><h2>Fontes e expectativas de renda</h2>
   <p>Uma expectativa não é saldo nem receita confirmada. Apenas o registro financeiro de um recebimento altera a conta.</p>
   </div><div className="credit-actions">
   <button type="button" className="primary-btn" disabled={!canAct} onClick={()=>setSourceForm(v=>!v)}>＋ Nova fonte</button>
   <button type="button" className="outline-btn" disabled={!canAct||!sources.length} onClick={()=>setManualForm(v=>!v)}>＋ Previsão pontual</button></div></div>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {loading&&<p role="status">Carregando planejamento…</p>}
  {!loading&&!ready&&<button className="outline-btn" onClick={()=>setRevision(v=>v+1)}>Tentar novamente</button>}
  {sourceForm&&<form className="credit-form" aria-label="Nova fonte de renda" onSubmit={addSource}><fieldset className="work-fieldset" disabled={busy}>
   <label>Nome da fonte<input required maxLength={120} value={draft.name} onChange={e=>srcChange('name',e.target.value)}/></label>
   <label>Tipo de vínculo<select value={draft.relationship} onChange={e=>srcChange('relationship',e.target.value)}>
    {['employment','public','continuous','freelance','other'].map(v=><option key={v} value={v}>{types[v]}</option>)}</select></label>
   <label>Natureza da remuneração<select value={draft.payKind} onChange={e=>{
    srcChange('payKind',e.target.value);if(!['fixed','mixed'].includes(e.target.value))setDraft(d=>({...d,fixedNet:''}));
   }}>{['fixed','variable','mixed','occasional'].map(v=><option key={v} value={v}>{types[v]}</option>)}</select></label>
   <label>Periodicidade informada<select value={draft.periodicity} onChange={e=>srcChange('periodicity',e.target.value)}>
    {['none','weekly','fortnightly','monthly','custom'].map(v=><option key={v} value={v}>{types[v]}</option>)}</select></label>
   {draft.periodicity!=='none'&&<div className="credit-two">
    <label>Primeira data prevista<input type="date" required value={draft.anchorOn} onChange={e=>srcChange('anchorOn',e.target.value)}/></label>
    <label>Última data do ciclo (opcional)<input type="date" value={draft.endOn} onChange={e=>srcChange('endOn',e.target.value)}/></label>
   </div>}
   {draft.periodicity==='custom'&&<label>Repetir a cada N dias<input type="number" min="1" max="365" required value={draft.intervalDays} onChange={e=>srcChange('intervalDays',e.target.value)}/></label>}
   {['fixed','mixed'].includes(draft.payKind)&&<label>Parcela fixa líquida prevista (R$, opcional)
    <input inputMode="decimal" placeholder="Ex.: 3000,00" value={draft.fixedNet} onChange={e=>srcChange('fixedNet',e.target.value)}/></label>}
   <p className="small-note">Apenas uma parcela fixa positiva com periodicidade definida gera eventos futuros. Remuneração variável exige previsão informada manualmente.</p>
   <button className="primary-btn" disabled={!canAct} type="submit">Cadastrar fonte sem creditar caixa</button>
  </fieldset></form>}
  {manualForm&&<form className="credit-form" aria-label="Nova expectativa pontual" onSubmit={addManual}><fieldset className="work-fieldset" disabled={busy}>
   <label>Fonte<select required value={plan.sourceId} onChange={e=>updatePlan('sourceId',e.target.value)}>
    <option value="">Selecione</option>{sources.map(s=><option value={s.sourceId} key={s.sourceId}>{s.name}</option>)}</select></label>
   <label>Data informada<input type="date" required value={plan.expectedOn} onChange={e=>updatePlan('expectedOn',e.target.value)}/></label>
   <label>Valor previsto em reais<input required inputMode="decimal" value={plan.amount} onChange={e=>updatePlan('amount',e.target.value)}/></label>
   <button className="primary-btn" disabled={!canAct}>Registrar expectativa, sem receber</button>
  </fieldset></form>}
  {ready&&<><div className="credit-reconcile-values" aria-label="Resumo de expectativas do mês">
   <span>Expectativa não cancelada<strong>{money(calendar?.totals.expectedCents??0)}</strong></span>
   <span>Recebimentos reais vinculados<strong>{money(calendar?.totals.receivedCents??0)}</strong></span>
   <span>Diferença informativa<strong>{money(calendar?.totals.remainingCents??0)}</strong></span>
  </div>
  <p className="small-note">Recebimentos mostrados acima já estão no fluxo efetivo geral; não serão somados novamente. Períodos vazios não geram receitas de R$ 0,00.</p>
  <div className="credit-panel" aria-label="Fontes cadastradas">
   <h3>Fontes ({sources.length})</h3>
   {!sources.length&&<p>Nenhuma fonte cadastrada. A receita normal pode ser registrada sem fonte.</p>}
   {sources.map(s=><div className="credit-installment" key={s.sourceId}>
    <span><strong>{s.name}</strong><small>{types[s.relationship]} · {types[s.payKind]} · {types[s.periodicity]}</small></span>
    <b>{s.fixedNetCents===null?'Sem parcela fixa':money(s.fixedNetCents)}</b>
   </div>)}
  </div>
  <section className="credit-panel" aria-label="Calendário de expectativas">
   <h3>Expectativas — {month}</h3>
   {!calendar?.expectations.length&&<p>Sem expectativas para este período. Isso não é um recebimento de valor zero.</p>}
   {calendar?.expectations.map(e=><button type="button" className="credit-item" aria-pressed={selected===e.sourceId+'|'+e.occurrenceKey}
    key={e.sourceId+'|'+e.occurrenceKey} disabled={busy} onClick={()=>choose(e)}>
    <span><strong>{e.sourceName} · {e.currentOn}</strong>
    <small>{types[e.state]} · {e.kind==='manual'?'Informada pontualmente':'Recorrente'} · Recebido {money(e.receivedCents)}</small></span>
    <b>{money(e.expectedCents)}</b></button>)}
  </section>
  {chosen&&endpoint&&<section className="credit-panel" aria-label="Detalhe da expectativa">
   <h3>Detalhe — {chosen.sourceName}</h3>
   <p>{chosen.currentOn} · {types[chosen.state]} · Valor previsto: {money(chosen.expectedCents)}</p>
   <p className="small-note">Recebido: {money(chosen.receivedCents)} · Ainda não vinculado: {money(chosen.remainingCents)}. Confirmar a expectativa não movimenta dinheiro.</p>
   {chosen.originalOn!==chosen.currentOn&&<p className="small-note">Data original preservada: {chosen.originalOn}</p>}
   {chosen.state!=='canceled'&&<form className="credit-form" aria-label="Alterar expectativa" onSubmit={updateState}><fieldset className="work-fieldset" disabled={busy}>
    <label>Situação<select value={event.state} onChange={e=>{keys.current.event=crypto.randomUUID();setEvent(v=>({...v,state:e.target.value}));}}>
     <option value="confirmed">Confirmar previsão (não pagamento)</option><option value="delayed">Adiar previsão</option><option value="canceled">Cancelar previsão</option></select></label>
    {event.state==='delayed'&&<label>Nova data<input type="date" required min={chosen.currentOn} value={event.newOn} onChange={e=>{keys.current.event=crypto.randomUUID();setEvent(v=>({...v,newOn:e.target.value}));}}/></label>}
    {event.state!=='confirmed'&&<label>Motivo (opcional)<input maxLength={120} value={event.reason} onChange={e=>{keys.current.event=crypto.randomUUID();setEvent(v=>({...v,reason:e.target.value}));}}/></label>}
    <button type="submit" className="outline-btn" disabled={!canAct}>Registrar situação</button>
   </fieldset></form>}
   <h3>Associar recebimento já efetuado</h3>
   <p className="small-note">Use somente entradas de dinheiro reais. O vínculo não registra dinheiro outra vez.</p>
   <button type="button" className="outline-btn" onClick={onRecordIncome}>Registrar entrada financeira</button>
   {chosen.state!=='canceled'&&<form className="credit-form" aria-label="Vincular receita real" onSubmit={associate}><fieldset className="work-fieldset" disabled={busy}>
    <label>Entrada não vinculada<select value={movementId} required onChange={e=>{keys.current.link=crypto.randomUUID();setMovementId(e.target.value);}}>
     <option value="">Selecione</option>{available.map(m=><option key={m.movementId} value={m.movementId}>{m.occurredOn} · {m.description} · {money(m.amountCents)}</option>)}</select></label>
    <button type="submit" className="primary-btn" disabled={!canAct||!movementId}>Vincular sem duplicar entrada</button>
   </fieldset></form>}
   <h3>Recebimentos associados</h3>
   {!receipts.length&&<p>Nenhum recebimento efetivo foi associado.</p>}
   {receipts.map(m=><div className="credit-installment" key={m.movementId}><span><strong>{m.description}</strong><small>{m.occurredOn}</small></span><b>{money(m.amountCents)}</b></div>)}
   <h3>Histórico imutável da expectativa</h3>
   {!history.length&&<p>Sem alteração de situação registrada.</p>}
   {history.map((h,i)=><div className="credit-installment" key={i}><span><strong>{types[h.state]??h.state} · {h.newOn}</strong><small>{h.reason??'Sem motivo'} · {new Date(h.createdAt).toLocaleString('pt-BR')}</small></span></div>)}
  </section>}</>}
 </section>;
}
