import type { Movement, Transfer, Account, Obligation } from './api.ts';

export const money = (cents: number): string => {
  if (!Number.isSafeInteger(cents)) throw new RangeError('Valor monetário inválido');
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
};
export function parseAmount(value: string): string | null {
  const raw = value.trim().replace(/^R\$\s*/, '').replace(/\s/g, '');
  let normal: string;
  if (/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)) normal = raw.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,9}(?:[,.]\d{1,2})?$/.test(raw)) normal = raw.replace(',', '.');
  else return null;
  const [whole, fraction = ''] = normal.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 9_000_000_000_000) return null;
  return (amount / 100).toFixed(2);
}
export function monthBounds(month: string): { from: string; to: string } {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new RangeError('Mês inválido');
  const [year, num] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, num, 0)).getUTCDate();
  return { from: month + '-01', to: month + '-' + String(last).padStart(2, '0') };
}
export function shiftMonth(month: string, step: number): string {
  const { from } = monthBounds(month);
  if (!Number.isInteger(step) || Math.abs(step) > 12) throw new RangeError('Deslocamento inválido');
  const [y, m] = from.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return d.toISOString().slice(0, 7);
}
export function today(): string {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
export function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, number - 1, 1)));
}
export function friendlyDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}
export function weekOf(date: string): number {
  const day = Number(date.slice(8, 10));
  return day <= 7 ? 0 : day <= 14 ? 1 : day <= 21 ? 2 : 3;
}
export function weekRange(month: string, index: number): { from: string; to: string; title: string } {
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new RangeError('Semana inválida');
  const { to: last } = monthBounds(month);
  const start = [1, 8, 15, 22][index], end = index === 3 ? Number(last.slice(8)) : [7, 14, 21][index];
  const prefix = month + '-';
  return { from: prefix + String(start).padStart(2, '0'),
    to: prefix + String(end).padStart(2, '0'), title: String(start).padStart(2, '0') + '–' + String(end).padStart(2, '0') };
}
export interface WeekSummary { index: number; incomeCents: number; expensesCents: number; refundsCents: number; netCents: number; count: number }
export function groupWeeks(movements: Movement[], month: string): WeekSummary[] {
  const weeks: WeekSummary[] = Array.from({ length: 4 }, (_, index) => ({
    index, incomeCents: 0, expensesCents: 0, refundsCents: 0, netCents: 0, count: 0,
  }));
  for (const movement of movements) {
    if (movement.occurredOn.slice(0, 7) !== month) continue;
    const row = weeks[weekOf(movement.occurredOn)];
    if (!Number.isSafeInteger(movement.amountCents) || movement.amountCents <= 0) {
      throw new RangeError('Lançamento com valor inválido');
    }
    row.count += 1;
    if (movement.direction === 'expense') row.expensesCents += movement.amountCents;
    else if (movement.eventKind === 'refund') row.refundsCents += movement.amountCents;
    else row.incomeCents += movement.amountCents;
    row.netCents = row.incomeCents + row.refundsCents - row.expensesCents;
    if (![row.incomeCents, row.expensesCents, row.refundsCents, row.netCents].every(Number.isSafeInteger)) {
      throw new RangeError('Total da semana excede limite monetário');
    }
  }
  return weeks;
}
export function validateWeekReconciliation(weeks: WeekSummary[], flow: {
  incomeCents: number; expensesCents: number; refundsCents: number; netCents: number;
}): boolean {
  return ['incomeCents', 'expensesCents', 'refundsCents', 'netCents'].every(key =>
    weeks.reduce((sum, week) => sum + week[key as keyof WeekSummary], 0) ===
      flow[key as keyof typeof flow]);
}
export function timeline(movements: Movement[], transfers: Transfer[], accounts: Account[], month: string) {
  const names = new Map(accounts.map(a => [a.accountId, a.name]));
  return [
    ...movements.filter(x => x.occurredOn.startsWith(month)).map(x => ({
      id: x.movementId, date: x.occurredOn, kind: x.eventKind === 'refund' ? 'refund' : x.direction,
      title: x.description, subtitle: names.get(x.accountId) ?? 'Conta registrada',
      amountCents: x.amountCents,
    })),
    ...transfers.filter(x => x.transferredOn.startsWith(month)).map(x => ({
      id: x.transferId, date: x.transferredOn, kind: 'transfer',
      title: 'Transferência interna',
      subtitle: (names.get(x.sourceAccountId) ?? 'Origem') + ' → ' + (names.get(x.targetAccountId) ?? 'Destino'),
      amountCents: x.amountCents,
    })),
  ].sort((a,b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
export function dueOn(obligations: Obligation[], date: string): Obligation[] {
  return obligations.filter(o => o.outstandingCents > 0 && o.dueOn === date)
    .sort((a,b) => a.title.localeCompare(b.title));
}
export function accountBalancePreview(account: Account | undefined, amount: string, mode: 'income'|'expense'|'transfer'): number | null {
  if (!account) return null;
  const normalized = parseAmount(amount);
  if (!normalized) return null;
  const cents = Math.round(Number(normalized) * 100);
  return account.balanceCents + (mode === 'income' ? cents : -cents);
}
