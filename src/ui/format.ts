import { fmtPrice } from '../analysis/util';
export { fmtPrice };

const londonDT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const londonD = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: '2-digit' });
const londonT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const fmtDateTime = (t: number) => londonDT.format(new Date(t * 1000));
export const fmtDate = (t: number) => londonD.format(new Date(t * 1000));
export const fmtTime = (t: number) => londonT.format(new Date(t * 1000));
export const fmtPct = (x: number) => `${x.toFixed(2)}%`;
export const fmtRR = (x: number) => `${x.toFixed(2)}R`;
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
