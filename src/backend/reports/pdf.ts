/* Self-contained PDF 1.4 writer for Workers: Helvetica/Helvetica-Bold, WinAnsi.
 * PDF text is emitted as hexadecimal byte strings, never interpreted as code.
 * Column wrapping uses the standard Helvetica AFM glyph widths (1/1000 em)
 * for ASCII; all other mapped WinAnsi glyphs receive a conservative >=1.015 em
 * reservation so that no character can intrude into the next column.
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
// Widths for codes 32..126, from Adobe standard Helvetica font metrics.
const helvetica=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const helveticaBold=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
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
function textWidthSafe(text:string,size:number,bold=false):number{
 const metrics=bold?helveticaBold:helvetica;
 let units=0;
 for(const char of text){
  const cp=char.codePointAt(0)!;
  units+=cp>=32&&cp<=126?metrics[cp-32]!:1015;
 }
 return units*size/1000;
}
function wrapSafe(value:string,maxWidth:number,size:number,bold=false):string[]{
 if(!Number.isFinite(maxWidth)||maxWidth<20)throw new RangeError('Invalid PDF width');
 const input=pdfSafe(value),out:string[]=[];
 let line='',width=0;
 const flush=()=>{if(line.trim())out.push(line.trimEnd());line='';width=0;};
 for(const char of input){
  const cp=char.codePointAt(0)!;
  const metrics=bold?helveticaBold:helvetica;
  const glyphWidth=(cp>=32&&cp<=126?metrics[cp-32]!:1015)*size/1000;
  if(width+glyphWidth<=maxWidth+0.001){line+=char;width+=glyphWidth;continue;}
  const lastSpace=line.lastIndexOf(' ');
  if(lastSpace>0){
   out.push(line.slice(0,lastSpace).trimEnd());
   line=(line.slice(lastSpace+1)+char).trimStart();
   width=textWidthSafe(line,size,bold);
  }else{
   flush();
   if(char!==' '){line=char;width=glyphWidth;}
  }
  // A single PDF glyph cannot exceed the smallest supported column; this
  // assertion also makes accidental future font changes fail closed.
  if(width>maxWidth+0.001)throw new RangeError('PDF glyph exceeds cell width');
 }
 flush();
 return out.length?out:[''];
}
function hexText(safeText:string):string{
 let hex='';
 for(const char of safeText){
  const cp=char.codePointAt(0)!;
  const byte=(cp>=32&&cp<=126)||(cp>=160&&cp<=255)?cp:winAnsi.get(cp)??32;
  hex+=byte.toString(16).padStart(2,'0').toUpperCase();
 }
 return '<'+hex+'>';
}
function textLine(safeText:string,x:number,y:number,size=10,bold=false,color='0.15 0.22 0.19'):string{
 return 'BT /'+(bold?'F2':'F1')+' '+size+' Tf '+color+' rg 1 0 0 1 '+
  x+' '+y+' Tm '+hexText(safeText)+' Tj ET\n';
}
const money=(c:number)=>'R$ '+(c/100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=(c:number)=>c<0?'-'+money(-c):money(c);
export interface PdfRow {
 date:string;kind:string;title:string;status:string;account:string;amountCents:number;
}
export interface PdfReport {
 from:string;to:string;asOf:string;scope:string;status:string;
 rows:PdfRow[];
 totals:{
  incomeCents:number;expensesCents:number;refundsCents:number;
  transfersCents:number;outstandingCents:number;netCents:number;
 };
}
const LEFT=35, RIGHT=807, PAGE_MIN_Y=55;
const columns=[
 {x:42,width:72,size:9,bold:false,label:'Data'},
 {x:121,width:88,size:8.5,bold:false,label:'Tipo'},
 {x:216,width:238,size:9,bold:false,label:'Descrição'},
 {x:461,width:81,size:8.5,bold:false,label:'Situação'},
 {x:549,width:128,size:8,bold:false,label:'Conta'},
 {x:683,width:124,size:8.5,bold:true,label:'Valor (R$)'},
] as const;
const MAX_PDF_PAGES=450;
export function createPdf(report:PdfReport):Uint8Array{
 if(report.rows.length>2000)throw new RangeError('PDF row cap exceeded');
 function begin():{content:string;firstRowY:number}{
  let content='0.982 0.99 0.973 rg 0 0 842 595 re f\n';
  content+='0.078 0.36 0.285 rg 0 528 842 67 re f\n';
  content+=textLine('cashControl  /  Relatório financeiro',35,557,21,true,'1 1 1');
  const meta=[
   {value:'Período: '+report.from+' a '+report.to+'    Referência: '+report.asOf,size:10,bold:true},
   {value:'Escopo: '+report.scope+'    Situação: '+report.status,size:9,bold:false},
   {value:'Valores realizados e pendências são categorias distintas. Transferências não são renda.',size:9,bold:false},
  ];
  let metaY=511;
  for(const item of meta){
   for(const part of wrapSafe(item.value,RIGHT-38,item.size,item.bold)){
    content+=textLine(part,38,metaY,item.size,item.bold);metaY-=12;
   }
  }
  const summaryBottom=metaY-10-57;
  if(summaryBottom<315)throw new RangeError('PDF header too tall');
  content+='0.89 0.92 0.88 rg 35 '+summaryBottom+' 772 57 re f\n';
  const totals=[
   ['Entradas',report.totals.incomeCents],['Saídas',report.totals.expensesCents],
   ['Reembolsos',report.totals.refundsCents],['Transferências próprias',report.totals.transfersCents],
   ['Obrigações pendentes',report.totals.outstandingCents],['Fluxo líquido',report.totals.netCents],
  ] as const;
  totals.forEach(([label,value],i)=>{
   const x=45+(i%3)*252,y=summaryBottom+(i<3?40:17);
   const formatted=String(label)+': '+signed(value);
   const parts=wrapSafe(formatted,242,8.5,i===5);
   // Each summary slot is one line high: fail visibly rather than overlap.
   if(parts.length!==1)throw new RangeError('PDF total exceeds summary cell');
   content+=textLine(parts[0]!,x,y,8.5,i===5);
  });
  const headerBottom=summaryBottom-34;
  content+='0.078 0.36 0.285 rg 35 '+headerBottom+' 772 23 re f\n';
  for(const col of columns)content+=textLine(col.label,col.x,headerBottom+7,9,true,'1 1 1');
  return {content,firstRowY:headerBottom-15};
 }
 const pages:string[]=[];
 let {content:current,firstRowY:y}=begin(),rowIndex=0;
 function nextPage():void{
  pages.push(current);
  if(pages.length>=MAX_PDF_PAGES)throw new RangeError('PDF page limit exceeded');
  const next=begin();current=next.content;y=next.firstRowY;
 }
 for(const row of report.rows){
  const fields=[row.date,row.kind,row.title,row.status,row.account,signed(row.amountCents)];
  const lines=fields.map((value,i)=>wrapSafe(value,columns[i]!.width,columns[i]!.size,columns[i]!.bold));
  const totalLines=Math.max(...lines.map(x=>x.length));
  let start=0;
  while(start<totalLines){
   if(y-26<PAGE_MIN_Y){nextPage();continue;}
   const capacity=Math.floor((y-PAGE_MIN_Y-7)/11);
   if(capacity<1){nextPage();continue;}
   const take=Math.min(totalLines-start,capacity),height=Math.max(26,take*11+7);
   if(y-height<PAGE_MIN_Y){nextPage();continue;}
   if(rowIndex++%2===0)current+='0.96 0.975 0.951 rg 35 '+(y-height+3)+' 772 '+height+' re f\n';
   columns.forEach((col,i)=>{
    // Only the descriptive fields continue onto further pages; never repeat a
    // monetary amount as if another event had occurred.
    if(start>0&&(i===0||i===1||i===3||i===5))return;
    for(let j=0;j<take;j++){
     const part=lines[i]![start+j];
     if(part!==undefined)current+=textLine(part,col.x,y-8-j*11,col.size,col.bold);
    }
   });
   start+=take;y-=height;
  }
 }
 if(report.rows.length===0)current+=textLine('Sem eventos para o período e filtro selecionados.',43,y-8,11);
 pages.push(current);
 if(pages.length>MAX_PDF_PAGES)throw new RangeError('PDF page limit exceeded');
 const objects:string[]=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '',
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
