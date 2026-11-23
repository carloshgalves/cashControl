import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {ApiError,request} from './api.ts';
import {money,parseBankInvoiceAmount,today} from './finance.ts';

type EligibleIntention={intentionId:string;title:string;state:'planning'|'reserved'|'converted'|'excluded';amountCents:number;plannedOn:string;reservedCents:number};
type Income={sourceId:string;occurrenceKey:string;sourceName:string;date:string;state:'planned'|'confirmed'|'delayed';remainingCents:number};
type Point={
 date:string;outstandingPaymentsCents:number;explicitExpectedIncomeCents:number;
 releasedReservationCents:number;hypotheticalPaymentCents:number;hypotheticalCommitmentCents:number;
 conservativeCashAfterAssumedPaymentsCents:number;plannedCashIncludingUnreceivedIncomeCents:number;
 conservativeFreeMarginCents:number;plannedFreeMarginCents:number;
 conservativeCashNegative:boolean;plannedCashNegative:boolean;
 conservativeMarginNegative:boolean;plannedMarginNegative:boolean;
};
type ScenarioReport={
 from:string;to:string;openingRealCashCents:number;existingOutstandingObligationsCents:number;
 existingOutstandingCardInvoicesCents:number;activeVirtualReserveCents:number;
 unreceivedExplicitIncomeCents:number;unreceivedSources:Income[];unlinkedRealIncomeCount:number;
 hypothetical:{amountCents:number;purchaseOn:string;dueOn:string;intentionId:string|null;replacedExistingReserveCents:number}|null;
 conservative:{endingCashCents:number;endingFreeMarginCents:number;lowestCashCents:number;lowestMarginCents:number};
 planned:{endingCashCents:number;endingFreeMarginCents:number;lowestCashCents:number;lowestMarginCents:number};
 points:Point[];
};
function plusDays(x:string,n:number){
 const d=new Date(x+'T12:00:00.000Z');
 d.setUTCDate(d.getUTCDate()+n);
 return d.toISOString().slice(0,10);
}
const fromCents=(c:number)=>{
 const v=BigInt(c);return (v/100n).toString()+'.'+(v%100n).toString().padStart(2,'0');
};
const parse=(v:string)=>parseBankInvoiceAmount(v);
const sourceName:Record<Income['state'],string>={
 planned:'Planejada, não recebida',confirmed:'Confirmada pelo usuário, não recebida integralmente',delayed:'Adiada, não recebida',
};
export function ScenarioPanel({intentions,refreshKey,onUnauthorized}:{
 intentions:EligibleIntention[];refreshKey:number;onUnauthorized:()=>void;
}){
 const [draft,setDraft]=useState(()=>{
  const from=today();return {from,to:plusDays(from,90),include:false,intentionId:'',
   amount:'',purchaseOn:from,dueOn:from};
 });
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [result,setResult]=useState<ScenarioReport|null>(null);
 const requestSeq=useRef(0);
 useEffect(()=>{
  ++requestSeq.current;setResult(null);setError('');setBusy(false);
 },[refreshKey]);
 const eligible=intentions.filter(i=>i.state==='planning'||i.state==='reserved');
 const chosen=eligible.find(i=>i.intentionId===draft.intentionId);
 function edit(patch:Partial<typeof draft>){
  ++requestSeq.current;setDraft(d=>({...d,...patch}));
  setResult(null);setError('');setBusy(false);
 }
 async function simulate(e:FormEvent){
  e.preventDefault();if(busy)return;
  const value=draft.include?parse(chosen?fromCents(chosen.amountCents):draft.amount):null;
  if(draft.include&&(!value||value==='0.00')){
   setError('Informe o valor de compra positivo, sem arredondamento.');return;
  }
  if(draft.from>draft.to||draft.include&&(draft.purchaseOn<draft.from||draft.dueOn<draft.purchaseOn||draft.dueOn>draft.to)){
   setError('Datas da compra e do vencimento devem estar ordenadas e dentro do período.');return;
  }
  const seq=++requestSeq.current;setBusy(true);setResult(null);setError('');
  try{
   const response=await request<{simulation:ScenarioReport}>('/api/planning/simulate',{
    method:'POST',body:{
     from:draft.from,to:draft.to,
     ...(draft.include?{hypothetical:{amount:value,purchaseOn:draft.purchaseOn,
      dueOn:draft.dueOn,...(chosen?{intentionId:chosen.intentionId}:{})}}:{}),
    },
   });
   if(seq!==requestSeq.current)return;
   setResult(response.simulation);
  }catch(err){
   if(seq!==requestSeq.current)return;
   if(err instanceof ApiError&&err.status===401){onUnauthorized();return;}
   setError(err instanceof ApiError&&err.status===409?
    'O saldo, a reserva ou a intenção mudou durante a simulação. Atualize o cenário.':
    err instanceof ApiError&&err.status===413?
    'Existem dados demais para uma simulação precisa. Reduza o período ou o volume de registros.':
    'Não foi possível calcular. Confira datas, valores e a conexão.');
  }finally{if(seq===requestSeq.current)setBusy(false);}
 }
 return <section className="scenario-panel" aria-label="Simulação financeira sem lançamento">
  <div className="scenario-header">
   <div><h3>Simular cenários conservador e planejado</h3>
    <p>Compare contas e faturas pendentes com a renda que você informou. Nenhuma simulação efetiva compra, reserva ou pagamento.</p></div>
  </div>
  <form className="scenario-form" aria-label="Parâmetros da simulação" onSubmit={simulate}>
   <fieldset disabled={busy}>
    <div className="scenario-fields">
     <label>Data inicial da simulação<input required type="date" value={draft.from}
      onChange={e=>edit({from:e.target.value})}/></label>
     <label>Data final da simulação<input required type="date" value={draft.to}
      onChange={e=>edit({to:e.target.value})}/></label>
    </div>
    <label className="scenario-choice"><input type="checkbox" checked={draft.include}
     onChange={e=>edit({include:e.target.checked})}/> Incluir compra hipotética, sem gravar</label>
    {draft.include&&<div className="scenario-fields">
     <label>Compra simulada<select value={draft.intentionId}
      onChange={e=>{
       const selected=eligible.find(i=>i.intentionId===e.target.value);
       edit({intentionId:e.target.value,amount:selected?fromCents(selected.amountCents):'',
        purchaseOn:selected?.plannedOn??draft.from,dueOn:selected?.plannedOn??draft.from});
      }}>
      <option value="">Compra livre (não cadastrada)</option>
      {eligible.map(i=><option key={i.intentionId} value={i.intentionId}>
       {i.title}{i.state==='reserved'?' · reserva ativa':''}
      </option>)}
     </select></label>
     <label>Valor hipotético (R$)<input required inputMode="decimal" value={chosen?fromCents(chosen.amountCents):draft.amount}
      disabled={!!chosen} placeholder="500,00" onChange={e=>edit({amount:e.target.value})}/></label>
     <label>Data de concretização hipotética<input required type="date" value={draft.purchaseOn}
      onChange={e=>edit({purchaseOn:e.target.value})}/></label>
     <label>Vencimento hipotético<input required type="date" value={draft.dueOn}
      onChange={e=>edit({dueOn:e.target.value})}/></label>
     {chosen?.state==='reserved'&&<p className="scenario-warning">A reserva existente de {money(chosen.reservedCents)}
       será substituída pela obrigação hipotética na data de compra, sem dupla contagem.</p>}
    </div>}
    <p className="small-note">A projeção parte do saldo bancário atual, não reconstrói um saldo histórico da data inicial.
     Assume apenas para calcular que contas ainda abertas serão pagas nos vencimentos; contas atrasadas entram no primeiro dia.
     O cenário planejado inclui expectativas explícitas ainda não recebidas, sem garantir o crédito.</p>
    <button type="submit" className="primary-btn" disabled={busy}>
     {busy?'Calculando…':'Simular sem gravar compra ou pagamento'}</button>
   </fieldset>
  </form>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {result&&<section className="scenario-results" aria-label="Resultado comparativo da simulação">
   <p className="small-note">Base atual: caixa {money(result.openingRealCashCents)}, obrigações abertas
    {money(result.existingOutstandingObligationsCents)}, faturas {money(result.existingOutstandingCardInvoicesCents)},
    reservas {money(result.activeVirtualReserveCents)}. Esses valores não foram modificados.</p>
   <div className="scenario-compare">
    <article className="scenario-card">
     <span className="eyebrow">Conservador · sem renda futura presumida</span>
     <h4>Margem ao fim do período</h4>
     <strong className={result.conservative.endingFreeMarginCents<0?'negative':''}>
      {money(result.conservative.endingFreeMarginCents)}</strong>
     <p>Caixa após pagamentos hipotéticos: {money(result.conservative.endingCashCents)}</p>
     <p>Menor margem: {money(result.conservative.lowestMarginCents)} · menor caixa projetado:
      {money(result.conservative.lowestCashCents)}</p>
    </article>
    <article className="scenario-card">
     <span className="eyebrow">Planejado · renda explicitamente prevista</span>
     <h4>Margem ao fim do período</h4>
     <strong className={result.planned.endingFreeMarginCents<0?'negative':''}>
      {money(result.planned.endingFreeMarginCents)}</strong>
     <p>Caixa se as expectativas entrarem: {money(result.planned.endingCashCents)}</p>
     <p>Menor margem: {money(result.planned.lowestMarginCents)} · menor caixa projetado:
      {money(result.planned.lowestCashCents)}</p>
    </article>
   </div>
   {(result.conservative.lowestCashCents<0||result.conservative.lowestMarginCents<0)&&
    <p role="status" className="scenario-warning">Risco no cenário conservador: ao menos uma data apresenta caixa
     projetado ou margem preventiva negativa. Este alerta não bloqueia suas decisões.</p>}
   {result.unreceivedExplicitIncomeCents>0&&
    <p className="scenario-warning">O cenário planejado adiciona {money(result.unreceivedExplicitIncomeCents)}
     em valores explicitamente esperados, ainda não recebidos integralmente. Não são saldo bancário.</p>}
   {result.unreceivedExplicitIncomeCents>0&&result.unlinkedRealIncomeCount>0&&
    <p role="status" className="scenario-warning">Há {result.unlinkedRealIncomeCount} entrada(s) bancária(s) já
     registradas sem vínculo a expectativas. Se alguma corresponder aos valores ainda esperados,
     o cenário planejado pode superestimar o saldo. Vincule os recebimentos corretos na seção Rendas;
     não realizamos associações automáticas por suposição.</p>}
   <div className="scenario-table-wrap">
    <table className="scenario-table">
     <caption>Projeção por data · não é extrato bancário</caption>
     <thead><tr><th>Data</th><th>Contas/faturas previstas</th><th>Renda não recebida</th>
      <th>Compra hipotética</th><th>Caixa conservador</th><th>Caixa planejado</th>
      <th>Margem conservadora</th><th>Margem planejada</th></tr></thead>
     <tbody>{result.points.map(p=><tr key={p.date}>
      <th scope="row">{p.date}</th><td>{money(p.outstandingPaymentsCents)}</td>
      <td>{money(p.explicitExpectedIncomeCents)}</td><td>{p.hypotheticalCommitmentCents>0?
       'Compromisso '+money(p.hypotheticalCommitmentCents):p.hypotheticalPaymentCents>0?
       'Pagamento '+money(p.hypotheticalPaymentCents):'—'}</td>
      <td className={p.conservativeCashNegative?'negative':''}>{money(p.conservativeCashAfterAssumedPaymentsCents)}</td>
      <td className={p.plannedCashNegative?'negative':''}>{money(p.plannedCashIncludingUnreceivedIncomeCents)}</td>
      <td className={p.conservativeMarginNegative?'negative':''}>{money(p.conservativeFreeMarginCents)}</td>
      <td className={p.plannedMarginNegative?'negative':''}>{money(p.plannedFreeMarginCents)}</td>
     </tr>)}</tbody>
    </table>
   </div>
   <details className="scenario-expectations">
    <summary>Expectativas não recebidas incluídas ({result.unreceivedSources.length})</summary>
    {!result.unreceivedSources.length&&<p>Nenhuma expectativa explicitamente cadastrada neste período.</p>}
    {result.unreceivedSources.map(x=><div className="planning-event" key={x.sourceId+'|'+x.occurrenceKey}>
     <strong>{x.sourceName} · {x.date}</strong>
     <small>{sourceName[x.state]}. Saldo ainda esperado: {money(x.remainingCents)}.</small>
    </div>)}
   </details>
   <p className="small-note">Ambos os cenários são hipóteses sobre o mesmo saldo atual. O conservador desconta as
    obrigações conhecidas, sem adicionar renda futura. O planejado só adiciona valores explícitos ainda esperados.
    Prazos, pagamentos e receitas efetivas podem divergir; estas projeções não executam nenhuma operação.</p>
  </section>}
 </section>;
}
