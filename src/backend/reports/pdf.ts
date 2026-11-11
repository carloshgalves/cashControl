/* Portable PDF 1.4 report for Cloudflare Workers.
 * Standard WinAnsi Helvetica/Helvetica-Bold; generated text is encoded as
 * hex-string operands, never executable PDF content or hyperlinks.
 * Portuguese accents are preserved with WinAnsi; unknown glyphs become '?'.
 * XLSX retains complete Unicode strings for records not representable here.
 */
const winAnsi=new Map<number,number>([
 [0x20ac,0x80],[0x201a,0x82],[0x0192,0x83],[0x201e,0x84],
 [0x2026,0x85],[0x2020,0x86],[0x2021,0x87],[0x02c6,0x88],
 [0x2030,0x89],[0x0160,0x8a],[0x2039,0x8b],[0x0152,0x8c],
 [0x017d,0x8e],[0x2018,0x91],[0x2019,0x92],[0x201c,0x93],
 [0x201d,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],
 [0x02dc,0x98],[0x2122,0x99],[0x0161,0x9a],[0x203a,0x9b],
 [0x0153,0x9c],[0x017e,0x9e],[0x0178,0x9f],
]);
// A standard PDF font cannot render every Unicode glyph. Preserve unknown
// code points visibly rather than silently turning names into '?' characters.
// Complete Unicode values remain intact in the companion XLSX export.
function pdfSafe(input:string):string{
 let out='';
 for(const char of input.normalize('NFC')){
  const cp=char.codePointAt(0)!;
  if((cp>=32&&cp<=126)||(cp>=160&&cp<=255)||winAnsi.has(cp))out+=char;
  else if(cp<=32||cp===0x7f)out+=' ';
  else out+='[U+'+cp.toString(16).toUpperCase().padStart(4,'0')+']';
 }
 return out;
}
function hexText(text:string):string{
 let hex='';
 for(const char of pdfSafe(text)){
  const cp=char.codePointAt(0)!;
  const byte=(cp>=32&&cp<=126)||(cp>=160&&cp<=255)?cp:winAnsi.get(cp)??32;
  hex+=byte.toString(16).padStart(2,'0').toUpperCase();
 }
 return '<'+hex+'>';
}
function textLine(text:string,x:number,y:number,size=10,bold=false,color='0.15 0.22 0.19'):string{
 return 'BT /'+(bold?'F2':'F1')+' '+size+' Tf '+color+' rg 1 0 0 1 '+
  x+' '+y+' Tm '+hexText(text)+' Tj ET\n';
}
const money=(c:number)=>'R$ '+(c/100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=(c:number)=>c<0?'-'+money(-c):money(c);
function wrap(value:string,width:number,font=9):string[]{
 const max=Math.max(8,Math.floor(width/(font*.55)));
 const pieces=Array.from(value);
 const lines:string[]=[];
 for(let i=0;i<pieces.length;i+=max)lines.push(pieces.slice(i,i+max).join(''));
 return lines.length?lines:[''];
}
export interface PdfRow {
 date:string;kind:string;title:string;status:string;account:string;amountCents:number;
}
export interface PdfReport {
 from:string;to:string;asOf:string;scope:string;status:string;
 rows:PdfRow[];
 totals: {
  incomeCents:number;expensesCents:number;refundsCents:number;
  transfersCents:number;outstandingCents:number;netCents:number;
 };
}
/* Every inserted object and stream is ASCII-only; offsets are byte-exact. */
export function createPdf(report:PdfReport):Uint8Array {
 if(report.rows.length>2000)throw new RangeError('PDF row cap exceeded');
 const pages:string[]=[];
 const begin=():string=>{
  let out='0.982 0.99 0.973 rg 0 0 842 595 re f\n';
  out+='0.078 0.36 0.285 rg 0 528 842 67 re f\n';
  out+=textLine('cashControl  /  Relatório financeiro',35,557,21,true,'1 1 1');
  out+=textLine('Período: '+report.from+' a '+report.to+'    Referência: '+report.asOf,38,506,10,true);
  out+=textLine('Escopo: '+report.scope+'    Estado: '+report.status,38,491,9);
  out+=textLine('Valores realizados e pendências são categorias distintas. Transferências não são renda.',38,476,9);
  out+='0.89 0.92 0.88 rg 35 408 772 57 re f\n';
  const totals=[
   ['Entradas',report.totals.incomeCents],['Saídas',report.totals.expensesCents],
   ['Reembolsos',report.totals.refundsCents],['Transferências próprias',report.totals.transfersCents],
   ['Obrigações pendentes',report.totals.outstandingCents],['Fluxo líquido',report.totals.netCents],
  ];
  totals.forEach(([label,value],i)=>{
   const x=45+(i%3)*252,y=i<3?443:420;
   out+=textLine(String(label)+': '+signed(Number(value)),x,y,9,i===5);
  });
  out+='0.078 0.36 0.285 rg 35 380 772 23 re f\n';
  const labels=[['Data',42],['Tipo',125],['Descrição',232],['Situação',496],['Conta',596],['Valor (R$)',717]];
  for(const [label,x]of labels)out+=textLine(String(label),Number(x),386,9,true,'1 1 1');
  return out;
 };
 let current=begin(),y=361,count=0;
 for(const row of report.rows){
  // Widths are PDF points, not character counts; preserve readable titles.
  const lines=wrap(pdfSafe(row.title),251,9);
  const accountLines=wrap(pdfSafe(row.account),101,8);
  const height=Math.max(26,Math.max(lines.length,accountLines.length)*11+7);
  if(y-height<55){
   pages.push(current);current=begin();y=361;count=0;
  }
  if(count++%2===0)current+='0.96 0.975 0.951 rg 35 '+(y-height+3)+' 772 '+height+' re f\n';
  current+=textLine(row.date,42,y-8,9);
  current+=textLine(row.kind.slice(0,20),125,y-8,8.5);
  for(let i=0;i<lines.length;i++)current+=textLine(lines[i]!,232,y-8-i*11,9);
  current+=textLine(row.status.slice(0,17),496,y-8,8.5);
  for(let i=0;i<accountLines.length;i++)current+=textLine(accountLines[i]!,596,y-8-i*11,8);
  current+=textLine(signed(row.amountCents),717,y-8,9,true);
  y-=height;
 }
 if(report.rows.length===0)current+=textLine('Sem eventos para o período e filtro selecionados.',43,340,11);
 pages.push(current);
 if(pages.length>450)throw new RangeError('PDF page limit exceeded');
 const objects:string[]=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '', // pages object, populated after all page references
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
 ];
 const kids:number[]=[];
 pages.forEach((body,i)=>{
  const content=body+textLine('Página '+(i+1)+' de '+pages.length+'  |  Relatório privado gerado sob sessão autenticada.',38,26,8);
  const contentRef=objects.length+1;
  objects.push('<< /Length '+new TextEncoder().encode(content).length+' >>\nstream\n'+content+'endstream');
  const pageRef=objects.length+1;
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '+contentRef+' 0 R >>');
  kids.push(pageRef);
 });
 objects[1]='<< /Type /Pages /Count '+kids.length+' /Kids ['+kids.map(x=>x+' 0 R').join(' ')+'] >>';
 let pdf='%PDF-1.4\n';const offsets=[0];
 for(let i=0;i<objects.length;i++){
  offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';
 }
 const start=pdf.length;
 pdf+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
 for(const offset of offsets.slice(1))pdf+=String(offset).padStart(10,'0')+' 00000 n \n';
 pdf+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';
 return new TextEncoder().encode(pdf);
}
