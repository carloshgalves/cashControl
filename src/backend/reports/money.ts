import type { SheetCell } from './xlsx.ts';

/** Decimal BRL without a binary floating-point conversion. Totals may be
 * larger than any individual transaction, but must remain safe integer cents. */
function parts(cents:number):{negative:boolean;whole:string;fraction:string}{
 if(!Number.isSafeInteger(cents))throw new RangeError('Unsafe financial cents');
 const negative=cents<0,absolute=BigInt(negative?-cents:cents);
 return {negative,whole:(absolute/100n).toString(),fraction:(absolute%100n).toString().padStart(2,'0')};
}
export function exactBRLDecimal(cents:number):string{
 const value=parts(cents);
 return (value.negative?'-':'')+value.whole+'.'+value.fraction;
}
export function formatBRL(cents:number):string{
 const value=parts(cents);
 const grouped=value.whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 return (value.negative?'-':'')+'R$ '+grouped+','+value.fraction;
}
/** Excel retains at most 15 significant decimal digits. Higher BRL amounts
 * cannot guarantee both all integer digits and centavos as a numeric cell.
 * Preserve them as an explicit currency string instead of silently rounding.
 * Smaller amounts stay numeric for sorting/aggregation/pivots. */
export function xlsxMoneyCell(cents:number):SheetCell{
 const exact=exactBRLDecimal(cents);
 const candidate=cents/100;
 if(Math.abs(cents)<1_000_000_000_000_000 &&
    Number.isFinite(candidate) && candidate.toFixed(2)===exact){
  return {type:'number',value:candidate,style:2};
 }
 return {type:'text',value:formatBRL(cents),style:0};
}
