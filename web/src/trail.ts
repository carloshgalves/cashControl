import type { Obligation } from './api.ts';
import { request } from './api.ts';
import { friendlyDate, money, monthBounds, today } from './finance.ts';

export type TrailStatus = 'realized' | 'pending' | 'overdue' | 'planned' | 'canceled';
export type TrailKind = 'income' | 'expense' | 'payment' | 'refund' | 'transfer' | 'obligation' | 'cancellation';
export type TrailFilter = 'all' | TrailStatus;
export interface TrailEvent {
  id: string; date: string; kind: TrailKind; status: TrailStatus;
  title: string; amountCents: number;
  accountId: string | null; obligationId: string | null; relatedId: string | null;
}
export interface TrailPage {
  events: TrailEvent[]; hasMore: boolean; limit: number; offset: number;
}
export interface DueAlert {
  obligationId: string; title: string; dueOn: string;
  outstandingCents: number; daysUntil: number; level: 'D-10' | 'D-5' | 'overdue';
  cardId?: string; cycle?: string;
}
export interface DueAlertPage {
  alerts: DueAlert[]; hasMore: boolean; limit: number; offset: number; asOf: string;
}
export const filterOptions: { value: TrailFilter; label: string }[] = [
  { value: 'all', label: 'Tudo' },
  { value: 'realized', label: 'Realizados' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'overdue', label: 'Atrasados' },
  { value: 'planned', label: 'Previstos' },
  { value: 'canceled', label: 'Cancelados' },
];
export const statusLabel: Record<TrailStatus, string> = {
  realized: 'Realizado', pending: 'Pendente', overdue: 'Atrasado',
  planned: 'Previsto', canceled: 'Cancelado',
};
export const kindLabel: Record<TrailKind,string> = {
  income: 'Entrada confirmada', expense: 'Saída confirmada',
  payment: 'Pagamento confirmado', refund: 'Reembolso recebido',
  transfer: 'Transferência interna', obligation: 'Obrigação registrada',
  cancellation: 'Cancelamento confirmado',
};
export function eventValue(event: TrailEvent): string {
  if (event.kind === 'cancellation') return 'Sem débito';
  const prefix = event.kind === 'income' || event.kind === 'refund' ? '+'
    : event.kind === 'expense' || event.kind === 'payment' ? '−' : '';
  return prefix + money(event.amountCents);
}
export function alertText(alert: DueAlert): string {
  if (alert.daysUntil < 0) return 'Atrasada há ' + Math.abs(alert.daysUntil) +
    (Math.abs(alert.daysUntil) === 1 ? ' dia' : ' dias');
  if (alert.daysUntil === 0) return 'Vence hoje';
  return 'Vence em ' + alert.daysUntil + (alert.daysUntil === 1 ? ' dia' : ' dias');
}
export function alertBand(alert: DueAlert): string {
  return alert.level === 'overdue' ? 'Atrasado' : alert.level;
}
export function findPayable(event: TrailEvent, obligations: Obligation[]): Obligation | undefined {
  if (event.kind !== 'obligation' || !event.obligationId) return undefined;
  return obligations.find(o => o.obligationId === event.obligationId && o.outstandingCents > 0);
}
export function trailURL(month: string, asOf: string, status: TrailFilter, offset = 0): string {
  const { from, to } = monthBounds(month);
  return '/api/timeline?' + new URLSearchParams({
    from, to, asOf, status, limit: '30', offset: String(offset),
  });
}
export function alertsURL(asOf: string, offset = 0): string {
  return '/api/alerts?' + new URLSearchParams({ asOf, limit: '20', offset: String(offset) });
}
export const localToday = today;
export const dateText = friendlyDate;
export async function fetchTrail(month: string, asOf: string, status: TrailFilter,
  offset = 0, signal?: AbortSignal) {
  return request<TrailPage>(trailURL(month, asOf, status, offset), { signal });
}
export async function fetchAlerts(asOf: string, offset = 0, signal?: AbortSignal) {
  return request<DueAlertPage>(alertsURL(asOf, offset), { signal });
}
