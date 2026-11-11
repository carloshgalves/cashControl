import { useEffect, useMemo, useState } from 'react';
import { ApiError, request } from './api.ts';
import type { Account } from './api.ts';
import { friendlyDate, money, monthBounds, monthLabel, today } from './finance.ts';
import './trail.css';

export type TrailStatus = 'realized'|'pending'|'overdue'|'canceled';
export type TrailFilter = 'all'|TrailStatus|'scheduled';
export type TrailKind = 'income'|'expense'|'refund'|'payment'|'transfer'|'obligation'|'cancellation';
export interface TrailEvent {
  id: string; kind: TrailKind; status: TrailStatus; timing: 'actual'|'scheduled';
  date: string; title: string; amountCents: number;
  accountId: string|null; obligationId: string|null; relatedMovementId: string|null;
}
interface TrailPage { events: TrailEvent[]; hasMore: boolean; limit: number; offset: number }
export interface DueAlert {
  obligationId: string; title: string; dueOn: string;
  outstandingCents: number; daysUntilDue: number; stage: 'D-10'|'D-5'|'TODAY';
}
interface AlertPage { alerts: DueAlert[]; hasMore: boolean; offset: number; limit: number }
const FILTERS: {id:TrailFilter;label:string}[] = [
  {id:'all',label:'Todos'}, {id:'realized',label:'Realizados'},
  {id:'scheduled',label:'Previstos'}, {id:'pending',label:'Pendentes'},
  {id:'overdue',label:'Atrasados'}, {id:'canceled',label:'Cancelados'},
];
const kindNames: Record<TrailKind,string> = {
  income:'Entrada recebida',expense:'Despesa paga',refund:'Devolução recebida',
  payment:'Pagamento de obrigação',transfer:'Transferência própria',
  obligation:'Obrigação a vencer',cancellation:'Cancelamento',
};
const statusNames: Record<TrailStatus,string> = {
  realized:'Realizado',pending:'Pendente',overdue:'Vencido',canceled:'Cancelado',
};
function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Sessão expirada. Faça login novamente.';
  return error instanceof ApiError ? error.message :
    'Não foi possível consultar os eventos. Tente novamente.';
}
const limit=30;
function trailUrl(month:string,asOf:string,status:TrailFilter,offset:number) {
  const {from,to}=monthBounds(month);
  return '/api/trail?'+new URLSearchParams({
    from,to,asOf,status,limit:String(limit),offset:String(offset),
  }).toString();
}
function alertUrl(asOf:string,offset:number) {
  return '/api/due-alerts?'+new URLSearchParams({asOf,limit:String(limit),offset:String(offset)}).toString();
}
function valueLabel(event:TrailEvent):string {
  if (event.kind==='cancellation') return 'Sem débito';
  return (event.kind==='expense'||event.kind==='payment'?'−':
    event.kind==='income'||event.kind==='refund'?'+':'')+money(event.amountCents);
}
export function eventDescription(event:TrailEvent):string {
  if(event.kind==='obligation') return event.status==='overdue'
    ? 'Vencimento ultrapassado e valor ainda pendente. O dinheiro só sai quando um pagamento é registrado.'
    : 'Compromisso com vencimento previsto, ainda não quitado. Não reduz o saldo atual.';
  if(event.kind==='cancellation') return 'Compromisso cancelado e preservado no histórico. Não é cobrança ativa e não cria entrada no caixa.';
  if(event.kind==='transfer') return 'Dinheiro transferido entre contas próprias. Não é receita nem despesa.';
  if(event.kind==='refund') return 'Valor devolvido e efetivamente recebido, vinculado à despesa original. Não é renda do trabalho.';
  if(event.kind==='payment') return 'Pagamento confirmado de obrigação. O valor já integra as saídas efetivas.';
  if(event.kind==='income') return 'Recebimento confirmado. O valor já integra o saldo registrado.';
  return 'Despesa efetivamente realizada e já descontada do saldo registrado.';
}
export function TrailView({month,accounts,refreshKey,onPay,onChangeMonth}:{
  month:string; accounts:Account[]; refreshKey:number;
  onPay:(obligationId:string)=>void; onChangeMonth:(month:string)=>void;
}) {
  const asOf=today();
  const [filter,setFilter]=useState<TrailFilter>('all');
  const [events,setEvents]=useState<TrailEvent[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [selectedAlert,setSelectedAlert]=useState<DueAlert|null>(null);
  const [selectedDay,setSelectedDay]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [moreBusy,setMoreBusy]=useState(false);
  const [error,setError]=useState('');
  const [alerts,setAlerts]=useState<DueAlert[]>([]);
  const [alertHasMore,setAlertHasMore]=useState(false);
  const [alertError,setAlertError]=useState('');
  const [alertBusy,setAlertBusy]=useState(false);
  const [alertMoreBusy,setAlertMoreBusy]=useState(false);
  const [trailRetry,setTrailRetry]=useState(0);
  const [alertRetry,setAlertRetry]=useState(0);
  const accountsById=useMemo(()=>new Map(accounts.map(account=>[account.accountId,account.name])),[accounts]);

  useEffect(()=>{
    const controller=new AbortController();
    setBusy(true);setEvents([]);setHasMore(false);setError('');
    request<TrailPage>(trailUrl(month,asOf,filter,0),{signal:controller.signal})
      .then(page=>{
        if(controller.signal.aborted)return;
        setEvents(page.events);setHasMore(page.hasMore);
        setSelectedId(current=>page.events.some(e=>e.id===current)||current===selectedAlert?.obligationId
          ? current : page.events[0]?.id??null);
      }).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[month,asOf,filter,refreshKey,trailRetry]);

  useEffect(()=>{
    const controller=new AbortController();
    setAlertBusy(true);setAlertError('');setAlerts([]);setAlertHasMore(false);
    request<AlertPage>(alertUrl(asOf,0),{signal:controller.signal})
      .then(page=>{if(!controller.signal.aborted){setAlerts(page.alerts);setAlertHasMore(page.hasMore);}})
      .catch(e=>{if(!controller.signal.aborted)setAlertError(errorMessage(e));})
      .finally(()=>{if(!controller.signal.aborted)setAlertBusy(false);});
    return ()=>controller.abort();
  },[asOf,refreshKey,alertRetry]);

  async function more() {
    if(moreBusy||!hasMore)return;
    setMoreBusy(true);setError('');
    try{
      const page=await request<TrailPage>(trailUrl(month,asOf,filter,events.length));
      setEvents(previous=>[...previous,...page.events]);
      setHasMore(page.hasMore);
    }catch(e){setError(errorMessage(e));}
    finally{setMoreBusy(false);}
  }
  async function moreAlerts(){
    if(alertMoreBusy||!alertHasMore)return;
    setAlertMoreBusy(true);setAlertError('');
    try{
      const page=await request<AlertPage>(alertUrl(asOf,alerts.length));
      setAlerts(previous=>[...previous,...page.alerts]);setAlertHasMore(page.hasMore);
    }catch(e){setAlertError(errorMessage(e));}
    finally{setAlertMoreBusy(false);}
  }
  const selected=events.find(event=>event.id===selectedId) ??
    (selectedAlert?.obligationId===selectedId ? {
      id:selectedAlert.obligationId,kind:'obligation' as const,
      status:'pending' as const,timing:'scheduled' as const,
      date:selectedAlert.dueOn,title:selectedAlert.title,
      amountCents:selectedAlert.outstandingCents,accountId:null,
      obligationId:selectedAlert.obligationId,relatedMovementId:null,
    } : null);
  const selectAlert=(alert:DueAlert)=>{
    setFilter('all');setSelectedAlert(alert);setSelectedId(alert.obligationId);
    if(month!==alert.dueOn.slice(0,7))onChangeMonth(alert.dueOn.slice(0,7));
  };
  const dayEvents=events.filter(e=>e.date===selectedDay);
  const todayVisible=asOf>=monthBounds(month).from&&asOf<=monthBounds(month).to;
  const highlighted=events;
  const monthNum=Number(month.slice(5,7)),year=Number(month.slice(0,4));
  const monthDays=new Date(Date.UTC(year,monthNum,0)).getUTCDate();
  const offsetDay=new Date(Date.UTC(year,monthNum-1,1)).getUTCDay();
  const dueDays=new Set(events.filter(e=>e.kind==='obligation').map(e=>e.date));

  return <div className="trail-c2">
    <div className="trail-hero">
      <div><span className="eyebrow">Seu dinheiro, em sequência</span>
        <h2>O que aconteceu.<br/>O que vem a seguir.</h2>
        <p>Explore seus eventos e compromissos sem confundir dinheiro movimentado com contas ainda pendentes.</p></div>
      <p className="trail-scope">Referência: {friendlyDate(asOf)}<br/>Vencimentos previstos não debitam o caixa.</p>
    </div>
    <section aria-label="Avisos de vencimento" className="trail-attention">
      <div><span className="eyebrow">Atenção ao calendário</span>
        <h3>Vencimentos<br/>no radar.</h3>
        <p>Avisos no aplicativo. Nenhum débito automático ou notificação externa.</p></div>
      <div className="trail-alert-stack">
        {alertBusy&&<p role="status">Verificando vencimentos…</p>}
        {alertError&&<p role="alert">{alertError} <button onClick={()=>setAlertRetry(x=>x+1)}>Tentar novamente</button></p>}
        {!alertBusy&&!alertError&&alerts.length===0&&<p className="trail-empty-alert">Nenhum compromisso pendente vence nos próximos 10 dias.</p>}
        {alerts.map(alert=><button key={alert.obligationId} type="button"
          className="trail-alert" onClick={()=>selectAlert(alert)}>
          <span className="trail-stage">{alert.stage==='TODAY'?'HOJE':alert.stage}</span>
          <span className="trail-alert-title"><strong>{alert.title}</strong>
            <small>{friendlyDate(alert.dueOn)} · {alert.daysUntilDue===0?'vence hoje':
              'faltam '+alert.daysUntilDue+' dias'}</small></span>
          <strong className="trail-amount">{money(alert.outstandingCents)}</strong>
        </button>)}
        {alertHasMore&&<button className="trail-more" onClick={moreAlerts} disabled={alertMoreBusy}>
          {alertMoreBusy?'Carregando…':'Mais avisos →'}</button>}
      </div>
    </section>
    <div className="trail-section-heading">
      <div><h3>A trilha de {monthLabel(month)}</h3>
        <p>Selecione um evento para entender o estado e as próximas ações.</p></div>
      <div className="trail-filters" role="group" aria-label="Filtrar eventos">
        {FILTERS.map(option=><button key={option.id} type="button"
          aria-pressed={filter===option.id} className={filter===option.id?'active':''}
          onClick={()=>{setFilter(option.id);setSelectedDay(null);setSelectedAlert(null);}}>{option.label}</button>)}
      </div>
    </div>
    <section className="trail-rail-box" aria-label="Cronologia financeira interativa">
      <div className="trail-rail-heading"><span>Eventos de {monthLabel(month)}</span>
        {todayVisible&&<span className="trail-today">Hoje · dia {asOf.slice(-2)}</span>}</div>
      {busy&&<p role="status" className="trail-empty">Carregando eventos…</p>}
      {error&&<p role="alert" className="trail-empty">{error}
        <button className="trail-more" onClick={()=>setTrailRetry(x=>x+1)}>Tentar novamente</button></p>}
      {!busy&&!error&&highlighted.length===0&&<p className="trail-empty">Nenhum evento encontrado neste período e filtro.</p>}
      {highlighted.length>0&&<div className="trail-scroll" tabIndex={0} aria-label="Eventos; role horizontalmente para explorar">
        <div className="trail-rail">
          {highlighted.map(e=><button key={e.kind+'-'+e.id} type="button"
            aria-pressed={selected?.id===e.id} onClick={()=>{setSelectedId(e.id);setSelectedAlert(null);setSelectedDay(e.date);}}
            className={'trail-event '+e.status+(selected?.id===e.id?' selected':'')}>
            <small>{friendlyDate(e.date)}</small><span className="trail-node" aria-hidden="true"/>
            <span className="trail-type">{statusNames[e.status]}</span>
            <strong title={e.title}>{e.title}</strong>
            <span className="trail-value">{valueLabel(e)}</span>
          </button>)}
        </div>
      </div>}
      <div className="trail-legend">
        <span><i className="legend-realized"/> Realizado</span>
        <span><i className="legend-pending"/> Pendente ou previsto</span>
        <span><i className="legend-canceled"/> Cancelado</span>
        <span>Sem previsão automática de renda</span>
      </div>
      {hasMore&&<button type="button" className="trail-more" disabled={moreBusy} onClick={more}>
        {moreBusy?'Carregando…':'Carregar mais eventos →'}</button>}
    </section>
    <div className="trail-below">
      <section aria-label="Detalhes do evento" className="trail-detail">
        {selected?<><div className="trail-detail-head"><span className="eyebrow">Detalhe do evento selecionado</span>
          <span className={'trail-state '+selected.status}>{statusNames[selected.status]}</span></div>
          <h3>{selected.title}</h3><p>{eventDescription(selected)}</p>
          <div className="trail-detail-value">{valueLabel(selected)}</div>
          <p className="trail-detail-meta">{kindNames[selected.kind]} · {friendlyDate(selected.date)}
            {selected.accountId&&' · '+(accountsById.get(selected.accountId)??'Conta cadastrada')}</p>
          <div className="trail-actions">
            {selected.kind==='obligation'&&selected.obligationId&&
              <button type="button" className="primary-btn" onClick={()=>onPay(selected.obligationId!)}>
                Registrar pagamento efetivo →
              </button>}
            <button type="button" className="outline-btn" onClick={()=>setSelectedDay(selected.date)}>
              Ver data no calendário
            </button>
          </div></>:<div className="trail-empty">Selecione um evento na trilha para consultar seus detalhes.</div>}
      </section>
      <section className="trail-calendar" aria-label="Calendário da trilha">
        <div className="trail-calendar-head"><h3>{monthLabel(month)}</h3><small>Escolha uma data</small></div>
        <div className="trail-days" role="group" aria-label="Dias do mês">
          {['D','S','T','Q','Q','S','S'].map((label,i)=><span className="trail-weekday" key={i} aria-hidden="true">{label}</span>)}
          {Array.from({length:offsetDay},(_,i)=><span key={'blank-'+i}/>)}
          {Array.from({length:monthDays},(_,i)=>{
            const date=month+'-'+String(i+1).padStart(2,'0');
            return <button key={date} type="button" aria-pressed={selectedDay===date}
              aria-label={'Dia '+(i+1)+(dueDays.has(date)?', obrigação pendente':'')}
              onClick={()=>{
                setSelectedDay(date);
                const first=events.find(e=>e.date===date);
                if(first){setSelectedId(first.id);setSelectedAlert(null);}
              }} className={(selectedDay===date?'selected ':'')+(dueDays.has(date)?'has-due':'')}>
              <strong>{i+1}</strong><i aria-hidden="true"/></button>;
          })}
        </div>
        <div className="trail-calendar-foot">
          {selectedDay?<>Dia {friendlyDate(selectedDay)}: {dayEvents.length>0
            ? dayEvents.map(e=>e.title).join(' · ')
            : 'nenhum evento entre os registros carregados para esta data.'}</>
            :'Selecione uma data para explorar os eventos carregados.'}
        </div>
      </section>
    </div>
    <p className="trail-disclaimer">Eventos futuros representam compromissos já cadastrados, não receitas projetadas. Os avisos D-10 e D-5 são calculados na consulta e não enviam notificações externas.</p>
  </div>;
}
