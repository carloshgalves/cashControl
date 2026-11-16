import { useEffect,useRef,useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError,request } from './api.ts';
import { money,parseAmount } from './finance.ts';

type Status='unreported'|'matched'|'pending_divergence';
interface Observation {
 observationId:string;cardId:string;cycle:string;reportedTotalCents:number;
 calculatedAtEntryCents:number;createdAt:string;source:'manual';
}
interface Reconciliation {
 cardId:string;cycle:string;status:Status;
 calculatedTotalCents:number;reportedTotalCents:number|null;
 differenceCents:number|null;source:'manual'|null;latestObservation:Observation|null;
}
interface Page {
 reconciliation:Reconciliation;observations:Observation[];
 hasMore:boolean;limit:number;offset:number;
}
export function InvoiceReconciliationPanel({cardId,cycle,totalCents,onUnauthorized}:{
 cardId:string;cycle:string;totalCents:number;onUnauthorized:()=>void;
}){
 const path='/api/cards/'+cardId+'/invoices/'+cycle+'/reconciliation';
 const [page,setPage]=useState<Page|null>(null),[history,setHistory]=useState<Observation[]>([]);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
 const [error,setError]=useState(''),[value,setValue]=useState(''),[showForm,setShowForm]=useState(false);
 const [showHistory,setShowHistory]=useState(false),[offset,setOffset]=useState(0);
 const key=useRef(crypto.randomUUID());
 useEffect(()=>{
  const controller=new AbortController();
  setPage(null);setHistory([]);setOffset(0);setError('');setShowForm(false);
  setLoading(true);
  request<Page>(path+'?limit=25&offset=0',{signal:controller.signal})
   .then(p=>{if(!controller.signal.aborted){setPage(p);setHistory(p.observations);setOffset(p.observations.length);}})
   .catch(e=>{
    if(controller.signal.aborted)return;
    if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
    setError('Não foi possível carregar a comparação desta fatura.');
   })
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return ()=>controller.abort();
 },[path]);
 const comparison=page?.reconciliation;
 const canLoadMore=page?.hasMore??false;
 async function add(event:FormEvent){
  event.preventDefault();if(busy)return;
  const val=value.trim();
  const normalized=/^0(?:[,.]0{1,2})?$/.test(val)?'0.00':parseAmount(val);
  if(!normalized){setError('Informe um valor não negativo válido, em reais e centavos.');return;}
  setBusy(true);setError('');
  try{
   await request(path,{method:'POST',body:{idempotencyKey:key.current,reportedTotal:normalized}});
   key.current=crypto.randomUUID();setValue('');
   const updated=await request<Page>(path+'?limit=25&offset=0');
   setPage(updated);setHistory(updated.observations);setOffset(updated.observations.length);
   setShowForm(false);setShowHistory(false);
  }catch(e){
   if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
   setError('Não foi possível salvar ou atualizar a comparação. A mesma solicitação pode ser repetida sem criar registro duplicado.');
  }finally{setBusy(false);}
 }
 async function more(){
  if(busy||loading||!page?.hasMore)return;
  setLoading(true);
  try{
   const next=await request<Page>(path+'?limit=25&offset='+offset);
   setHistory(h=>[...h,...next.observations]);setOffset(n=>n+next.observations.length);
   setPage(p=>p?{...p,hasMore:next.hasMore}:p);
  }catch(e){
   if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
   setError('Não foi possível carregar mais registros.');
  }finally{setLoading(false);}
 }
 function edit(v:string){setValue(v);key.current=crypto.randomUUID();setError('');}
 const status=comparison?.status??'unreported';
 return <section className="credit-reconcile" aria-label="Conciliação manual da fatura">
  <div className="credit-toolbar"><div><h3>Conferência com a instituição</h3>
    <p>Comparação manual do total bruto da fatura (compras e parcelas), não do saldo após pagamentos. Sem conexão bancária.</p></div>
   <span className={'credit-reconcile-tag '+status} role="status">
    {status==='matched'?'Valores coincidem':status==='pending_divergence'?'Divergência pendente':'Ainda não informada'}
   </span></div>
  {loading&&!page&&<p className="credit-status">Buscando dados informados anteriormente…</p>}
  {page&&<>
   <div className="credit-reconcile-values">
    <span>Total calculado<strong>{money(comparison?.calculatedTotalCents??totalCents)}</strong></span>
    <span>Total informado<strong>{comparison?.reportedTotalCents===null?'Não informado':money(comparison!.reportedTotalCents!)}</strong></span>
    <span>Diferença (instituição − sistema)<strong>{comparison?.differenceCents===null?'—':money(comparison!.differenceCents!)}</strong></span>
   </div>
   {status==='pending_divergence'&&<p className="credit-reconcile-pending">
    Divergência não resolvida. Examine as compras e parcelas acima e confira o documento original.
    Nenhum ajuste automático será realizado, mesmo se o cartão já estiver pago.
   </p>}
   {status==='matched'&&<p className="small-note">Os valores informados manualmente coincidem com o cálculo atual. Isso não comprova conexão ou confirmação automática do banco.</p>}
   <div className="credit-actions">
    <button type="button" className="outline-btn" disabled={busy} onClick={()=>{setShowForm(v=>!v);setError('');}}>
     {comparison?.latestObservation?'Registrar novo valor informado':'Informar total da instituição'}</button>
    {!!history.length&&<button type="button" className="text-btn" onClick={()=>setShowHistory(v=>!v)}>
     {showHistory?'Ocultar histórico':'Ver histórico das informações'}</button>}
   </div>
  </>}
  {showForm&&<form className="credit-form" aria-label="Informar total da instituição" onSubmit={add}>
   <label>Total bruto da fatura informado pela instituição (R$)
    <input required inputMode="decimal" placeholder="Ex.: 1500,00" value={value}
     onChange={e=>edit(e.target.value)}/></label>
   <p className="small-note">Fonte: valor digitado por você. Se o total não coincidir, o status seguirá pendente. Registros anteriores são preservados.</p>
   <div className="credit-actions">
    <button className="primary-btn" type="submit" disabled={busy}>{busy?'Salvando…':'Salvar valor informado'}</button>
    <button className="outline-btn" type="button" disabled={busy} onClick={()=>setShowForm(false)}>Cancelar</button>
   </div>
  </form>}
  {showHistory&&<section className="credit-reconcile-history" aria-label="Histórico de valores informados">
   {history.map((h,i)=><div className="credit-installment" key={h.observationId}>
    <span><strong>{money(h.reportedTotalCents)}</strong>
     <small>Calculado no registro: {money(h.calculatedAtEntryCents)} · {new Date(h.createdAt).toLocaleString('pt-BR')} · Origem: informado manualmente</small></span>
    {i===0&&<span className="credit-reconcile-tag">Mais recente</span>}
   </div>)}
   {canLoadMore&&<button type="button" className="outline-btn" disabled={loading} onClick={()=>void more()}>
    {loading?'Carregando…':'Carregar mais informações'}</button>}
  </section>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
