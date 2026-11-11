import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReport, isCivilDate, reportURL, ReportDownloadError } from '../src/report.ts';

const filters = { from:'2026-11-01', to:'2026-11-30', asOf:'2026-11-11', status:'all' };
const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.4\nFake test bytes', 'utf8'));
const xlsxBytes = Uint8Array.from([0x50,0x4b,0x03,0x04,0x01,0x02]);
const MIME = {
  pdf:'application/pdf',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function response(format, overrides={}) {
  return new Response(format==='pdf' ? pdfBytes : xlsxBytes,{
    status:200, headers:{'content-type':MIME[format]}, ...overrides,
  });
}
test('report URLs include explicit civil dates, status, account and format; never client identity',()=>{
  const url=reportURL({...filters,status:'overdue',accountId:'11111111-1111-4111-8111-111111111111'},'xlsx');
  const parsed=new URL('https://localhost'+url);
  assert.equal(parsed.pathname,'/api/reports/export');
  for(const [key,value] of Object.entries({
    format:'xlsx',from:'2026-11-01',to:'2026-11-30',asOf:'2026-11-11',
    status:'overdue',accountId:'11111111-1111-4111-8111-111111111111',
  }))assert.equal(parsed.searchParams.get(key),value);
  assert(!parsed.searchParams.has('ownerId'));
  assert(!parsed.searchParams.has('userId'));
  assert(!reportURL(filters,'pdf').includes('accountId'));
  assert.equal(isCivilDate('2026-02-28'),true);
  assert.equal(isCivilDate('2026-02-30'),false);
  assert.equal(isCivilDate('2024-02-29'),true);
  assert.equal(isCivilDate('2026-13-01'),false);
});
test('invalid filters fail locally before network or file generation',()=>{
  for(const bad of [
    {...filters,from:'2026-11-31'},
    {...filters,from:'2026-12-01'},
    {...filters,to:'2026-02-30'},
    {...filters,asOf:'2026-11-00'},
    {...filters,status:'does-not-exist'},
    {...filters,accountId:'../alice'},
  ]) assert.throws(()=>reportURL(bad,'pdf'),ReportDownloadError);
  assert.throws(()=>reportURL(filters,'csv'),ReportDownloadError);
});
test('verified download uses same-origin cookies, never caches, and checks binary signatures',async()=>{
  const requests=[];
  const fake=async (url,opts)=>{
    requests.push({url,opts});
    return response('xlsx');
  };
  const result=await fetchReport(filters,'xlsx',undefined,fake);
  assert.equal(result.filename,'cashcontrol-historico-2026-11-01-a-2026-11-30.xlsx');
  assert.equal(result.blob.size,xlsxBytes.length);
  assert.equal(requests.length,1);
  assert.equal(requests[0].opts.credentials,'same-origin');
  assert.equal(requests[0].opts.cache,'no-store');
  assert.equal(requests[0].opts.redirect,'error');
  assert.equal(requests[0].opts.method,'GET');
  assert(!('body' in requests[0].opts));
  assert.equal((await fetchReport(filters,'pdf',undefined,async()=>response('pdf'))).blob.size,pdfBytes.length);
});
test('reject HTML/JSON or wrong file signatures rather than initiating a misleading download',async()=>{
  await assert.rejects(fetchReport(filters,'pdf',undefined,async()=>new Response('error',{
    status:200,headers:{'content-type':'text/html'},
  })),/formato inesperado/);
  await assert.rejects(fetchReport(filters,'pdf',undefined,async()=>new Response('bad file',{
    status:200,headers:{'content-type':MIME.pdf},
  })),/incompleto/);
  await assert.rejects(fetchReport(filters,'xlsx',undefined,async()=>new Response(pdfBytes,{
    status:200,headers:{'content-type':MIME.xlsx},
  })),/incompleto/);
});
test('failures report actionable reason; all document errors are read-only',async()=>{
  for(const [status,part] of [[400,'Filtros'],[401,'sessão'],[403,'não foi autorizada'],
    [404,'conta'],[409,'valores'],[413,'eventos demais'],[500,'Não foi possível']]){
    await assert.rejects(
      fetchReport(filters,'pdf',undefined,async()=>new Response('{}',{status})),
      error=>error instanceof ReportDownloadError && error.status===status && error.message.includes(part),
    );
  }
});
test('abort prevents download and is not incorrectly converted into a recoverable network failure',async()=>{
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(fetchReport(filters,'pdf',controller.signal,async()=>{
    throw new DOMException('Aborted','AbortError');
  }),error=>error.name==='AbortError');
});
