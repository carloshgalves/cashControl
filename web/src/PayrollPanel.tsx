import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {ApiError,allPages,request} from './api.ts';
import type {Obligation} from './api.ts';
import {money,parseBankInvoiceAmount} from './finance.ts';
type Source={sourceId:string;name:string;payKind:string;periodicity:string;fixedNetCents:number|null};
type Revision={sourceId:string;effectiveOn:string;netCents:number;reason:string;createdAt:string};
type Discount={label:string;amount:string};
type Component={kind:'overtime'|'bonus'|'other'|'reduction';reason:string;amount:string};
type Statement={
 statementId:number;sourceId:string;occurrenceKey:string;netCents:number;grossCents:number|null;
 discounts:{label:string;amountCents:number}[];components:{kind:string;reason:string;amountCents:number}[];
 discountsTotalCents:number;componentsTotalCents:number;
 grossDifferenceCents:number|null;grossStatus:'not_provided'|'matched'|'pending';
 baseNetCents:number;componentsDifferenceCents:number;createdAt:string;
};
type Withholding={paymentId:string;statementId:number;discountIndex:number;discountLabel:string;obligationId:string;
 amountCents:number;confirmedOn:string;createdAt:string;origin:'salary_withholding_confirmed'};
const empty={net:'',gross:'',discounts:[] as Discount[],components:[] as Component[]};
const labels:Record<Component['kind'],string>={overtime:'Horas extras',bonus:'Gratificação',other:'Outra verba',reduction:'Redução pontual'};
const parse=(value:string)=>{const result=parseBankInvoiceAmount(value);return result!==null&&BigInt(result.replace('.',''))<=9000000000000n?result:null;};
function brlCents(v:number|null){return v===null?'Não informado':money(v);}
export function PayrollPanel({source,occurrenceKey,onChanged,onUnauthorized}:{
 source:Source;occurrenceKey:string|null;onChanged:()=>void;onUnauthorized:()=>void;
}){
 const root='/api/income-sources/'+source.sourceId;
 const salary=occurrenceKey?root+'/expectations/'+occurrenceKey+'/salary':null;
 const [versions,setVersions]=useState<Revision[]>([]),[statements,setStatements]=useState<Statement[]>([]);
 const [withheld,setWithheld]=useState<Withholding[]>([]),[obligations,setObligations]=useState<Obligation[]>([]);
 const [retention,setRetention]=useState({discountIndex:'',obligationId:'',amount:'',confirmedOn:'',confirmed:false});
 const [latest,setLatest]=useState<Statement|null>(null);
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[revOpen,setRevOpen]=useState(false),[statementOpen,setStatementOpen]=useState(false);
 const [rev,setRev]=useState({effectiveOn:'',net:'',reason:''}),[form,setForm]=useState(empty);
 const [localRevision,setLocalRevision]=useState(0);
 const keys=useRef({rev:crypto.randomUUID(),statement:crypto.randomUUID(),retention:crypto.randomUUID()});
 const usable=ready&&!loading&&!busy;
 const canRaise=source.fixedNetCents!==null&&source.fixedNetCents>0&&source.periodicity!=='none';
 function fail(e:unknown){
  if(e instanceof ApiError&&e.status===401){onUnauthorized();return;}
  setError(e instanceof ApiError&&e.status===409?'Conflito: a vigência ou o registro já existe, ou o histórico foi alterado. Confira as informações.':
   'Não foi possível registrar ou carregar a remuneração. Confira a conexão e tente novamente.');
 }
 useEffect(()=>{
  const c=new AbortController();setReady(false);setLoading(true);setError('');
  Promise.all([
   allPages<Revision>(root+'/salary-revisions','revisions',c.signal),
   salary?request<{statement:Statement|null;history:Statement[]}>(salary+'?limit=25&offset=0',{signal:c.signal}):
    Promise.resolve({statement:null,history:[]}),
   salary?allPages<Withholding>(salary+'/withholdings','withholdings',c.signal):Promise.resolve([] as Withholding[]),
   allPages<Obligation>('/api/obligations','obligations',c.signal),
  ]).then(([v,s,w,o])=>{
   if(c.signal.aborted)return;setVersions(v);setLatest(s.statement);setStatements(s.history);
   setWithheld(w);setObligations(o);setReady(true);
  }).catch(e=>{if(!c.signal.aborted)fail(e);})
   .finally(()=>{if(!c.signal.aborted)setLoading(false);});
  return ()=>c.abort();
 },[root,salary,localRevision,onUnauthorized]);
 async function commit(url:string,data:unknown,done:()=>void){
  if(!usable)return;setBusy(true);setError('');
  try{
   await request(url,{method:'POST',body:data});
   // Read back before rotating idempotency key: a successful POST with a
   // failed GET must be safe to retry unchanged.
   const [v,s,w,o]=await Promise.all([
    allPages<Revision>(root+'/salary-revisions','revisions'),
    salary?request<{statement:Statement|null;history:Statement[]}>(salary+'?limit=25&offset=0'):
     Promise.resolve({statement:null,history:[]}),
    salary?allPages<Withholding>(salary+'/withholdings','withholdings'):Promise.resolve([] as Withholding[]),
    allPages<Obligation>('/api/obligations','obligations'),
   ]);
   setVersions(v);setLatest(s.statement);setStatements(s.history);
   setWithheld(w);setObligations(o);done();
   setLocalRevision(x=>x+1);onChanged();
  }catch(e){fail(e);}finally{setBusy(false);}
 }
 function editRev(field:keyof typeof rev,v:string){keys.current.rev=crypto.randomUUID();setRev(s=>({...s,[field]:v}));}
 async function saveRevision(e:FormEvent){
  e.preventDefault();const net=parse(rev.net);
  if(net===null||net==='0.00'){setError('Informe um salário líquido positivo válido.');return;}
  await commit(root+'/salary-revisions',{idempotencyKey:keys.current.rev,
   effectiveOn:rev.effectiveOn,net,reason:rev.reason},()=>{
    keys.current.rev=crypto.randomUUID();setRev({effectiveOn:'',net:'',reason:''});setRevOpen(false);
   });
 }
 function editNet(k:'net'|'gross',v:string){
  keys.current.statement=crypto.randomUUID();setForm(s=>({...s,[k]:v,...(k==='gross'&&!v.trim()?{discounts:[]}: {})}));
 }
 function editDiscount(i:number,k:keyof Discount,v:string){
  keys.current.statement=crypto.randomUUID();setForm(s=>({...s,discounts:s.discounts.map((d,j)=>j===i?{...d,[k]:v}:d)}));
 }
 function editComponent(i:number,k:keyof Component,v:string){
  keys.current.statement=crypto.randomUUID();setForm(s=>({...s,components:s.components.map((d,j)=>j===i?{...d,[k]:v}:d)}));
 }
 function addDiscount(){keys.current.statement=crypto.randomUUID();setForm(s=>({...s,discounts:[...s.discounts,{label:'INSS',amount:''}]}));}
 function addComponent(){keys.current.statement=crypto.randomUUID();setForm(s=>({...s,components:[...s.components,{kind:'overtime',reason:'',amount:''}]}));}
 function removeDiscount(i:number){keys.current.statement=crypto.randomUUID();setForm(s=>({...s,discounts:s.discounts.filter((_,n)=>n!==i)}));}
 function removeComponent(i:number){keys.current.statement=crypto.randomUUID();setForm(s=>({...s,components:s.components.filter((_,n)=>n!==i)}));}
 async function saveStatement(e:FormEvent){
  e.preventDefault();
  if(!salary)return;
  const net=parse(form.net),gross=form.gross.trim()?parse(form.gross):null;
  if(net===null||(form.gross.trim()&&gross===null)){setError('Valor líquido ou bruto inválido.');return;}
  if(!form.gross.trim()&&form.discounts.length){setError('Informe o bruto para discriminar descontos.');return;}
  const discounts=[] as {label:string;amount:string}[],components=[] as {kind:string;reason:string;amount:string}[];
  for(const d of form.discounts){
   const value=parse(d.amount);if(!d.label.trim()||value===null||value==='0.00'){setError('Desconto inválido.');return;}
   discounts.push({label:d.label.trim(),amount:value});
  }
  for(const c of form.components){
   const value=parse(c.amount);
   if(!c.reason.trim()||value===null||value==='0.00'){setError('Componente inválido.');return;}
   components.push({kind:c.kind,reason:c.reason.trim(),amount:c.kind==='reduction'?'-'+value:value});
  }
  await commit(salary,{idempotencyKey:keys.current.statement,net,gross,discounts,components},()=>{
   keys.current.statement=crypto.randomUUID();setForm(empty);setStatementOpen(false);
  });
 }

 const availableDeductions=latest?.discounts.map((d,i)=>({
  index:i,label:d.label,totalCents:d.amountCents,
  appliedCents:withheld.filter(p=>p.statementId===latest.statementId&&p.discountIndex===i)
    .reduce((sum,p)=>sum+p.amountCents,0),
 }))??[];
 const chosenDeduction=availableDeductions.find(d=>String(d.index)===retention.discountIndex);
 const usableObligations=obligations.filter(o=>o.outstandingCents>0&&o.state!=='canceled');
 const updateRetention=(patch:Partial<typeof retention>)=>{
  keys.current.retention=crypto.randomUUID();
  setRetention(v=>({...v,...patch}));
 };
 async function confirmRetention(e:FormEvent){
  e.preventDefault();
  if(!salary||!latest||!usable||!chosenDeduction||!retention.obligationId||!retention.confirmed)return;
  const amount=parse(retention.amount);
  if(amount===null||amount==='0.00'){setError('Valor retido inválido.');return;}
  const selected=obligations.find(x=>x.obligationId===retention.obligationId);
  if(!selected||BigInt(amount.replace('.',''))>BigInt(chosenDeduction.totalCents-chosenDeduction.appliedCents)||
    BigInt(amount.replace('.',''))>BigInt(selected.outstandingCents)){
   setError('Valor maior que o desconto restante ou que a dívida em aberto.');return;
  }
  await commit(salary+'/withholdings',{
   idempotencyKey:keys.current.retention,statementId:latest.statementId,
   discountIndex:chosenDeduction.index,obligationId:retention.obligationId,
   amount,confirmedOn:retention.confirmedOn,confirmRetained:true,
  },()=>{
   keys.current.retention=crypto.randomUUID();
   setRetention({discountIndex:'',obligationId:'',amount:'',confirmedOn:'',confirmed:false});
  });
 }
 return <section className="credit-panel payroll-panel" aria-label={'Remuneração de '+source.name}>
  <div className="credit-toolbar"><div><h3>Remuneração — {source.name}</h3>
   <p className="small-note">Salário líquido é a referência. Revisões com vigência alteram expectativas futuras, sem modificar caixa nem apagar competências passadas.</p></div>
   <button type="button" className="outline-btn" disabled={!usable||!canRaise} onClick={()=>setRevOpen(x=>!x)}>Registrar reajuste</button></div>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {!canRaise&&<p className="small-note">Não há parcela fixa líquida recorrente positiva nesta fonte. O reajuste exige salário-base e periodicidade informados.</p>}
  {loading&&<p role="status">Carregando composição salarial…</p>}
  {!loading&&!ready&&<button className="outline-btn" onClick={()=>setLocalRevision(x=>x+1)}>Tentar novamente</button>}
  {revOpen&&<form className="credit-form" aria-label="Reajuste salarial" onSubmit={saveRevision}>
   <fieldset className="work-fieldset" disabled={busy}>
    <label>Início da vigência<input type="date" required value={rev.effectiveOn} onChange={e=>editRev('effectiveOn',e.target.value)}/></label>
    <label>Novo salário líquido (R$)<input required inputMode="decimal" value={rev.net} onChange={e=>editRev('net',e.target.value)}/></label>
    <label>Motivo do reajuste<input required maxLength={120} value={rev.reason} onChange={e=>editRev('reason',e.target.value)}/></label>
    <p className="small-note">Uma competência anterior à vigência conserva o valor anterior. A revisão não reescreve recebimentos já confirmados pelo caixa.</p>
    <button type="submit" className="primary-btn" disabled={!usable}>Registrar reajuste com vigência</button>
   </fieldset>
  </form>}
  {ready&&<section aria-label="Histórico de salário-base" className="credit-reconcile-history">
   <p className="small-note">Salário líquido inicial: {brlCents(source.fixedNetCents)}. Histórico de alterações (mais recente primeiro):</p>
   {!versions.length&&<p className="small-note">Nenhum reajuste registrado.</p>}
   {versions.map(v=><div className="credit-installment" key={v.effectiveOn}>
    <span><strong>{v.effectiveOn} · {v.reason}</strong><small>{new Date(v.createdAt).toLocaleString('pt-BR')} · Vigência informada</small></span>
    <b>{money(v.netCents)}</b></div>)}
  </section>}
  {salary&&ready&&<>
   <div className="credit-toolbar"><div><h3>Composição desta competência</h3>
    <p className="small-note">Líquido e bruto opcional no mesmo formulário, sem opção extra de habilitação. Descontos já retidos não geram uma nova despesa.</p></div>
    <button type="button" className="outline-btn" disabled={!usable||withheld.length>0}
      onClick={()=>setStatementOpen(x=>!x)}>
      {latest?'Registrar nova versão':'Informar composição'}</button></div>
   {latest?<div className="credit-reconcile-values" aria-label="Conciliação salarial">
     <span>Líquido informado<strong>{money(latest.netCents)}</strong></span>
     <span>Bruto informado<strong>{brlCents(latest.grossCents)}</strong></span>
     <span>Descontos discriminados<strong>{money(latest.discountsTotalCents)}</strong></span>
     <span>Diferença bruto − descontos − líquido<strong>{latest.grossDifferenceCents===null?'Sem bruto':money(latest.grossDifferenceCents)}</strong></span>
     <span>Componentes pontuais<strong>{money(latest.componentsTotalCents)}</strong></span>
     <span>Diferença do líquido versus base + componentes<strong>{money(latest.componentsDifferenceCents)}</strong></span>
   </div>:<p className="small-note">Nenhum demonstrativo cadastrado para esta competência. O valor-base recorrente continua sendo uma expectativa.</p>}
   {latest&&<div className="payroll-itemization" aria-label="Composição discriminada mais recente">
     <h4>Descontos discriminados</h4>
     {!latest.discounts.length&&<p className="small-note">Nenhum desconto discriminado nesta versão.</p>}
     {latest.discounts.map((d,i)=><div className="credit-installment" key={'deduction-'+i}>
       <span><strong>{d.label}</strong><small>Valor informado como retenção em folha; não gera nova despesa bancária</small></span>
       <b>{money(d.amountCents)}</b>
     </div>)}
     <h4>Adicionais e reduções pontuais</h4>
     {!latest.components.length&&<p className="small-note">Nenhum componente pontual nesta versão.</p>}
     {latest.components.map((c,i)=><div className="credit-installment" key={'component-'+i}>
       <span><strong>{labels[c.kind as Component['kind']]??c.kind}</strong><small>{c.reason} · Exclusivo desta competência</small></span>
       <b>{money(c.amountCents)}</b>
     </div>)}
   </div>}
   {latest&&latest.componentsDifferenceCents!==0&&<p role="status" className="credit-reconcile-pending">
     Diferença entre líquido da competência e salário-base com os componentes pontuais declarados:
     {money(latest.componentsDifferenceCents)}. Confira os adicionais ou reduções informados; o sistema não ajustará os valores automaticamente.
   </p>}
   {latest?.grossStatus==='pending'&&<p role="status" className="credit-reconcile-pending">
      Divergência de conciliação pendente: o bruto menos os descontos discriminados não corresponde ao líquido informado. Nenhum ajuste ou retenção será criado automaticamente.
   </p>}
   {latest?.grossStatus==='matched'&&<p className="small-note">Bruto − descontos = líquido informado. Conferência aritmética, não validação legal ou bancária.</p>}
   {latest?.grossStatus==='not_provided'&&<p className="small-note">Bruto não informado: cálculo de descontos dispensado.</p>}
   {statementOpen&&<form className="credit-form" aria-label="Demonstrativo de remuneração" onSubmit={saveStatement}>
    <fieldset className="work-fieldset" disabled={busy}>
     <label>Salário líquido desta competência (R$)<input required inputMode="decimal" placeholder="Ex.: 3000,00" value={form.net}
      onChange={e=>editNet('net',e.target.value)}/></label>
     <label>Salário bruto (R$, opcional)<input inputMode="decimal" placeholder="Deixe vazio para ignorar" value={form.gross}
      onChange={e=>editNet('gross',e.target.value)}/></label>
     <h4>Descontos em folha</h4>
     {form.discounts.map((d,i)=><div className="credit-two" key={i}>
      <label>Descrição do desconto<input maxLength={80} value={d.label} onChange={e=>editDiscount(i,'label',e.target.value)}/></label>
      <label>Valor retido (R$)<input required inputMode="decimal" value={d.amount} onChange={e=>editDiscount(i,'amount',e.target.value)}/></label>
      <button type="button" className="text-btn" onClick={()=>removeDiscount(i)}>Remover desconto</button>
     </div>)}
     <button type="button" className="outline-btn" disabled={!form.gross.trim()} onClick={addDiscount}>＋ Discriminar desconto</button>
     <h4>Adicionais e reduções exclusivos desta competência</h4>
     {form.components.map((v,i)=><div className="credit-two" key={i}>
      <label>Tipo<select value={v.kind} onChange={e=>editComponent(i,'kind',e.target.value)}>
       {(['overtime','bonus','other','reduction'] as const).map(k=><option value={k} key={k}>{labels[k]}</option>)}</select></label>
      <label>Motivo<input maxLength={120} required value={v.reason} onChange={e=>editComponent(i,'reason',e.target.value)}/></label>
      <label>Valor absoluto (R$)<input required inputMode="decimal" value={v.amount} onChange={e=>editComponent(i,'amount',e.target.value)}/></label>
      <button type="button" className="text-btn" onClick={()=>removeComponent(i)}>Remover componente</button>
     </div>)}
     <button type="button" className="outline-btn" onClick={addComponent}>＋ Adicional ou redução</button>
     <p className="small-note">Horas extras e gratificações pontuais não alteram o salário-base dos próximos meses. Um reajuste permanente deve ser registrado acima, com data de vigência.</p>
     <button type="submit" className="primary-btn" disabled={!usable}>Salvar composição sem movimentar caixa</button>
    </fieldset>
   </form>}

   <section aria-label="Baixa de obrigação por desconto em folha" className="payroll-withholdings">
    <h4>Consignado ou outra retenção confirmada</h4>
    <p className="small-note">Um desconto listado no holerite não quita automaticamente uma dívida.
     Confirme separadamente apenas depois de verificar a retenção efetiva.
     Não será criada outra despesa ou transferência bancária.</p>
    {!latest?.grossCents&&<p className="small-note">Informe salário bruto e descontos para habilitar baixas por folha.</p>}
    {latest?.grossStatus==='pending'&&<p className="small-note">Resolva primeiro a divergência entre bruto, descontos e líquido.</p>}
    {withheld.length>0&&<p className="small-note">O demonstrativo foi congelado após a primeira baixa confirmada.
     Correções posteriores exigem procedimento específico, preservando histórico.</p>}
    {latest?.grossStatus==='matched'&&availableDeductions.length>0&&<form className="credit-form"
       aria-label="Confirmar retenção e baixar dívida" onSubmit={confirmRetention}>
      <fieldset className="work-fieldset" disabled={!usable}>
       <label>Desconto efetivamente retido<select required value={retention.discountIndex}
        onChange={e=>updateRetention({discountIndex:e.target.value,amount:'',confirmed:false})}>
        <option value="">Selecione</option>
        {availableDeductions.filter(d=>d.totalCents>d.appliedCents).map(d=>
         <option key={d.index} value={d.index}>{d.label} · disponível {money(d.totalCents-d.appliedCents)}</option>)}
       </select></label>
       <label>Obrigação a quitar<select required value={retention.obligationId}
        onChange={e=>updateRetention({obligationId:e.target.value,confirmed:false})}>
        <option value="">Selecione</option>{usableObligations.map(o=><option key={o.obligationId} value={o.obligationId}>
         {o.title} · em aberto {money(o.outstandingCents)}</option>)}
       </select></label>
       <label>Valor confirmado da retenção (R$)<input required inputMode="decimal"
        placeholder="Ex.: 300,00" value={retention.amount}
        onChange={e=>updateRetention({amount:e.target.value,confirmed:false})}/></label>
       <label>Data efetiva da retenção<input type="date" required value={retention.confirmedOn}
        onChange={e=>updateRetention({confirmedOn:e.target.value,confirmed:false})}/></label>
       <label className="payroll-confirm"><input type="checkbox" checked={retention.confirmed}
        onChange={e=>updateRetention({confirmed:e.target.checked})}/>
        Confirmo que essa retenção realmente ocorreu e autorizo a baixa da obrigação sem novo débito no banco.
       </label>
       <button className="primary-btn" type="submit" disabled={!usable||!retention.confirmed||!usableObligations.length}>
        Confirmar desconto em folha e baixar dívida
       </button>
      </fieldset>
    </form>}
    <h4>Histórico de baixas confirmadas por folha</h4>
    {!withheld.length&&<p className="small-note">Nenhuma retenção confirmada nesta competência.</p>}
    {withheld.map(p=><div className="credit-installment" key={p.paymentId}>
      <span><strong>{p.discountLabel} · {p.confirmedOn}</strong><small>
       Origem: desconto em folha confirmado · Obrigação: {obligations.find(o=>o.obligationId===p.obligationId)?.title??'Obrigação registrada'}
      </small></span><b>{money(p.amountCents)}</b>
    </div>)}
   </section>
   <section className="credit-reconcile-history" aria-label="Histórico de demonstrativos da competência">
    <h4>Histórico imutável dos demonstrativos</h4>
    {statements.map(s=><div className="credit-installment" key={s.statementId}><span><strong>Líquido {money(s.netCents)}</strong>
      <small>Bruto {brlCents(s.grossCents)} · {new Date(s.createdAt).toLocaleString('pt-BR')} · Base ao registrar: {money(s.baseNetCents)}
       · Descontos: {s.discounts.map(d=>d.label+' '+money(d.amountCents)).join('; ')||'Nenhum'}
       · Adicionais/reduções: {s.components.map(c=>(labels[c.kind as Component['kind']]??c.kind)+' '+c.reason+' '+money(c.amountCents)).join('; ')||'Nenhum'}</small>
     </span><b>{s.grossStatus==='pending'?'Conciliação pendente':s.grossStatus==='matched'?'Conferido':'Sem bruto'}</b></div>)}
   </section>
  </>}
 </section>;
}
