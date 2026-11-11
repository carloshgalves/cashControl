import type { TrailFilter } from './trail.ts';

export type ReportFormat = 'xlsx' | 'pdf';
export interface ReportFilters {
  from: string;
  to: string;
  asOf: string;
  status: TrailFilter;
  accountId?: string;
}
export class ReportDownloadError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = 'ReportDownloadError';
  }
}
const allowedStatuses: TrailFilter[] = ['all', 'realized', 'pending', 'overdue', 'planned', 'canceled'];
const MIME: Record<ReportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
export function isCivilDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}
export function reportURL(filters: ReportFilters, format: ReportFormat): string {
  if (!isCivilDate(filters.from) || !isCivilDate(filters.to) || !isCivilDate(filters.asOf) ||
      filters.from > filters.to) {
    throw new ReportDownloadError('Confira o período. A data inicial deve ser anterior ou igual à final.');
  }
  if (!allowedStatuses.includes(filters.status) || !Object.hasOwn(MIME, format)) {
    throw new ReportDownloadError('Formato ou situação de exportação inválidos.');
  }
  if (filters.accountId && !/^[0-9a-f-]{36}$/.test(filters.accountId)) {
    throw new ReportDownloadError('Selecione uma conta válida.');
  }
  const params = new URLSearchParams({
    format, from: filters.from, to: filters.to, asOf: filters.asOf, status: filters.status,
  });
  if (filters.accountId) params.set('accountId', filters.accountId);
  return '/api/reports/export?' + params.toString();
}
function failure(status: number): ReportDownloadError {
  switch (status) {
    case 400: return new ReportDownloadError('Filtros inválidos. Confira datas, situação e conta.', status);
    case 401: return new ReportDownloadError('Sua sessão expirou. Entre novamente antes de exportar.', status);
    case 403: return new ReportDownloadError('Esta exportação não foi autorizada.', status);
    case 404: return new ReportDownloadError('A conta selecionada não está disponível para sua sessão.', status);
    case 409: return new ReportDownloadError('Os valores estão sendo atualizados ou não conferem. Atualize os dados e tente novamente.', status);
    case 413: return new ReportDownloadError('Há eventos demais para um relatório íntegro. Reduza o período ou refine os filtros.', status);
    default: return new ReportDownloadError('Não foi possível gerar o arquivo. Tente novamente.', status);
  }
}
export interface PreparedReport {
  blob: Blob;
  filename: string;
}
/** Download remains tied to the current verified cookie; no reusable document URL is stored. */
export async function fetchReport(
  filters: ReportFilters, format: ReportFormat, signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PreparedReport> {
  const url = reportURL(filters, format);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { accept: MIME[format] }, signal,
    });
  } catch (cause) {
    if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw cause;
    throw new ReportDownloadError('Falha de conexão ao preparar o relatório. Tente novamente.');
  }
  if (!response.ok) throw failure(response.status);
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== MIME[format]) {
    throw new ReportDownloadError('O servidor devolveu um arquivo em formato inesperado.');
  }
  let blob: Blob;
  try { blob = await response.blob(); }
  catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ReportDownloadError('O arquivo não pôde ser recebido por completo.');
  }
  if (signal?.aborted) throw new DOMException('Operação cancelada', 'AbortError');
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  const valid = format === 'xlsx'
    ? head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
    : head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
  if (!valid) throw new ReportDownloadError('O arquivo gerado está incompleto ou não corresponde ao formato escolhido.');
  return { blob, filename: 'cashcontrol-historico-' + filters.from + '-a-' + filters.to + '.' + format };
}
