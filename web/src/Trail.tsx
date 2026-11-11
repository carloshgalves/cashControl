import { useEffect, useMemo, useRef, useState } from 'react';
import './trail.css';
import type { Obligation } from './api.ts';
import { monthBounds, monthLabel, money, friendlyDate, today } from './finance.ts';
import {
  type TrailEvent, type TrailFilter, type DueAlert, type TrailPage,
  type DueAlertPage, alertBand, alertText, eventValue, filterOptions, findPayable,
  kindLabel, statusLabel, fetchAlerts, fetchTrail,
} from './trail.ts';

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.name === 'AbortError' ? '' :
    'Não foi possível consultar os eventos. Os valores não foram estimados. Tente novamente.';
}
function visualDay(date: string) { return date.slice(8,10); }
function EventDetails({ event, asOf, onPay, obligation }: {
  event: TrailEvent | null; asOf: string; onPay: (bill: Obligation) => void; obligation?: Obligation;
}) {
  if (!event) return <article className="trail-detail"><span className="eyebrow">Detalhes</span>
    <p className="trail-empty">Selecione um evento para ver as informações.</p></article>;
  const moneyMoved = event.status === 'realized';
  return <article className="trail-detail" aria-live="polite" aria-label="Detalhes do evento selecionado">
    <div className="trail-detail-head">
      <span className="eyebrow">Detalhe do evento selecionado</span>
      <span className={'trail-state trail-state-' + event.status}>{statusLabel[event.status]}</span>
    </div>
    <h3>{event.title}</h3>
    <p className="trail-type">{kindLabel[event.kind]} · {friendlyDate(event.date)}</p>
    <div className="trail-value">{eventValue(event)}</div>
    {event.kind === 'obligation' ? <p className="trail-explain">
      {event.date < asOf ? 'Este vencimento já passou e há valor em aberto.' :
        event.date === asOf ? 'Vence hoje; ainda existe valor pendente.' :
        'Compromisso futuro. Ainda não é uma saída de caixa realizada.'}
      {' '}O saldo bancário só muda após registrar um pagamento efetivo.
    </p> : event.kind === 'cancellation' ? <p className="trail-explain">
      Compromisso cancelado sem lançamento de dinheiro. Não permanece como cobrança ativa.
    </p> : event.kind === 'transfer' ? <p className="trail-explain">
      Reorganização entre contas próprias. Não cria receita nem despesa.
    </p> : event.kind === 'refund' ? <p className="trail-explain">
      Devolução recebida e vinculada à despesa original. Não representa renda nova.
    </p> : <p className="trail-explain">
      {moneyMoved ? 'Evento financeiro confirmado e preservado no histórico.' : 'Compromisso registrado.'}
    </p>}
    {obligation && <button className="primary-btn trail-pay" type="button" onClick={() => onPay(obligation)}>
      Registrar pagamento efetivo <span aria-hidden="true">↗</span>
    </button>}
    {event.kind === 'obligation' && !obligation && <p className="trail-hint">Este compromisso não possui valor pendente para pagamento.</p>}
  </article>;
}
export function AlertPreview({ onExplore, refreshKey }: { onExplore: () => void; refreshKey: number }) {
  const [alerts, setAlerts] = useState<DueAlert[]>([]);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(false);
    fetchAlerts(today(), 0, controller.signal)
      .then(result => { if (!controller.signal.aborted) setAlerts(result.alerts); })
      .catch(() => { if (!controller.signal.aborted) { setFailure(true); setAlerts([]); } });
    return () => controller.abort();
  }, [refreshKey]);
  if (failure) return <section className="trail-preview-error" role="status">
    Não foi possível consultar avisos de vencimento. <button className="text-btn" type="button" onClick={onExplore}>Abrir trilha →</button>
  </section>;
  if (!alerts.length) return null;
  const first = alerts.slice(0,2);
  return <section className="trail-attention-mini" aria-label="Avisos de vencimento">
    <div><span className="eyebrow">Atenção ao calendário</span>
      <strong>Vencimentos no radar</strong>
      <small>São avisos no aplicativo. Nenhum valor foi debitado automaticamente.</small></div>
    <div className="trail-preview-items">{first.map(alert => <button type="button"
      key={alert.obligationId} onClick={onExplore}>
      <span className="trail-alert-level">{alertBand(alert)}</span>
      <span><strong>{alert.title}</strong><small>{alertText(alert)}</small></span>
      <b>{money(alert.outstandingCents)}</b>
    </button>)}
    </div>
    <button type="button" className="text-btn" onClick={onExplore}>Abrir trilha →</button>
  </section>;
}

