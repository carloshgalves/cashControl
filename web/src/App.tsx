import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ApiError, allPages, getSession, login, logout, request, snapshot } from './api.ts';
import { AlertPreview, TimelineScreen } from './Trail.tsx';
import { ReportDialog } from './ReportDialog.tsx';
import { CardScreen } from './CardScreen.tsx';
import type { TrailFilter } from './trail.ts';
import type { Account, Obligation, Movement, Session, Dashboard } from './api.ts';
import {
  money, parseAmount, monthBounds, monthLabel, shiftMonth, today, weekOf, weekRange,
  groupWeeks, validateWeekReconciliation, timeline, dueOn, accountBalancePreview,
  friendlyDate,
} from './finance.ts';

type View = 'overview' | 'movement' | 'trail' | 'calendar' | 'accounts' | 'cards';
type EntryMode = 'income' | 'expense' | 'transfer' | 'pay' | 'account';
type Data = Awaited<ReturnType<typeof snapshot>>;
const names: Record<View, string> = {
  overview: 'Panorama', movement: 'Movimentos', trail: 'Trilha financeira', calendar: 'Agenda', accounts: 'Minhas contas', cards: 'Cartões',
};
const controls: { value: View; icon: string; short: string }[] = [
  { value: 'overview', icon: '◫', short: 'Início' }, { value: 'movement', icon: '↗', short: 'Fluxo' },
  { value: 'trail', icon: '◉', short: 'Trilha' },
  { value: 'calendar', icon: '▦', short: 'Agenda' }, { value: 'accounts', icon: '◩', short: 'Contas' },
  { value: 'cards', icon: '▤', short: 'Cartões' },
];
const methodNames: Record<string, string> = { pix: 'Pix', cash: 'Espécie', debit: 'Débito', bank_transfer: 'Transferência externa' };
function Icon({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="ui-icon">{children}</span>;
}
function readableError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '';
  return error instanceof Error && error.message.startsWith('Há registros demais')
    ? error.message : 'Não foi possível concluir. Verifique a conexão e tente novamente.';
}
function signInSubmit(email: string, password: string) { return login(email.trim(), password); }

function Login({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      await signInSubmit(email, password);
      const session = await getSession();
      if (!session?.user?.id) throw new Error('Sessão indisponível');
      setPassword('');
      onSuccess(session);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401
        ? 'Não foi possível entrar. Confira suas credenciais.' : readableError(cause));
    } finally { setBusy(false); }
  }
  return <div className="auth-page">
    <div className="auth-card">
      <div className="brand"><span className="brand-glyph"><i/><i/><i/></span>cashControl</div>
      <span className="eyebrow">Seu espaço financeiro</span>
      <h1>Seu dinheiro, em perspectiva.</h1>
      <p className="auth-intro">Acesse suas contas, seus compromissos e a história de cada movimento.</p>
      <form onSubmit={submit} className="auth-form">
        <label htmlFor="email">E-mail</label>
        <input id="email" type="email" autoComplete="username" required value={email}
          onChange={e => setEmail(e.target.value)} maxLength={254}/>
        <label htmlFor="password">Senha</label>
        <input id="password" type="password" autoComplete="current-password" required value={password}
          onChange={e => setPassword(e.target.value)}/>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Entrando…' : 'Entrar com segurança'} <Icon>↗</Icon></button>
      </form>
      <p className="helper">A criação de novos usuários está controlada pelo administrador. Nenhum dado financeiro fica salvo neste dispositivo.</p>
    </div>
  </div>;
}

