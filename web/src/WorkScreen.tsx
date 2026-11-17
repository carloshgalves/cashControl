import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {ApiError,allPages,request} from './api.ts';
import {money,parseAmount,friendlyDate} from './finance.ts';
import './cards.css';
type State='planned'|'confirmed'|'realized'|'canceled';
type Work={workId:string;title:string;client:string|null;expectedCents:number|null;plannedOn:string|null;dueOn:string|null;category:string|null;notes:string|null;state:State;receivedCents:number;costCents:number;netCents:number;remainingCents:number|null;receiptState:string};
type Move={movementId:string;direction:'income'|'expense';description:string;amountCents:number;occurredOn:string;refundedCents:number};
type Event={state:State;reason:string|null;createdAt:string};
const states:Record<State,string>={planned:'Previsto',confirmed:'Confirmado',realized:'Realizado',canceled:'Cancelado'};
const receipts:Record<string,string>={unspecified:'Valor combinado não informado',received:'Recebido',unreceived:'A receber',partial:'Parcialmente recebido',above_expected:'Acima do combinado'};
const empty={title:'',client:'',expected:'',plannedOn:'',dueOn:'',category:'',notes:''};
export function WorkScreen({onUnauthorized,refreshKey,onNewMovement}:{onUnauthorized:()=>void;refreshKey:number;onNewMovement:(direction:'income'|'expense')=>void}){
 const [works,setWorks]=useState<Work[]>([]),[selected,setSelected]=useState<string|null>(null);
 const [links,setLinks]=useState<Move[]>([]),[available,setAvailable]=useState<Move[]>([]),[history,setHistory]=useState<Event[]>([]);
 const [create,setCreate]=useState(false),[draft,setDraft]=useState(empty);
 const [state,setState]=useState<State|' ' >(' '),[reason,setReason]=useState(''),[movement,setMovement]=useState('');
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[version,setVersion]=useState(0);
 const keys=useRef({create:crypto.randomUUID(),state:crypto.randomUUID(),link:crypto.randomUUID()});
 const working=works.find(w=>w.workId===selected);
 const usable=(!loading&&!busy);
 function fail(e:unknown){if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}setError(e instanceof ApiError&&e.status===409?'Operação em conflito. Confira o estado atual e os vínculos.':'Não foi possível concluir. Confira os dados e tente novamente.');}
 useEffect(()=>{
  const c=new AbortController();setLoading(true);setError('');
  Promise.all([allPages<Work>('/api/works','works',c.signal),allPages<Move>('/api/work-movements/available','movements',c.signal),
   selected?allPages<Move>('/api/works/'+selected+'/movements','movements',c.signal):Promise.resolve([]),
   selected?allPages<Event>('/api/works/'+selected+'/states','states',c.signal):Promise.resolve([])])
  .then(([w,a,l,h])=>{if(c.signal.aborted)return;setWorks(w);setAvailable(a);setLinks(l);setHistory(h);})
  .catch(e=>{if(!c.signal.aborted)fail(e);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});
  return ()=>c.abort();
 },[selected,version,refreshKey,onUnauthorized]);
 function select(id:string){if(id===selected)return;setSelected(id);setLinks([]);setHistory([]);setState(' ');setReason('');setMovement('');keys.current.state=crypto.randomUUID();keys.current.link=crypto.randomUUID();setLoading(true);}
 async function save(e:FormEvent){e.preventDefault();if(!usable)return;
  const expected=draft.expected.trim()===''?null:/^0(?:[,.]0{1,2})?$/.test(draft.expected.trim())?'0.00':parseAmount(draft.expected);
  if(draft.expected.trim()!==''&&expected===null){setError('Valor combinado inválido.');return;}
  setBusy(true);setError('');
  try{const result=await request<{work:Work}>('/api/works',{method:'POST',body:{idempotencyKey:keys.current.create,title:draft.title,client:draft.client.trim()||null,expected,
    plannedOn:draft.plannedOn||null,dueOn:draft.dueOn||null,category:draft.category.trim()||null,notes:draft.notes.trim()||null}});
   keys.current.create=crypto.randomUUID();setCreate(false);setDraft(empty);select(result.work.workId);setVersion(v=>v+1);
  }catch(e){fail(e);}finally{setBusy(false);}
 }
 async function change(e:FormEvent){e.preventDefault();if(!usable||!working||state===' ')return;setBusy(true);setError('');
  try{await request('/api/works/'+working.workId+'/states',{method:'POST',body:{idempotencyKey:keys.current.state,state,reason:state==='canceled'?reason.trim()||null:null}});
   keys.current.state=crypto.randomUUID();setState(' ');setReason('');setVersion(v=>v+1);
  }catch(e){fail(e);}finally{setBusy(false);}
 }
 async function link(e:FormEvent){e.preventDefault();if(!usable||!working||!movement)return;setBusy(true);setError('');
  try{await request('/api/works/'+working.workId+'/movements',{method:'POST',body:{idempotencyKey:keys.current.link,movementId:movement}});
   keys.current.link=crypto.randomUUID();setMovement('');setVersion(v=>v+1);
  }catch(e){fail(e);}finally{setBusy(false);}
 }
 const update=(k:keyof typeof draft,v:string)=>{keys.current.create=crypto.randomUUID();setDraft(d=>({...d,[k]:v}));};
 return <section className="credit-screen" aria-label="Trabalhos e serviços">
  <div className="credit-toolbar"><div><h2>Trabalhos e serviços</h2><p>Cadastro opcional. Planejar ou realizar um serviço não registra receita. Vincule somente movimentações efetivas.</p></div>
   <button type="button" className="primary-btn" disabled={busy||loading} onClick={()=>setCreate(v=>!v)}>＋ Novo trabalho</button></div>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {create&&<form className="credit-form" aria-label="Novo trabalho" onSubmit={save}><fieldset disabled={busy} className="work-fieldset">
    <label>Nome do trabalho<input required maxLength={120} value={draft.title} onChange={e=>update('title',e.target.value)}/></label>
    <label>Contratante (opcional)<input maxLength={120} value={draft.client} onChange={e=>update('client',e.target.value)}/></label>
    <label>Valor combinado em reais (opcional)<input inputMode="decimal" value={draft.expected} onChange={e=>update('expected',e.target.value)}/></label>
    <div className="credit-two"><label>Data prevista<input type="date" value={draft.plannedOn} onChange={e=>update('plannedOn',e.target.value)}/></label><label>Data prevista de recebimento<input type="date" value={draft.dueOn} onChange={e=>update('dueOn',e.target.value)}/></label></div>
    <label>Categoria (opcional)<input maxLength={80} value={draft.category} onChange={e=>update('category',e.target.value)}/></label>
    <label>Observações (opcional)<textarea maxLength={500} value={draft.notes} onChange={e=>update('notes',e.target.value)}/></label>
    <button type="submit" className="primary-btn" disabled={!usable}>Cadastrar trabalho</button></fieldset>
  </form>}
  {loading&&<p role="status">Carregando registros…</p>}
  {!loading&&!works.length&&<p>Não há trabalhos cadastrados. Entradas e despesas podem continuar independentes.</p>}
  <div className="credit-panel">{works.map(w=><button key={w.workId} type="button" className="credit-item" disabled={busy||loading} aria-pressed={selected===w.workId} onClick={()=>select(w.workId)}>
    <span><strong>{w.title}</strong><small>{states[w.state]} · {receipts[w.receiptState]}</small></span><b>{money(w.netCents)}</b></button>)}</div>
  {!loading&&working&&<section className="credit-panel" aria-label="Detalhe do trabalho">
    <h3>{working.title}</h3><p>{states[working.state]} · {receipts[working.receiptState]}</p>
    <p className="small-note">{working.client??'Sem contratante informado'} · {working.category??'Sem categoria'}{working.plannedOn?' · Previsto: '+friendlyDate(working.plannedOn):''}{working.dueOn?' · Recebimento previsto: '+friendlyDate(working.dueOn):''}</p>
    {working.notes&&<p>{working.notes}</p>}
    <div className="credit-reconcile-values">
     <span>Recebido<strong>{money(working.receivedCents)}</strong></span>
     <span>Custos líquidos<strong>{money(working.costCents)}</strong></span>
     <span>Resultado líquido realizado<strong>{money(working.netCents)}</strong></span>
     <span>Valor combinado<strong>{working.expectedCents===null?'Não informado':money(working.expectedCents)}</strong></span>
     <span>Diferença ainda não recebida<strong>{working.remainingCents===null?'Não informada':money(working.remainingCents)}</strong></span>
    </div>
    {working.state==='canceled'&&<p className="small-note">Cancelado: os valores históricos permanecem. A diferença frente ao combinado não comprova dívida exigível; nenhum estorno ou recebimento é criado.</p>}
    {working.state!=='canceled'&&<form className="credit-form" aria-label="Alterar situação do trabalho" onSubmit={change}><fieldset disabled={busy} className="work-fieldset">
      <label>Nova situação<select required value={state} onChange={e=>{keys.current.state=crypto.randomUUID();setState(e.target.value as State|' ');}}>
       <option value=" " disabled>Selecione</option>{working.state==='planned'&&<option value="confirmed">Confirmado</option>}
       {working.state!=='realized'&&<option value="realized">Realizado</option>}<option value="canceled">Cancelado</option></select></label>
      {state==='canceled'&&<label>Motivo do cancelamento (opcional)<input maxLength={120} value={reason} onChange={e=>{keys.current.state=crypto.randomUUID();setReason(e.target.value);}}/></label>}
      <button className="outline-btn" disabled={!usable||state===' '} type="submit">Registrar situação</button></fieldset>
    </form>}
    <h3>Recebimentos e custos vinculados</h3>
    <p className="small-note">Selecione uma movimentação já registrada. Cada lançamento pode pertencer a um único trabalho; reembolsos reduzem seus custos. Pagamentos de fatura não são custos individualizados.</p>
    <button className="outline-btn" type="button" disabled={busy} onClick={()=>onNewMovement('income')}>Registrar recebimento</button>
    <button className="outline-btn" type="button" disabled={busy} onClick={()=>onNewMovement('expense')}>Registrar custo</button>
    <form className="credit-form" aria-label="Vincular movimentação" onSubmit={link}><fieldset disabled={busy} className="work-fieldset">
      <label>Movimentação disponível<select required value={movement} onChange={e=>{keys.current.link=crypto.randomUUID();setMovement(e.target.value);}}>
       <option value="">Selecione</option>{available.map(m=><option key={m.movementId} value={m.movementId}>{m.direction==='income'?'Recebimento':'Custo'} · {m.description} · {money(m.amountCents)} · {m.occurredOn}</option>)}</select></label>
      <button className="primary-btn" type="submit" disabled={!usable||!movement}>Vincular movimentação</button></fieldset>
    </form>
    {links.length===0&&<p>Nenhum recebimento ou custo vinculado.</p>}
    {links.map(m=><div key={m.movementId} className="credit-installment"><span><strong>{m.description}</strong><small>{m.direction==='income'?'Recebimento':'Custo'} · {m.occurredOn}{m.refundedCents?' · Reembolso: '+money(m.refundedCents):''}</small></span><b>{money(m.amountCents-m.refundedCents)}</b></div>)}
    <h3>Histórico de situações</h3>
    {history.map((h,i)=><div className="credit-installment" key={i}><span><strong>{states[h.state]}</strong><small>{h.reason??'Sem motivo informado'} · {new Date(h.createdAt).toLocaleString('pt-BR')}</small></span></div>)}
  </section>}
 </section>;
}