export function TimelineScreen({ month, obligations, onPay, refreshKey }: {
  month: string; obligations: Obligation[]; onPay: (bill: Obligation) => void; refreshKey: number;
}) {
  const asOf = today();
  const [filter, setFilter] = useState<TrailFilter>('all');
  const [events, setEvents] = useState<TrailEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [alerts, setAlerts] = useState<DueAlert[]>([]);
  const [moreAlerts, setMoreAlerts] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [pinnedAlert, setPinnedAlert] = useState<DueAlert | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [alertLoading, setAlertLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pendingAlertSelection = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setEvents([]); setSelectedId(null); setHasMore(false);
    setLoading(true); setError('');
    fetchTrail(month, asOf, filter, 0, controller.signal)
      .then(page => {
        if (controller.signal.aborted || current !== generation.current) return;
        setEvents(page.events); setHasMore(page.hasMore);
        if (pendingAlertSelection.current) {
          setSelectedId(pendingAlertSelection.current);
          pendingAlertSelection.current = null;
        }
      })
      .catch(cause => {
        if (controller.signal.aborted || current !== generation.current) return;
        setError(errorMessage(cause));
      })
      .finally(() => { if (!controller.signal.aborted && current === generation.current) setLoading(false); });
    return () => controller.abort();
  }, [month, asOf, filter, refreshKey, retry]);

  useEffect(() => {
    const controller = new AbortController();
    setAlerts([]); setMoreAlerts(false); setAlertLoading(true);
    fetchAlerts(asOf, 0, controller.signal)
      .then(page => { if (!controller.signal.aborted) {
        setAlerts(page.alerts); setMoreAlerts(page.hasMore);
      } })
      .catch(() => { if (!controller.signal.aborted) setError('Não foi possível consultar avisos de vencimento.'); })
      .finally(() => { if (!controller.signal.aborted) setAlertLoading(false); });
    return () => controller.abort();
  }, [asOf, refreshKey, retry]);

  const { from, to } = monthBounds(month);
  const calendarDays = Number(to.slice(8,10));
  const firstWeekday = new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1,1)).getUTCDay();
  const dayEvents = useMemo(() => events.filter(e => !selectedDay || e.date === selectedDay), [events, selectedDay]);
  const dates = useMemo(() => new Set(events.map(e => e.date)), [events]);
  const selected = dayEvents.find(item => item.id === selectedId) ?? dayEvents[0] ?? null;
  // Alert cards can refer to another month. Show the actual unpaid obligation
  // without pretending that it belongs to the currently selected month.
  const detailEvent: TrailEvent | null = pinnedAlert ? {
    id: 'obligation:' + pinnedAlert.obligationId,
    date: pinnedAlert.dueOn, kind: 'obligation',
    status: pinnedAlert.dueOn > asOf ? 'planned' : 'pending',
    title: pinnedAlert.title, amountCents: pinnedAlert.outstandingCents,
    accountId: null, obligationId: pinnedAlert.obligationId, relatedId: null,
  } : selected;
  const activeObligation = detailEvent ? findPayable(detailEvent,obligations) : undefined;

  async function nextPage() {
    if (loading || loadingMore || !hasMore) return;
    const current = generation.current, offset = events.length;
    setLoadingMore(true);
    try {
      const page: TrailPage = await fetchTrail(month,asOf,filter,offset);
      if (current !== generation.current) return;
      setEvents(previous => [...previous, ...page.events]); setHasMore(page.hasMore);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally { if (current === generation.current) setLoadingMore(false); }
  }
  async function showMoreAlerts() {
    if (!moreAlerts || alertLoading) return;
    setAlertLoading(true);
    try {
      const page: DueAlertPage = await fetchAlerts(asOf, alerts.length);
      setAlerts(previous => [...previous,...page.alerts]); setMoreAlerts(page.hasMore);
    } catch { setError('Não foi possível consultar mais avisos de vencimento.'); }
    finally { setAlertLoading(false); }
  }
  function selectAlert(alert: DueAlert) {
    setPinnedAlert(alert);
    if (alert.dueOn >= from && alert.dueOn <= to) {
      setPinnedAlert(null);
      const targetId = 'obligation:' + alert.obligationId;
      setSelectedDay(null);
      setSelectedId(targetId);
      if (filter !== 'all' || loading) {
        pendingAlertSelection.current = targetId;
        setFilter('all');
      }
    }
    // Outside the chosen month, the details panel still shows the real
    // obligation and contextual payment action without changing the month.
  }

  return <section className="trail-feature" aria-label="Trilha financeira">
    <div className="trail-intro"><div><span className="eyebrow">Seu dinheiro, em sequência</span>
      <h2>O que aconteceu.<br/>O que vem a seguir.</h2>
      <p>Explore movimentos confirmados e compromissos sem confundir o que já foi pago com o que ainda pode vencer.</p>
    </div><span className="trail-scope">Referência: {friendlyDate(asOf)}<br/>Saldos não são alterados por avisos.</span></div>
    <section className="trail-attention" id="trail-attention" aria-label="Avisos de vencimento">
      <div className="trail-attention-title"><span className="eyebrow">Atenção ao calendário</span>
        <h3>{alerts.length ? 'Vencimentos no radar.' : 'Calendário acompanhado.'}</h3>
        <p>Avisos D-10, D-5 e atrasados, sem débito automático.</p></div>
      <div className="trail-alerts">
        {alertLoading && !alerts.length && <span role="status">Consultando vencimentos…</span>}
        {!alertLoading && !alerts.length && <span className="trail-no-alerts">Nenhum aviso ativo para hoje.</span>}
        {alerts.map(alert => <button key={alert.obligationId} type="button"
          className="trail-alert" onClick={()=>selectAlert(alert)}
          aria-label={alert.title + ', ' + alertText(alert) + ', ' + money(alert.outstandingCents)}>
          <strong className={'trail-alert-level ' + (alert.level === 'overdue' ? 'overdue' : '')}>{alertBand(alert)}</strong>
          <span className="trail-alert-copy"><strong>{alert.title}</strong><small>{alertText(alert)} · {friendlyDate(alert.dueOn)}</small></span>
          <b>{money(alert.outstandingCents)}</b></button>)}
        {moreAlerts && <button className="text-btn" disabled={alertLoading} onClick={showMoreAlerts}>Mostrar mais avisos →</button>}
      </div>
    </section>
    <div className="trail-heading"><div><h3>A trilha de {monthLabel(month)}</h3>
      <p>Selecione um evento ou uma data. Os itens exibidos vêm do seu registro financeiro.</p></div>
      <div role="group" className="trail-filters" aria-label="Filtrar eventos da trilha">
        {filterOptions.map(option=><button type="button" key={option.value} aria-pressed={filter===option.value}
          className={filter===option.value?'active':''} onClick={()=>{setFilter(option.value);setSelectedDay(null);setPinnedAlert(null);}}>
          {option.label}</button>)}</div></div>
    {error && <div className="error-panel" role="alert">{error} <button className="outline-btn" onClick={()=>setRetry(n=>n+1)}>Tentar novamente</button></div>}
    <section className="trail-rail" aria-label="Cronologia interativa">
      <div className="trail-rail-head"><span>{friendlyDate(from)} – {friendlyDate(to)}</span>
        <span>Referência: {friendlyDate(asOf)}</span></div>
      {loading && <p role="status" className="trail-empty">Consultando eventos…</p>}
      {!loading && !error && !events.length && <p className="trail-empty">Nenhum evento corresponde a este período e filtro.</p>}
      {events.length > 0 && <div className="trail-rail-scroll"><div className="trail-rail-track">
        {dayEvents.map(event=><button key={event.id} type="button"
          className={'trail-event trail-event-'+event.status+(selected?.id===event.id?' selected':'')}
          aria-pressed={selected?.id===event.id}
          onClick={()=>{setPinnedAlert(null);setSelectedId(event.id);}}>
          <span className="trail-event-date">{friendlyDate(event.date)}</span>
          <i aria-hidden="true" className="trail-node"/>
          <span className="trail-event-status">{statusLabel[event.status]}</span>
          <strong>{event.title}</strong><span className="trail-event-value">{eventValue(event)}</span>
        </button>)}
      </div></div>}
      <div className="trail-rail-foot"><span>● Realizados</span><span>● Pendentes / previstos</span>
        <span>● Cancelados</span><span>Receitas futuras não cadastradas não são inventadas.</span></div>
      {hasMore && <button type="button" className="outline-btn trail-more" disabled={loadingMore} onClick={nextPage}>
        {loadingMore ? 'Carregando…' : 'Carregar mais eventos'}</button>}
    </section>
    <div className="trail-bottom">
      <EventDetails event={detailEvent} asOf={asOf} onPay={onPay} obligation={activeObligation}/>
      <section className="trail-calendar" aria-label="Navegador de datas">
        <div className="trail-cal-head"><h3>{monthLabel(month)}, em um olhar</h3><span>Selecione um dia</span></div>
        <div className="trail-day-grid">{['D','S','T','Q','Q','S','S'].map((label,i)=>
          <span key={i} className="trail-weekday">{label}</span>)}
          {Array.from({length:firstWeekday},(_,i)=><span key={'gap'+i}/>)}
          {Array.from({length:calendarDays},(_,i)=>{
            const date = month+'-'+String(i+1).padStart(2,'0');
            return <button key={date} type="button" aria-pressed={selectedDay===date}
              className={'trail-day'+(dates.has(date)?' has-events':'')+(selectedDay===date?' active':'')}
              onClick={()=>{setPinnedAlert(null);setSelectedDay(prev=>prev===date?null:date);const found=events.find(x=>x.date===date);setSelectedId(found?.id ?? null);}}>
              <strong>{i+1}</strong><i aria-hidden="true"/></button>;
          })}</div>
        <div className="trail-cal-foot">{selectedDay ? (dates.has(selectedDay)
          ? 'Eventos registrados ou previstos em '+friendlyDate(selectedDay)+'.'
          : 'Nenhum evento carregado para '+friendlyDate(selectedDay)+'.') :
          'Escolha uma data para destacar seus eventos. Apenas as páginas carregadas aparecem no calendário.'}</div>
        {selectedDay && <button className="text-btn" onClick={()=>setSelectedDay(null)}>Limpar seleção da data</button>}
      </section>
    </div>
  </section>;
}