interface FormDraft {
  amount: string; description: string; date: string; accountId: string; targetId: string;
  method: 'pix' | 'cash' | 'debit' | 'bank_transfer'; name: string; kind: 'general'|'bank'|'cash';
  fundingMode: 'external'|'reallocate';
}
function freshDraft(accounts: Account[], mode: EntryMode, bill?: Obligation): FormDraft {
  // D1 may return same-second accounts in UUID order, not by the order the
  // person created them. Transfers must never default to the same account.
  const needsDebit = mode === 'transfer' || mode === 'expense' || mode === 'pay';
  const source = needsDebit
    ? (accounts.find(account => account.balanceCents > 0) ?? accounts[0])
    : accounts[0];
  const destination = accounts.find(account => account.accountId !== source?.accountId);
  return { amount: bill ? (bill.outstandingCents / 100).toFixed(2).replace('.', ',') : '',
    description: bill ? 'Pagamento: ' + bill.title : '', date: today(),
    accountId: source?.accountId ?? '', targetId: destination?.accountId ?? '',
    method: 'pix', name: '', kind: accounts.length ? 'bank' : 'general',
    fundingMode: 'external' };
}
function Dialog({ mode, bill, accounts, onClose, onComplete }: {
  mode: EntryMode; bill?: Obligation; accounts: Account[]; onClose: () => void;
  onComplete: () => void;
}) {
  const [kind, setKind] = useState<EntryMode>(mode);
  const [draft, setDraft] = useState<FormDraft>(() => freshDraft(accounts, mode, bill));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const isTransfer = kind === 'transfer';
  const isAccount = kind === 'account';
  const isPay = kind === 'pay';
  const source = accounts.find(a => a.accountId === draft.accountId);
  const target = accounts.find(a => a.accountId === draft.targetId);
  const estimate = accountBalancePreview(source, draft.amount, kind === 'income' ? 'income' : isTransfer ? 'transfer' : 'expense');
  const converted = parseAmount(draft.amount);
  const amountCents = converted === null ? 0 : Math.round(Number(converted) * 100);
  function edit(field: keyof FormDraft, value: string) {
    key.current = crypto.randomUUID();
    setError('');
    setDraft(x => ({ ...x, [field]: value }));
  }
  useEffect(() => {
    previousFocus.current = document.activeElement;
    first.current?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, []);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ) ?? []).filter(element => element.getClientRects().length);
    if (!elements.length) return;
    if (event.shiftKey && document.activeElement === elements[0]) {
      event.preventDefault(); elements[elements.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
      event.preventDefault(); elements[0].focus();
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!isAccount && !converted) { setError('Informe um valor maior que zero, com no máximo dois decimais.'); return; }
    if (isTransfer && (draft.accountId === draft.targetId || !source || !target)) {
      setError('Escolha contas de origem e destino diferentes.'); return;
    }
    if (isTransfer && source && amountCents > source.balanceCents) {
      setError('O saldo registrado de origem é insuficiente para a transferência.'); return;
    }
    if (isPay && bill && amountCents > bill.outstandingCents) {
      setError('A baixa não pode ultrapassar a pendência atual.'); return;
    }
    if (!isAccount && !source) { setError('Selecione uma conta.'); return; }
    if (!isAccount && !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
      setError('Informe uma data válida.'); return;
    }
    const idempotencyKey = key.current;
    setBusy(true);
    try {
      if (isAccount) {
        const opening = draft.amount.trim() === '' || /^0(?:[,.]0{1,2})?$/.test(draft.amount.trim()) ? '0.00' : converted;
        if (opening === null || !draft.name.trim()) throw new Error('Informe nome e saldo inicial válido.');
        if (draft.fundingMode === 'reallocate' && (!source || opening === '0.00' ||
            Number(opening) * 100 > source.balanceCents)) {
          throw new Error('A origem precisa ter saldo suficiente para realocação.');
        }
        await request('/api/accounts', { method: 'POST', body: {
          idempotencyKey, name: draft.name.trim(), kind: draft.kind,
          funding: draft.fundingMode === 'external'
            ? { mode: 'external', amount: opening }
            : { mode: 'reallocate', amount: opening, fromAccountId: draft.accountId },
        } });
      } else if (isTransfer) {
        await request('/api/transfers', { method: 'POST', body: {
          idempotencyKey, sourceAccountId: draft.accountId, targetAccountId: draft.targetId,
          amount: converted, transferredOn: draft.date,
        } });
      } else if (isPay && bill) {
        await request('/api/obligations/' + bill.obligationId + '/payments', { method: 'POST', body: {
          idempotencyKey, accountId: draft.accountId, amount: converted,
          method: draft.method, paidOn: draft.date,
        } });
      } else if (!isPay) {
        if (!draft.description.trim()) throw new Error('Descreva o movimento.');
        await request('/api/movements', { method: 'POST', body: {
          idempotencyKey, accountId: draft.accountId, amount: converted,
          method: draft.method, direction: kind, description: draft.description.trim(),
          occurredOn: draft.date,
        } });
      }
      onComplete();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message :
        cause instanceof Error && (cause.message.startsWith('Informe') || cause.message.startsWith('A origem') || cause.message.startsWith('Descreva'))
          ? cause.message : readableError(cause));
    } finally { setBusy(false); }
  }
  const header = kind === 'account' ? 'Adicionar conta' : isPay ? 'Registrar pagamento' : 'Registrar movimento';
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={panel} onKeyDown={keyboard}>
      <div className="dialog-head"><div><span className="eyebrow">Controle financeiro</span><h2 id="dialog-title">{header}</h2></div>
        <button type="button" aria-label="Fechar diálogo" className="close-btn" disabled={busy} onClick={onClose}>×</button></div>
      {!isAccount && !isPay && <div className="mode-tabs" role="group" aria-label="Tipo de lançamento">
        {(['expense','income','transfer'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value}
          className={kind === value ? 'active' : ''} disabled={busy} onClick={() => {
            setKind(value); setDraft(freshDraft(accounts,value)); key.current = crypto.randomUUID(); setError('');
          }}>{value === 'expense' ? 'Saída' : value === 'income' ? 'Entrada' : 'Transferência'}</button>)}
      </div>}
      <form onSubmit={submit} className="entry-form">
        {isAccount && <><label htmlFor="entry-name">Nome da conta</label>
          <input id="entry-name" ref={first} required maxLength={80} value={draft.name}
            placeholder="Ex.: Conta principal" onChange={e => edit('name',e.target.value)}/>
          <label htmlFor="entry-kind">Tipo</label>
          <select id="entry-kind" value={draft.kind} onChange={e => edit('kind',e.target.value)}>
            {!accounts.some(a => a.kind === 'general') && <option value="general">Carteira geral</option>}
            <option value="bank">Conta bancária</option><option value="cash">Dinheiro em espécie</option>
          </select>
          <label htmlFor="entry-funding">Origem do saldo inicial</label>
          <select id="entry-funding" value={draft.fundingMode} onChange={e=>edit('fundingMode',e.target.value)}>
            <option value="external">Dinheiro ainda não registrado</option>
            {accounts.length > 0 && <option value="reallocate">Reorganizar valor já registrado</option>}
          </select></>}
        <label htmlFor="entry-amount">{isAccount ? 'Saldo inicial (R$) — pode ser zero' : 'Valor (R$)'}</label>
        <input id="entry-amount" ref={isAccount ? undefined : first} required={!isAccount}
          inputMode="decimal" autoComplete="off" value={draft.amount} placeholder="0,00"
          onChange={e => edit('amount',e.target.value)}/>
        {!isAccount && !isTransfer && !isPay && <><label htmlFor="entry-description">Descrição</label>
          <input id="entry-description" required maxLength={120} placeholder="Ex.: Mercado, serviço recebido"
            value={draft.description} onChange={e => edit('description',e.target.value)}/></>}
        {(accounts.length > 0) && <><label htmlFor="entry-account">{isAccount ? 'Da conta já registrada' : isTransfer ? 'Conta de origem' : isPay ? 'Conta que pagou' : 'Conta'}</label>
          <select id="entry-account" value={draft.accountId} onChange={e=>edit('accountId',e.target.value)}>
            {accounts.map(account=><option key={account.accountId} value={account.accountId}>{account.name} · {money(account.balanceCents)}</option>)}
          </select></>}
        {isTransfer && <><label htmlFor="entry-target">Conta de destino</label>
          <select id="entry-target" value={draft.targetId} onChange={e=>edit('targetId',e.target.value)}>
            <option value="">Escolha a conta</option>
            {accounts.map(account=><option key={account.accountId} value={account.accountId}>{account.name}</option>)}
          </select></>}
        {!isAccount && <><label htmlFor="entry-date">Data efetiva</label>
          <input id="entry-date" type="date" required value={draft.date} onChange={e=>edit('date',e.target.value)}/></>}
        {!isAccount && !isTransfer && <><label htmlFor="entry-method">Meio de pagamento ou recebimento</label>
          <select id="entry-method" value={draft.method} onChange={e=>edit('method',e.target.value)}>
            {Object.entries(methodNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select></>}
        <div className="form-context">
          {isAccount ? draft.fundingMode === 'external'
            ? 'Saldo externo: adiciona dinheiro ao patrimônio registrado. Para mover saldo já registrado, escolha reorganizar valor.'
            : 'Realocação: não aumenta o patrimônio total. O valor sai de uma conta já existente.'
            : isTransfer ? 'A transferência não cria receita nem despesa. ' +
                (estimate === null ? '' : 'Origem após registro: ' + money(estimate) + '. ' +
                (target ? 'Destino: ' + money(target.balanceCents + amountCents) + '.' : ''))
            : (estimate === null ? 'O registro altera somente o saldo efetivo.'
              : 'Saldo estimado após confirmação: ' + money(estimate) + '.') +
              (isPay && bill ? ' Pendência restante: ' + money(Math.max(0,bill.outstandingCents - amountCents)) + '.' : '')}
          {estimate !== null && estimate < 0 && !isTransfer && !isAccount &&
            <strong className="warning"> O saldo ficará negativo. Confirme somente se o pagamento já ocorreu.</strong>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="primary-btn" disabled={busy || (isTransfer && accounts.length < 2)}>
          {busy ? 'Confirmando…' : isAccount ? 'Criar conta' : isPay ? 'Registrar pagamento efetivo' : 'Confirmar registro'}
        </button>
        <p className="small-note">Os valores serão gravados na sua conta autenticada. Se ocorrer erro de rede, tente novamente sem alterar os dados.</p>
      </form>
    </div>
  </div>;
}

function Activity({ item }: { item: ReturnType<typeof timeline>[number] }) {
  const negative = item.kind === 'expense';
  const symbol = item.kind === 'income' ? '↗' : item.kind === 'expense' ? '↘' : item.kind === 'transfer' ? '⇄' : '↩';
  return <div className="activity-row">
    <span className={'activity-symbol ' + item.kind} aria-hidden="true">{symbol}</span>
    <div className="activity-text"><strong>{item.title}</strong><span>{friendlyDate(item.date)} · {item.subtitle}</span></div>
    <strong className={'activity-amount ' + (negative ? 'negative' : item.kind === 'transfer' ? 'neutral' : 'positive')}>
      {item.kind === 'transfer' ? '' : negative ? '−' : '+'}{money(item.amountCents)}
    </strong>
  </div>;
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [view, setView] = useState<View>('overview');
  const [month, setMonth] = useState(() => today().slice(0,7));
  const [week, setWeek] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expandedBill, setExpandedBill] = useState<string | null>(null);
  const [modal, setModal] = useState<{mode: EntryMode; bill?: Obligation} | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cardJump,setCardJump]=useState<{cardId:string;cycle:string}|null>(null);
  // Stable callbacks prevent card effects from refetching every time the
  // parent renders and stop a consumed alert target from reselecting a card.
  const invalidateSession=useCallback(()=>{
    setSession(null);setData(null);setView('overview');setCardJump(null);
  },[]);
  const clearCardJump=useCallback(()=>setCardJump(null),[]);
  const [reportPreset, setReportPreset] = useState<TrailFilter | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(value => { if (!controller.signal.aborted) setSession(value?.user?.id ? value : null); })
      .catch(e => { if (!controller.signal.aborted) { setSession(null); setError(readableError(e)); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setData(null); setLoading(true); setError('');
    snapshot(month, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const w = groupWeeks(result.movements, month);
      if (!validateWeekReconciliation(w, result.dashboard.cashFlow)) {
        throw new Error('Os movimentos e os totais do período não conferem. Atualize antes de continuar.');
      }
      setData(result);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) { setSession(null); setData(null); return; }
      setError(cause instanceof Error && cause.message.includes('não conferem') ? cause.message : readableError(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, refreshKey, session]);

  const accounts = data?.dashboard.balances.accounts ?? [];
  const activities = useMemo(() => data ? timeline(data.movements, data.transfers, accounts, month) : [],
    [data, accounts, month]);
  const weeks = useMemo(() => data ? groupWeeks(data.movements, month) : [], [data,month]);
  const activeWeek = weeks[week];
  const monthlyBills = useMemo(() => (data?.obligations ?? []).filter(b => b.outstandingCents > 0 &&
    b.dueOn.startsWith(month)).sort((a,b)=>a.dueOn.localeCompare(b.dueOn)), [data,month]);
  const allPending = (data?.obligations ?? []).filter(b=>b.outstandingCents > 0);
  const selected = accounts.find(a => a.accountId === selectedAccount);
  const activePeriod = weekRange(month,week);
  const visibleActivity = activities.filter(a => a.date >= activePeriod.from && a.date <= activePeriod.to);
  const focusDay = selectedDay ?? (monthlyBills[0]?.dueOn ?? monthBounds(month).from);
  const dateBills = dueOn(monthlyBills, focusDay);
  const weekMax = Math.max(1,...weeks.map(w=>Math.max(w.incomeCents + w.refundsCents,w.expensesCents)));
  const year = Number(month.slice(0,4)), monthNumber = Number(month.slice(5,7));
  const calendarDays = new Date(Date.UTC(year,monthNumber,0)).getUTCDate();
  const emptySlots = new Date(Date.UTC(year,monthNumber-1,1)).getUTCDay();

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      setSession(null); setData(null); setModal(null); setReportPreset(null); setError('');
      // Never retain the previous user's navigation, selected account/day or
      // financial context when a different session signs in on this tab.
      setView('overview'); setMonth(today().slice(0,7)); setWeek(1);
      setSelectedAccount(null); setSelectedDay(null); setExpandedBill(null); setCardJump(null); setNotice('');
    }
    catch (cause) { setNotice(readableError(cause)); }
    finally { setSigningOut(false); }
  }
  function changeMonth(step: number) {
    setMonth(m => shiftMonth(m,step)); setWeek(1); setSelectedDay(null);
    setSelectedAccount(null); setExpandedBill(null);
  }
  function done() {
    setModal(null); setSelectedDay(null);
    setNotice('Registro confirmado e atualizado.');
    setRefreshKey(x=>x+1);
  }
  function moveTo(next: View) { setCardJump(null);setView(next); setNotice(''); }
  function openCardAlert(cardId:string,cycle:string){
    setCardJump({cardId,cycle});setNotice('');setView('cards');
  }

  if (session === undefined) return <div className="auth-page"><div className="loading-mark" role="status">Verificando sessão segura…</div></div>;
  if (!session) return <Login onSuccess={value => {
    setView('overview'); setSelectedAccount(null); setSelectedDay(null);
    setExpandedBill(null); setWeek(1); setMonth(today().slice(0,7));
    setSession(value); setData(null); setReportPreset(null); setCardJump(null); setError(''); setNotice('');
  }}/>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-glyph"><i/><i/><i/></span>cashControl</div>
      <nav aria-label="Seções" className="side-nav">
        {controls.map(item=><button type="button" key={item.value} onClick={()=>moveTo(item.value)}
          className={'nav-btn ' + (view === item.value ? 'active' : '')} aria-current={view === item.value ? 'page' : undefined}>
          <Icon>{item.icon}</Icon>{names[item.value]}</button>)}
      </nav>
      <div className="sidebar-foot">
        <span className="eyebrow">Minha conta</span><strong className="user-email">{session.user.email}</strong>
        <button className="outline-btn" disabled={signingOut} onClick={signOut}>{signingOut ? 'Saindo…' : 'Sair com segurança'}</button>
        <small>Dados exibidos somente para esta sessão.</small>
      </div>
    </aside>
    <main className="page">
      <header className="topbar">
        <span className="breadcrumb">cashControl <span>/</span> {names[view]}</span>
        <div className="top-actions"><span className="security-chip"><Icon>●</Icon> Sessão protegida</span>
          <button type="button" className="mobile-logout" aria-label="Sair com segurança" title="Sair com segurança"
            disabled={signingOut} onClick={signOut}><Icon>↪</Icon></button>
          <button type="button" className="outline-btn report-top-button" aria-label="Exportar relatório"
            disabled={!data || loading || !!error} onClick={() => setReportPreset('all')}>
            <Icon>⇩</Icon> Exportar
          </button>
          <button className="primary-btn register-btn" onClick={()=>setModal({mode:'expense'})} disabled={!accounts.length}>
            <Icon>＋</Icon> Registrar
          </button></div>
      </header>
      <div className="heading">
        <div><span className="eyebrow">Seu panorama financeiro</span><h1>{
          view==='overview' ? 'Seu dinheiro tem um ritmo.' :
            view==='movement' ? 'A história do seu dinheiro.' :
            view==='trail' ? 'Sua trilha financeira.' :
            view==='calendar' ? 'O que vem pela frente.' : view==='cards' ? 'Seu crédito sem confusões.' : 'Onde está seu dinheiro.'
        }</h1><p>{view==='overview' ? 'O que mudou, o que vem e onde você pode agir.' :
          view==='movement' ? 'Entradas, saídas, reembolsos e transferências sem dupla contagem.' :
          view==='trail' ? 'Eventos reais, compromissos futuros e vencimentos para explorar.' :
          view==='calendar' ? 'Compromissos futuros, sem confundir vencimento com pagamento.' :
          view==='cards' ? 'Compras parceladas e faturas, sem débito bancário antes do pagamento.' :
          'O dinheiro muda de lugar sem virar uma nova receita.'}</p></div>
        <div className="period-control" aria-label="Mês de referência">
          <button onClick={()=>changeMonth(-1)} aria-label="Mês anterior">‹</button>
          <strong>{monthLabel(month)}</strong>
          <button onClick={()=>changeMonth(1)} aria-label="Próximo mês">›</button>
        </div>
      </div>
      {notice && <div role="status" className="notice-banner">{notice}<button aria-label="Dispensar aviso" onClick={()=>setNotice('')}>×</button></div>}
      {loading && <div className="loading-panel" role="status">Atualizando valores e compromissos…</div>}
      {error && <section role="alert" className="error-panel"><strong>Não foi possível mostrar informações confiáveis.</strong><p>{error}</p>
        <button className="outline-btn" onClick={()=>setRefreshKey(x=>x+1)}>Tentar novamente</button></section>}
      {data && !loading && !error && <>
        {view==='cards' && <CardScreen accounts={accounts} focusCardId={cardJump?.cardId} focusCycle={cardJump?.cycle}
          onFocusConsumed={clearCardJump}
          onPaid={()=>{setNotice('Fatura paga. Saldo e extratos serão atualizados.');setRefreshKey(x=>x+1);}}
          onUnauthorized={invalidateSession}/>}
        {view==='overview' && <AlertPreview refreshKey={refreshKey} onExplore={()=>moveTo('trail')} onOpenCard={openCardAlert}/>}
        {view==='trail' && <TimelineScreen month={month} obligations={data.obligations} refreshKey={refreshKey}
          onPay={bill=>setModal({mode:'pay',bill})} onCards={()=>moveTo('cards')} onOpenCard={openCardAlert}
          onExport={status=>setReportPreset(status)}/>}
        {view==='overview' && <div className="grid-main">
          <div className="main-column">
            <section className="balance-panel" aria-labelledby="balance-title">
              <span id="balance-title" className="eyebrow">Saldo registrado agora · todas as contas</span>
              <div className="display">{money(data.dashboard.balances.totalCents)}</div>
              <p>Saldo atual, independentemente do mês selecionado. Compromissos não pagos ficam separados.</p>
              <div className="account-map">{accounts.map(account=><button key={account.accountId}
                className={'account-pill ' + (selectedAccount===account.accountId?'selected':'')}
                aria-pressed={selectedAccount===account.accountId}
                onClick={()=>setSelectedAccount(x=>x===account.accountId?null:account.accountId)}>
                <span>{account.name}</span><strong>{money(account.balanceCents)}</strong></button>)}</div>
              {accounts.length===0 && <div className="balance-empty"><span>Nenhuma conta cadastrada.</span>
                <button onClick={()=>setModal({mode:'account'})}>Criar minha primeira carteira <Icon>↗</Icon></button></div>}
              <small>{selected ? 'Selecionada: ' + selected.name + ' · saldo atual ' + money(selected.balanceCents) :
                'Selecione uma conta para destacar seu saldo.'}</small>
            </section>
            <section className="flow-panel" aria-labelledby="rhythm-title">
              <div className="section-head"><div><h2 id="rhythm-title">O ritmo do seu mês</h2>
                <p>Escolha uma semana para explorar os movimentos.</p></div><Icon>↗</Icon></div>
              <div className="chart">
                <div className="chart-key"><span>Semanas de {monthLabel(month)}</span>
                  <div><span><i className="dot pos"/> Entrou</span><span><i className="dot neg"/> Saiu</span></div></div>
                <div className="week-bars" role="group" aria-label="Semanas do mês">
                  {weeks.map(w=><button type="button" key={w.index} aria-pressed={week===w.index}
                    className={'week ' + (week===w.index?'active':'')} onClick={()=>setWeek(w.index)}
                    aria-label={weekRange(month,w.index).title + ': entradas e reembolsos ' +
                      money(w.incomeCents+w.refundsCents) + ', saídas ' + money(w.expensesCents)}>
                    <span className="bars"><i style={{height:Math.max(3,(w.incomeCents+w.refundsCents)/weekMax*100)+'%'}}/>
                      <i className="out" style={{height:Math.max(3,w.expensesCents/weekMax*100)+'%'}}/></span>
                    <span>{weekRange(month,w.index).title}</span></button>)}
                </div>
                <div className="week-detail"><span>Semana {week+1} · {activeWeek.count} movimento(s)</span>
                  <strong>{money(activeWeek.incomeCents+activeWeek.refundsCents)} entrou · {money(activeWeek.expensesCents)} saiu</strong></div>
              </div>
              <div className="metric-ribbon">
                <div><span>Recebimentos</span><strong className="positive">{money(data.dashboard.cashFlow.incomeCents)}</strong></div>
                <div><span>Pagamentos</span><strong className="negative">{money(data.dashboard.cashFlow.expensesCents)}</strong></div>
                <div><span>Devoluções</span><strong>{money(data.dashboard.cashFlow.refundsCents)}</strong></div>
                <div><span>Variação líquida</span><strong>{money(data.dashboard.cashFlow.netCents)}</strong></div>
              </div>
              <p className="scope-note">Os valores acima são do mês escolhido. Devoluções não são renda. Transferências internas não são gastos.</p>
            </section>
            <section className="activity-section">
              <div className="section-head"><div><h2>O que aconteceu</h2><p>Movimentos da semana selecionada.</p></div>
                <button className="text-btn" onClick={()=>moveTo('movement')}>Ver o mês inteiro →</button></div>
              {visibleActivity.length ? visibleActivity.slice(0,4).map(item=><Activity key={item.id} item={item}/>) :
                <div className="empty-state">Nenhum movimento registrado nessa semana.</div>}
            </section>
          </div>
          <div className="right-column">
            <section className="horizon">
              <div className="section-head"><h2>O que vem pela frente</h2><span className="count">{allPending.length} conta(s) pendente(s)</span></div>
              <div className="date-rail">{Array.from({length:7},(_,i)=>Math.min(calendarDays,(monthlyBills[0] ? Number(monthlyBills[0].dueOn.slice(8)) : 1)+i))
                .filter((date,i,all)=>all.indexOf(date)===i).map(day=>{
                  const date=month+'-'+String(day).padStart(2,'0');
                  const has=dueOn(monthlyBills,date).length>0;
                  return <button key={day} className={focusDay===date?'active':''}
                    aria-pressed={focusDay===date} onClick={()=>setSelectedDay(date)}>
                    <span>{month.slice(5)}</span><strong>{day}</strong>{has&&<i aria-label="Vencimento" className="due-dot"/>}
                  </button>;
                })}</div>
              <p className="soft-note">Vencimentos não reduzem o saldo até o pagamento ser registrado.</p>
              {monthlyBills.length ? monthlyBills.slice(0,5).map(b=><div key={b.obligationId}
                className={'bill ' + (expandedBill===b.obligationId?'expanded':'')}>
                <button className="bill-toggle" aria-expanded={expandedBill===b.obligationId}
                  onClick={()=>setExpandedBill(x=>x===b.obligationId?null:b.obligationId)}>
                  <span className="bill-icon" aria-hidden="true">◷</span>
                  <span className="bill-name"><strong>{b.title}</strong><small>Vence {friendlyDate(b.dueOn)}</small></span>
                  <strong>{money(b.outstandingCents)}</strong>
                </button>
                {expandedBill===b.obligationId&&<div className="bill-expanded">
                  <p>Já pago: {money(b.paidCents)}. Pendente: {money(b.outstandingCents)}.</p>
                  <button className="text-btn" onClick={()=>setModal({mode:'pay',bill:b})}>Registrar pagamento →</button>
                </div>}
              </div>) : <div className="empty-state">Nenhum vencimento pendente neste mês.</div>}
              <div className="horizon-total"><span>Total pendente · todos os meses</span>
                <strong>{money(data.dashboard.obligations.outstandingCents)}</strong></div>
              {data.dashboard.cardInvoices.openCount>0&&<div className="horizon-total">
                <span>Faturas de cartão em aberto · {data.dashboard.cardInvoices.openCount} ciclo(s)</span>
                <strong>{money(data.dashboard.cardInvoices.outstandingCents)}</strong>
              </div>}
              {data.dashboard.cardInvoices.openCount>0&&<button className="text-btn" onClick={()=>moveTo('cards')}>Ver faturas e pagamentos →</button>}
              <button className="text-btn" onClick={()=>moveTo('calendar')}>Abrir agenda de contas comuns →</button>
            </section>
            <div className="finance-note"><Icon>ⓘ</Icon><span>O saldo é atual. As obrigações em aberto e as movimentações do mês são indicadores distintos.</span></div>
          </div>
        </div>}
        {view==='movement' && <section className="flow-panel wide-section">
          <div className="section-head"><div><h2>Trilha do dinheiro</h2><p>Eventos reais registrados em {monthLabel(month)}.</p></div>
            <button className="primary-btn" disabled={!accounts.length} onClick={()=>setModal({mode:'expense'})}>＋ Novo movimento</button></div>
          <div className="timeline-list">{activities.length ? activities.map(item=><Activity key={item.id} item={item}/>) :
            <div className="empty-state">Sem movimentos registrados neste mês.</div>}</div>
        </section>}
        {view==='calendar' && <section className="flow-panel wide-section">
          <div className="section-head"><div><h2>Agenda de compromissos</h2>
            <p>Selecione um dia com vencimento para ver o compromisso e registrar sua baixa.</p></div>
            <span className="chip">{monthLabel(month)}</span></div>
          <div className="calendar" role="grid" aria-label={'Calendário de '+monthLabel(month)}>
            {['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(day=><div className="weekday" key={day} role="columnheader">{day}</div>)}
            {Array.from({length:emptySlots},(_,i)=><span key={'empty-'+i} aria-hidden="true"/>)}
            {Array.from({length:calendarDays},(_,i)=>{
              const number=i+1, date=month+'-'+String(number).padStart(2,'0');
              const bills=dueOn(monthlyBills,date),total=bills.reduce((sum,b)=>sum+b.outstandingCents,0);
              return <button key={date} className={'calendar-day '+(bills.length?'has-due ':'')+(focusDay===date?'active':'')}
                aria-pressed={focusDay===date} onClick={()=>setSelectedDay(date)}
                aria-label={'Dia '+number+(bills.length?', pendente '+money(total):', sem vencimentos')}>
                <strong>{number}</strong><small>{bills.length?money(total):'·'}</small></button>;
            })}
          </div>
          <div className="selected-date">
            <h3>{friendlyDate(focusDay)}</h3>
            {dateBills.length?dateBills.map(b=><div key={b.obligationId} className="agenda-detail">
              <div><strong>{b.title}</strong><small>Pendente: {money(b.outstandingCents)} · Pago: {money(b.paidCents)}</small></div>
              <button className="text-btn" onClick={()=>setModal({mode:'pay',bill:b})}>Registrar pagamento →</button></div>) :
              <p className="muted">Nenhum compromisso vence neste dia.</p>}
          </div>
        </section>}
        {view==='accounts' && <section className="flow-panel wide-section">
          <div className="section-head"><div><h2>Onde está seu dinheiro</h2><p>Cada saldo é independente. Transferir não cria nova renda.</p></div>
            <div className="action-pair"><button className="outline-btn" onClick={()=>setModal({mode:'account'})}>＋ Adicionar conta</button>
              <button className="primary-btn" disabled={accounts.length<2} onClick={()=>setModal({mode:'transfer'})}>⇄ Transferir</button></div></div>
          <div className="account-grid">{accounts.map(a=><button key={a.accountId}
            className={'large-account '+(selectedAccount===a.accountId?'active':'')}
            aria-pressed={selectedAccount===a.accountId} onClick={()=>setSelectedAccount(a.accountId)}>
            <span className="eyebrow">{a.kind==='bank'?'Conta bancária':a.kind==='cash'?'Espécie':'Carteira geral'}</span>
            <h3>{a.name}</h3><small>Saldo registrado agora</small><strong>{money(a.balanceCents)}</strong>
          </button>)}</div>
          {!accounts.length&&<div className="empty-state">Comece com uma carteira geral sem vincular nenhum banco.
            <button className="text-btn" onClick={()=>setModal({mode:'account'})}>Criar carteira →</button></div>}
          {selected&&<div className="selected-date">Selecionada: <strong>{selected.name}</strong> · {money(selected.balanceCents)}.
            <button className="text-btn" onClick={()=>moveTo('movement')}>Ver movimentos →</button></div>}
        </section>}
      </>}
    </main>
    <nav className="mobile-nav" aria-label="Navegação principal">
      {controls.map(item=><button key={item.value} aria-current={view===item.value?'page':undefined}
        className={view===item.value?'active':''} onClick={()=>moveTo(item.value)}>
        <Icon>{item.icon}</Icon>{item.short}</button>)}
    </nav>
    <button className="mobile-register" onClick={()=>setModal({mode:'expense'})} disabled={!accounts.length} aria-label="Registrar movimento">＋</button>
    {reportPreset !== null && <ReportDialog month={month} accounts={accounts} initialStatus={reportPreset}
      onClose={() => setReportPreset(null)} onSessionExpired={() => {
        setReportPreset(null); setSession(null); setData(null);
        setError(''); setNotice(''); setView('overview'); setSelectedAccount(null);
      }}/>} 
    {modal&&<Dialog mode={modal.mode} bill={modal.bill} accounts={accounts}
      onClose={()=>setModal(null)} onComplete={done}/>}
  </div>;
}
