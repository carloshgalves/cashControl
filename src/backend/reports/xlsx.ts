/* Standard OOXML XLSX writer for Cloudflare Workers; no Buffer, Node or macros.
 * Every user cell is inlineStr (never a formula) to prevent CSV/Excel injection.
 */
const enc=(s:string)=>new TextEncoder().encode(s);
const xml=(s:string):string=>s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,' ')
 .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function wr16(b:Uint8Array,p:number,n:number){b[p]=n&255;b[p+1]=(n>>>8)&255;}
function wr32(b:Uint8Array,p:number,n:number){b[p]=n&255;b[p+1]=(n>>>8)&255;b[p+2]=(n>>>16)&255;b[p+3]=(n>>>24)&255;}
const crcTable=new Uint32Array(256);
for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[i]=c>>>0;}
function crc32(b:Uint8Array):number{let c=0xffffffff;for(const n of b)c=crcTable[(c^n)&255]!^(c>>>8);return(c^0xffffffff)>>>0;}
function join(chunks:Uint8Array[]):Uint8Array{
 const size=chunks.reduce((n,b)=>n+b.length,0),out=new Uint8Array(size);let pos=0;
 for(const b of chunks){out.set(b,pos);pos+=b.length;}return out;
}
export function zip(files:Array<{name:string,data:string}>):Uint8Array{
 const local:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
 for(const file of files){
  if(!/^[A-Za-z0-9_\[\].\/-]+$/.test(file.name)||file.name.includes('..'))throw new TypeError('Unsafe name');
  const name=enc(file.name),body=enc(file.data),crc=crc32(body);
  const header=new Uint8Array(30+name.length);
  wr32(header,0,0x04034b50);wr16(header,4,20);wr16(header,6,0x800);
  wr16(header,12,0x0021); // 1980-01-01, earliest valid ZIP DOS timestamp
  wr32(header,14,crc);wr32(header,18,body.length);wr32(header,22,body.length);wr16(header,26,name.length);
  header.set(name,30);local.push(header,body);
  const centralHeader=new Uint8Array(46+name.length);
  wr32(centralHeader,0,0x02014b50);wr16(centralHeader,4,20);wr16(centralHeader,6,20);
  wr16(centralHeader,8,0x800);wr16(centralHeader,14,0x0021);wr32(centralHeader,16,crc);
  wr32(centralHeader,20,body.length);wr32(centralHeader,24,body.length);
  wr16(centralHeader,28,name.length);wr32(centralHeader,42,offset);
  centralHeader.set(name,46);central.push(centralHeader);offset+=header.length+body.length;
 }
 const index=join(central),end=new Uint8Array(22);
 wr32(end,0,0x06054b50);wr16(end,8,files.length);wr16(end,10,files.length);
 wr32(end,12,index.length);wr32(end,16,offset);
 return join([...local,index,end]);
}
export type SheetCell={type:'text',value:string,style?:number}|{type:'number',value:number,style?:number};
export interface ReportTable {name:string;rows:SheetCell[][];columnWidths:number[]}
function column(index:number){let s='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function sheetXml(t:ReportTable):string{
 const rows=t.rows.map((row,i)=>'<row r="'+(i+1)+'">'+row.map((cell,j)=>{
  const ref=column(j)+(i+1);
  if(cell.type==='number'){
   if(!Number.isFinite(cell.value)||Math.abs(cell.value)>Number.MAX_SAFE_INTEGER)throw new RangeError('Unsafe numeric cell');
   return '<c r="'+ref+'" s="'+(cell.style??2)+'"><v>'+cell.value+'</v></c>';
  }
  return '<c r="'+ref+'" t="inlineStr" s="'+(cell.style??0)+'"><is><t xml:space="preserve">'+xml(cell.value)+'</t></is></c>';
 }).join('')+'</row>').join('');
 const cols=t.columnWidths.map((w,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.max(10,Math.min(55,w))+'" customWidth="1"/>').join('');
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
  '<sheetViews><sheetView workbookViewId="0"><pane ySplit="7" topLeftCell="A8" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
  '<cols>'+cols+'</cols><sheetData>'+rows+'</sheetData>'+
  '<pageMargins left=".3" right=".3" top=".5" bottom=".5" header=".2" footer=".2"/></worksheet>';
}
export function createXlsx(table:ReportTable):Uint8Array{
 if(table.rows.length<6||table.rows.length>2100||table.columnWidths.length>26||
  table.rows.some(r=>r.length>26)||table.name.length>31)throw new RangeError('Invalid dimensions');
 const prefix='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const styles=prefix+'<styleSheet xmlns="'+ns+'">'+
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00;[Red](&quot;R$&quot; #,##0.00)"/></numFmts>'+
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'+
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF145C49"/><bgColor indexed="64"/></patternFill></fill></fills>'+
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
  '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'+
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
 const files=[
  {name:'[Content_Types].xml',data:prefix+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
   '<Default Extension="xml" ContentType="application/xml"/>'+
   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'},
  {name:'_rels/.rels',data:prefix+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
  {name:'xl/workbook.xml',data:prefix+'<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
   '<sheets><sheet name="'+xml(table.name)+'" sheetId="1" r:id="rId1"/></sheets></workbook>'},
  {name:'xl/_rels/workbook.xml.rels',data:prefix+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
   '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
  {name:'xl/styles.xml',data:styles},
  {name:'xl/worksheets/sheet1.xml',data:sheetXml(table)},
 ];
 return zip(files);
}
