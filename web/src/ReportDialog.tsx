import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { Account } from './api.ts';
import { friendlyDate, monthBounds, monthLabel, today } from './finance.ts';
import { filterOptions, type TrailFilter } from './trail.ts';
import { fetchReport, ReportDownloadError, type ReportFilters, type ReportFormat } from './report.ts';
import './report.css';

interface Props {
  month: string;
  accounts: Account[];
  initialStatus: TrailFilter;
  onClose: () => void;
  onSessionExpired: () => void;
}
export function ReportDialog({ month, accounts, initialStatus, onClose, onSessionExpired }: Props) {
  const { from: initialFrom, to: initialTo } = monthBounds(month);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState<TrailFilter>(initialStatus);
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    first.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      activeRequest.current?.abort();
      document.body.style.overflow = oldOverflow;
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, []);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ) ?? []).filter(element => element.getClientRects().length);
    if (!elements.length) return;
    if (event.shiftKey && document.activeElement === elements[0]) {
      event.preventDefault(); elements[elements.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
      event.preventDefault(); elements[0].focus();
    }
  }
  function edit(action: () => void) { setError(''); setSuccess(''); action(); }
  async function download(format: ReportFormat) {
    if (busy) return;
    setError(''); setSuccess('');
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(format);
    const filters: ReportFilters = { from, to, asOf: today(), status, ...(accountId ? { accountId } : {}) };
    try {
      // Check that selection remains in the authenticated account list; never
      // rely on client authorization alone (the server checks again).
      if (accountId && !accounts.some(account => account.accountId === accountId)) {
        throw new ReportDownloadError('A conta selecionada não está disponível.');
      }
      const result = await fetchReport(filters, format, controller.signal);
      if (controller.signal.aborted) return;
      const href = URL.createObjectURL(result.blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = result.filename;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Allow the browser's download manager to consume the blob first.
        window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
      } catch (cause) {
        URL.revokeObjectURL(href);
        throw cause;
      }
      setSuccess('Arquivo ' + format.toUpperCase() + ' preparado para download.');
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) return;
      if (cause instanceof ReportDownloadError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof ReportDownloadError ? cause.message :
        'Não foi possível preparar o arquivo. Nenhum lançamento foi alterado.');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  function submit(event: FormEvent) { event.preventDefault(); void download('xlsx'); }
  return <div className="overlay report-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <div ref={dialog} className="dialog report-dialog" role="dialog" aria-modal="true"
      aria-labelledby="report-dialog-title" onKeyDown={keyboard}>
      <div className="dialog-head">
        <div><span className="eyebrow">Relatórios privados · SPEC-003</span>
          <h2 id="report-dialog-title">Exportar histórico</h2></div>
        <button className="close-btn" type="button" aria-label="Fechar exportação"
          disabled={!!busy} onClick={onClose}>×</button>
      </div>
      <p className="report-description">Escolha exatamente o que entra no documento. Entradas, saídas,
        transferências e obrigações preservam suas situações financeiras originais.</p>
      <div className="report-current-period">
        <span className="eyebrow">Período sugerido</span>
        <strong>{monthLabel(month)}</strong>
        <span>Referência dos vencimentos: {friendlyDate(today())}</span>
      </div>
      <form className="report-form" onSubmit={submit}>
        <div className="report-date-grid">
          <label>Data inicial<input ref={first} type="date" required value={from} disabled={!!busy}
            onChange={event => edit(() => setFrom(event.target.value))}/></label>
          <label>Data final<input type="date" required value={to} disabled={!!busy}
            onChange={event => edit(() => setTo(event.target.value))}/></label>
        </div>
        <label>Conta ou escopo
          <select value={accountId} disabled={!!busy} onChange={event => edit(() => setAccountId(event.target.value))}>
            <option value="">Todas as contas e obrigações</option>
            {accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.name}</option>)}
          </select>
        </label>
        <label>Situação dos eventos
          <select value={status} disabled={!!busy}
            onChange={event => edit(() => setStatus(event.target.value as TrailFilter))}>
            {filterOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <p className="report-scope-note">O histórico respeita os filtros selecionados, não apenas a página
          de eventos carregada na tela. Ao filtrar uma conta, obrigações sem conta associada ficam de fora.</p>
        <div className="report-formats" role="group" aria-label="Formato do relatório">
          <button type="submit" className="primary-btn" disabled={!!busy}>
            <span aria-hidden="true">▦</span>{busy === 'xlsx' ? 'Preparando XLSX…' : 'Baixar XLSX'}
          </button>
          <button type="button" className="outline-btn" disabled={!!busy} onClick={() => void download('pdf')}>
            <span aria-hidden="true">▤</span>{busy === 'pdf' ? 'Preparando PDF…' : 'Baixar PDF'}
          </button>
        </div>
        {busy && <p className="report-wait" role="status">Gerando arquivo seguro com os registros desta sessão…</p>}
        {error && <p className="form-error" role="alert">{error} Nenhum lançamento foi alterado.</p>}
        {success && <p className="report-success" role="status">{success}</p>}
        <div className="report-privacy"><strong>Privacidade e integridade</strong>
          <p>Arquivo gerado somente para sua sessão. Não é enviado por e-mail, não fica
            disponível por link público e não altera movimentos. Transferências próprias
            não são receitas; obrigações em aberto ainda não são saídas de caixa.</p></div>
      </form>
    </div>
  </div>;
}
