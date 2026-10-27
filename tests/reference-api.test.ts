import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';import {createApp} from '../server/app.js';import {styledReference} from './reference-fixtures.js';import {testDirectory} from './fixtures.js';
import {courseConfig} from '../shared/course.js';import {unitConfig} from '../shared/units.js';import {questionKey,type Assignment,type Config,type State} from '../shared/domain.js';import type {AiBatch,AiCall} from '../shared/ai.js';import type {Fetch} from '../server/ai/transport.js';
import {renderPdf,hash} from '../server/ai/pdf.js';import {join} from 'node:path';import {writeFileSync} from 'node:fs';

async function harness(fetcher:Fetch){
  const dir=testDirectory('reference-api-'),runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only',DASHSCOPE_API_KEY:'fixture-only'},fetcher});runtime.app.use(runtime.errorHandler);
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api';
  async function request<T>(path:string,body?:unknown,status=200,method=body?'POST':'GET'):Promise<T>{const form=body instanceof FormData,r=await fetch(base+path,{method,headers:body&&!form?{'content-type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data as T;}
  const course=await request<{id:string}>('/courses',{name:'Synthetic reference course'},201);let assignment=await request<Assignment>('/assignments',{courseId:course.id,title:'Synthetic reference assignment',scope:'3.3',description:'',config:courseConfig()},201);
  const bytes=await styledReference();const form=new FormData();form.append('kind','reference');form.append('file',new Blob([new Uint8Array(bytes)]),'synthetic-reference.pdf');const file=await request<{id:string}>('/assignments/'+assignment.id+'/files',form,201);
  const parsed=await request<{config:Config;warnings:string[]}>('/assignments/'+assignment.id+'/prepare',{scope:'3.3',strategy:'auto'});
  const config={...parsed.config,confirmed:true,questions:parsed.config.questions.map(q=>({...q,children:q.children?.map(c=>({...c,confirmed:true}))}))};
  assignment=await request<Assignment>('/assignments/'+assignment.id,{...assignment,config},200,'PUT');
  const close=async()=>{await new Promise<void>(r=>server.close(()=>r()));runtime.close();};return {runtime,request,assignment,file,bytes,dir,close};
}
function response(content:unknown){return Response.json({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}],usage:{prompt_tokens:5000,completion_tokens:500}});}

test('手工调整参考页并保存后，两服务实际请求包含新关联和正确图像字节且不重复加图',async()=>{
  const bodies:Record<string,any>[]=[];let config:Config;
  const h=await harness(async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return response({rows:unitConfig(config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}))});});
  try{
    assert.equal(bodies.length,0,'上传与确定性整理不得发模型请求');
    const edited=h.assignment.config.questions.map(q=>q.number==='32'?{...q,referenceSources:[...(q.referenceSources??[]),{fileId:h.file.id,page:2,graphic:false}]}:q);
    const saved=await h.request<Assignment>('/assignments/'+h.assignment.id,{...h.assignment,config:{...h.assignment.config,questions:edited}},200,'PUT');config=saved.config;
    assert.equal((await h.request<State>('/state')).assignments[0].config.questions.find(q=>q.number==='32')!.referenceSources!.length,2);
    const receipts:unknown[]=[];
    const pdf=await PDFDocument.create();pdf.addPage([300,400]).drawText('Synthetic student',{x:20,y:300});const form=new FormData();form.append('kind','student');form.append('file',new Blob([new Uint8Array(await pdf.save())]),'Synthetic.pdf');await h.request('/assignments/'+h.assignment.id+'/files',form,201);
    const s=(await h.request<State>('/state')).submissions[0];
    const expected=await renderPdf(h.bytes,join(h.dir,'ai-cache'),undefined,{maxEdge:4096});
    for(const provider of ['deepseek','qwen']){
      const options={ids:[s.id],provider,consent:true,deidentified:true,unitsConfirmed:true,warningAcknowledged:true,regrade:provider==='qwen',perSubmissionBudget:.5,totalBudget:2};const path='/assignments/'+h.assignment.id+'/ai';const quote=await h.request<{previewToken:string}>(path+'/preview',options);await h.request(path+'/queue',{...options,...quote});
      for(let i=0;i<300;i++){if(h.runtime.store.all<AiBatch>('ai_batches').at(-1)?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(h.runtime.store.all<AiBatch>('ai_batches').at(-1)?.items[0].state,'completed');const body=bodies.at(-1)!;const refs=body.messages[1].content.filter((p:any)=>p.type==='image_url');assert.equal(refs.length,2);assert.equal(body.messages[2].content.filter((p:any)=>p.type==='image_url').length,1);assert.ok(body.messages[1].content.some((p:any)=>p.text?.includes('关联题目')&&p.text.includes('3.3 / 32')));assert.equal(hash(Buffer.from(refs[0].image_url.url.split(',')[1],'base64')),expected[0].hash);assert.ok(JSON.stringify(body).includes('补充题1'));assert.ok(JSON.stringify(body).includes('Reference beta'));
      assert.ok(body.messages[1].content.some((p:any)=>p.text?.includes('原第 2 页')&&p.text.includes('3.3 / 32')),'手工新增的第2页必须标明用于32题');
      assert.equal(hash(Buffer.from(refs[1].image_url.url.split(',')[1],'base64')),expected[1].hash);
      receipts.push({provider,referenceImages:refs.length,manualPage:2,linkedQuestion:'3.3 / 32',imageHash:expected[1].hash});
    }
    writeFileSync(join(h.dir,'manual-reference-evidence.json'),JSON.stringify({externalCalls:0,receipts},null,2));
    assert.equal(bodies.length,2);const previous=h.runtime.store.all<AiCall>('ai_calls');assert.ok(previous.every(c=>c.diagnostic?.inputImages===3));
    h.runtime.store.delete('files',h.file.id);await h.request('/assignments/'+h.assignment.id+'/ai/preview',{ids:[s.id],provider:'deepseek',consent:true,deidentified:true,unitsConfirmed:true,regrade:true},400);assert.equal(bodies.length,2);assert.deepEqual(h.runtime.store.all('ai_calls'),previous);
  }finally{await h.close();}
});
test('按需辅助解析须显式授权和有效预估，预算/失效拦截，失败保留用量且不改题目或自动重试',async()=>{
  let calls=0,malformed=false;const h=await harness(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.messages.length,2);assert.equal(body.messages[1].content.filter((p:any)=>p.type==='image_url').length,1);return response(malformed?{invalid:true}:{questions:[{section:'3.3',number:'补充题1',prompt:'Synthetic candidate',answer:'Candidate answer',kind:'solution',children:[],sources:[{page:2,graphic:true}]}]});});
  try{
    const before=h.runtime.store.get('assignments',h.assignment.id);const options={fileId:h.file.id,pages:[2],provider:'deepseek',scope:'3.3',expectedVersion:h.assignment.version,consent:true,deidentified:true,perSubmissionBudget:.5,totalBudget:2};const path='/assignments/'+h.assignment.id+'/reference-ai';
    await h.request(path+'/preview',{...options,consent:false},400);await h.request(path+'/parse',options,400);assert.equal(calls,0);
    const quote=await h.request<{previewToken:string;estimatedCny:number}>(path+'/preview',options);assert.ok(quote.estimatedCny>0);assert.equal(calls,0);
    await h.request(path+'/parse',{...quote,...options,pages:[1]},400);assert.equal(calls,0);
    const tiny={...options,perSubmissionBudget:.00001};const tinyQuote=await h.request(path+'/preview',tiny);await h.request(path+'/parse',{...tiny,...tinyQuote as object},400);assert.equal(calls,0);
    const candidate=await h.request<{config:Config}>(path+'/parse',{...options,...quote});assert.equal(candidate.config.questions[0].number,'补充题1');assert.equal(calls,1);assert.deepEqual(h.runtime.store.get('assignments',h.assignment.id),before);const ledger=h.runtime.store.all<AiCall>('ai_calls');assert.equal(ledger[0].purpose,'reference_parse');assert.ok(ledger[0].estimatedCny!>0);
    malformed=true;await h.request(path+'/parse',{...options,...quote},400);assert.equal(calls,2);assert.deepEqual(h.runtime.store.get('assignments',h.assignment.id),before);const failed=h.runtime.store.all<AiCall>('ai_calls').at(-1)!;assert.equal(failed.status,'failed');assert.equal(failed.diagnostic?.validation,'rejected');assert.ok(failed.estimatedCny!>0);assert.deepEqual(h.runtime.store.get('ai_calls',ledger[0].id),ledger[0]);
  }finally{await h.close();}
});
test('保存参考页在服务端验证文件归属与页码，失败时配置和账本不改变',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;throw Error('must not call');});
  try{const before=h.runtime.store.get('assignments',h.assignment.id);for(const source of [{fileId:'not-in-assignment',page:1,graphic:true},{fileId:h.file.id,page:99,graphic:true}]){
    await h.request('/assignments/'+h.assignment.id,{...h.assignment,config:{...h.assignment.config,questions:h.assignment.config.questions.map((q,i)=>i? q:{...q,referenceSources:[source]})}},400,'PUT');assert.deepEqual(h.runtime.store.get('assignments',h.assignment.id),before);
  }const parsed=await h.request<{materialCounts:{fileId:string;questions:number}[]}>('/assignments/'+h.assignment.id+'/prepare',{scope:'3.3'});assert.deepEqual(parsed.materialCounts,[{fileId:h.file.id,name:'synthetic-reference.pdf',questions:7}]);assert.equal(calls,0);assert.deepEqual(h.runtime.store.all('ai_calls'),[]);}finally{await h.close();}
});
