import {testDirectory} from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {courseConfig} from '../shared/course.js';
import {blankQuestion,questionKey,type Assignment,type State,type Submission} from '../shared/domain.js';
import {unitConfig} from '../shared/units.js';
import type {AiBatch,AiCall} from '../shared/ai.js';
import type {AiDependencies} from '../server/ai/service.js';

async function harness(deps:AiDependencies){
  const dir=testDirectory('stage2-api-');
  const runtime=createApp(dir,deps);runtime.app.use(runtime.errorHandler);
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api';
  async function request<T>(path:string,body?:unknown,method=body?'POST':'GET',status=200):Promise<T>{
    if(path.endsWith('/ai/queue')&&status===200&&body&&typeof body==='object'&&!('previewToken'in body)){
      const quote=await request<{previewToken:string}>(path.replace('/queue','/preview'),body);
      body={...body,previewToken:quote.previewToken};
    }
    const form=body instanceof FormData;
    const response=await fetch(base+path,{method,headers:body&&!form?{'Content-Type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined});
    const data:unknown=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data as T;
  }
  const close=async()=>{await new Promise<void>(r=>server.close(()=>r()));runtime.close();};
  const course=await request<{id:string}>('/courses',{name:'合成课程'},'POST',201);
  const config={...courseConfig([
    {...blankQuestion(),number:'7'},
    {...blankQuestion(),number:'34',kind:'true_false',subparts:['a','b']},
    {...blankQuestion(),section:'1.2',number:'26',kind:'solution',subparts:['a','b']},
  ]),confirmed:true};
  const a=await request<Assignment>('/assignments',{courseId:course.id,title:'合成多小节',description:'',scope:'1.1-1.2',config},'POST',201);
  async function upload(kind:'student'|'reference',name:string,pages:number,size:[number,number]=[250,350]){
    const pdf=await PDFDocument.create();for(let i=0;i<pages;i++)pdf.addPage(size).drawText('Synthetic '+kind+' '+i,{x:20,y:300});
    const form=new FormData();form.append('kind',kind);form.append('file',new Blob([new Uint8Array(await pdf.save())]),name);
    await request('/assignments/'+a.id+'/files',form,'POST',201);
  }
  await upload('reference','reference.pdf',1);
  await upload('student','PrivateFixtureName-2600010000.pdf',7);
  const state=await request<State>('/state');const s=state.submissions[0];
  const options={ids:[s.id],provider:'deepseek' as const,consent:true as const,deidentified:true as const,unitsConfirmed:true as const,perSubmissionBudget:.5,totalBudget:2,warningAcknowledged:true,regrade:false};
  async function wait(){
    for(let n=0;n<200;n++){const b=runtime.store.all<AiBatch>('ai_batches').at(-1);if(b&&b.status==='completed')return b;await new Promise(r=>setTimeout(r,25));}throw new Error('模拟队列超时');
  }
  return {runtime,request,close,a,s,options,wait,dir,upload};
}
const env={AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential',DASHSCOPE_API_KEY:'fixture-credential',AI_MAX_OUTPUT_TOKENS:'8192'};

test('2.4 五人批次两份额度耗尽：较大额度先预估并绑定，单项恢复保留成功结果与原费用',async()=>{
  const seen:{id:string;limit:number}[]=[];const failIds=new Set<string>();
  const h=await harness({env:{...env,AI_MAX_OUTPUT_TOKENS:undefined},fetcher:async(_u,init)=>{
    const body=JSON.parse(String(init?.body));const id=body.messages[2].content[0].text.match(/当前随机提交标识 ([a-f0-9-]+)/)[1];seen.push({id,limit:body.max_tokens});
    if(failIds.has(id)&&body.max_tokens===8192)return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'synthetic private reasoning'},finish_reason:'length'}],usage:{prompt_tokens:5000,completion_tokens:8192}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}));return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows})},finish_reason:'stop'}],usage:{prompt_tokens:5000,completion_tokens:body.max_tokens===8192?6000:9000}});
  }});
  try{
    for(let i=1;i<=4;i++)await h.upload('student','Synthetic'+i+'.pdf',1,i===4?[816,1922.702]:[250,350]);
    const ids=(await h.request<State>('/state')).submissions.map(s=>s.id);failIds.add(ids[2]);failIds.add(ids[4]);
    const providers=await h.request<{id:string;defaultMaxOutputTokens:number}[]>('/ai/providers');assert.equal(providers.find(p=>p.id==='deepseek')?.defaultMaxOutputTokens,16384);
    const quote=await h.request<{previewToken:string;items:{pages:number;imageCount:number}[];estimatedCny:number;maxOutputTokens:number}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,ids,maxOutputTokens:8192});assert.equal(quote.items[4].pages,1);assert.equal(quote.items[4].imageCount,3);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids,maxOutputTokens:8192,previewToken:quote.previewToken});const batch=await h.wait();assert.deepEqual(batch.items.map(i=>i.state),['completed','completed','failed','completed','failed']);assert.equal(seen.length,5);
    const protectedResults=ids.filter(id=>!failIds.has(id)).map(id=>h.runtime.store.get('submissions',id));const oldCalls=h.runtime.store.all<AiCall>('ai_calls');const bad=oldCalls.find(c=>c.submissionId===ids[4])!;assert.equal(bad.pages,1);assert.equal(bad.diagnostic?.responseCharacters,0);assert.ok(bad.diagnostic!.reasoningCharacters!>0);assert.ok(bad.diagnostic!.inputImages!>bad.pages);assert.ok(!JSON.stringify(oldCalls).includes('synthetic private reasoning'));
    const options={...h.options,ids:[...failIds],regrade:true,maxOutputTokens:16384};const larger=await h.request<{previewToken:string;estimatedCny:number;maxOutputTokens:number}>('/assignments/'+h.a.id+'/ai/preview',options);assert.equal(larger.maxOutputTokens,16384);
    const small=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',{...options,maxOutputTokens:8192});assert.ok(larger.estimatedCny>small.estimatedCny);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,maxOutputTokens:32768,previewToken:larger.previewToken},'POST',400);assert.equal(seen.length,5);
    const overBudget=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',{...options,perSubmissionBudget:.01});await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,perSubmissionBudget:.01,previewToken:overBudget.previewToken},'POST',400);assert.equal(seen.length,5);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,previewToken:larger.previewToken});const recovery=await h.wait();assert.equal(recovery.options.maxOutputTokens,16384);assert.ok(recovery.items.every(i=>i.state==='completed'));assert.deepEqual(seen.slice(5),[...failIds].map(id=>({id,limit:16384})));
    assert.deepEqual(ids.filter(id=>!failIds.has(id)).map(id=>h.runtime.store.get('submissions',id)),protectedResults);for(const c of oldCalls)assert.deepEqual(h.runtime.store.get('ai_calls',c.id),c);
  }finally{await h.close();}
});

test('2.4 旧暂停批次无新额度字段时继续保留8192，不能因新版默认值提高已授权开销',async()=>{
  const limits:number[]=[];const h=await harness({env:{...env,AI_MAX_OUTPUT_TOKENS:undefined},fetcher:async(_u,init)=>{const body=JSON.parse(String(init?.body));limits.push(body.max_tokens);return Response.json({choices:[{message:{content:'{"rows":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}});
  try{h.runtime.store.putAi('ai_batches',{id:'legacy-paused',assignmentId:h.a.id,provider:'deepseek',options:h.options,configVersion:h.a.version,status:'paused',items:[{submissionId:h.s.id,state:'queued',error:''}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} satisfies AiBatch);await h.request('/ai/batches/legacy-paused/control',{action:'resume'});await h.wait();assert.deepEqual(limits,[8192]);}finally{await h.close();}
});

test('2.4 巨幅页放大在本地受限时保留首轮待复核建议；分区数量不能当成合法证据页数',async()=>{
  let calls=0;let invalidPage=false;const h=await harness({env,fetcher:async()=>{
    calls++;const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[invalidPage?2:1],reviewReason:''}));return Response.json({choices:[{message:{content:JSON.stringify({rows,zoomRequests:invalidPage?[]:[{page:1,x:0,y:0,width:1,height:1}]})},finish_reason:'stop'}],usage:{prompt_tokens:2000,completion_tokens:500}});
  }});
  try{await h.upload('student','SyntheticOversized.pdf',1,[500,5000]);const s=(await h.request<State>('/state')).submissions.at(-1)!;const options={...h.options,ids:[s.id]};await h.request('/assignments/'+h.a.id+'/ai/queue',options);const b=await h.wait();assert.equal(b.items[0].state,'completed');assert.equal(calls,1);const saved=h.runtime.store.get<Submission>('submissions',s.id)!;assert.equal(saved.status,'review');assert.ok(saved.review!.every(r=>r.needsReview&&r.reviewReason.includes('放大未完成')));assert.ok(h.runtime.store.all<AiCall>('ai_calls')[0].diagnostic!.inputImages!>1);
    invalidPage=true;await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,regrade:true});const rejected=await h.wait();assert.equal(rejected.items[0].state,'failed');assert.equal(calls,2);assert.equal(h.runtime.store.all<AiCall>('ai_calls').at(-1)!.diagnostic?.stage,'validation');assert.deepEqual(h.runtime.store.get<Submission>('submissions',s.id)!.grade,saved.grade);
  }finally{await h.close();}
});

test('2.3 双人一成功一截断：只重试失败者，成功/已确认记录不变，诊断与费用重启后保留',async()=>{
  const seen:string[]=[];let failed=false;let secondId='';const deps:AiDependencies={env,fetcher:async(_u,init)=>{
    const body=JSON.parse(String(init?.body)) as {model:string;messages:{content:{text?:string}[]}[]};const id=body.messages[2].content[0].text!.match(/当前随机提交标识 ([a-f0-9-]+)/)![1];seen.push(id);
    const truncated=id===secondId&&!failed;if(truncated)failed=true;
    const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}));
    return Response.json({model:body.model,choices:[{message:{content:truncated?'{"rows":[':JSON.stringify({rows})},finish_reason:truncated?'length':'stop'}],usage:{prompt_tokens:16000,completion_tokens:truncated?8191:7167}});
  }};const h=await harness(deps);let stopped=false;
  try{
    await h.upload('student','SyntheticSecond.pdf',1);const ids=(await h.request<State>('/state')).submissions.map(s=>s.id);secondId=ids[1];
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids});const batch=await h.wait();assert.deepEqual(batch.items.map(i=>i.state),['completed','failed']);assert.equal(batch.items[1].failure?.stage,'completion');assert.equal(seen.length,2);
    const a=h.runtime.store.get<Submission>('submissions',ids[0])!;const calls=h.runtime.store.all<AiCall>('ai_calls');const bad=calls.find(c=>c.submissionId===secondId)!;
    assert.equal(bad.error,'output_limit');assert.equal(bad.diagnostic?.finishReason,'length');assert.equal(bad.diagnostic?.httpStatus,200);assert.equal(bad.diagnostic?.maxOutputTokens,8192);assert.equal(bad.outputTokens,8191);assert.ok(bad.estimatedCny!>0);assert.equal(bad.diagnostic?.retryable,false);
    await h.request('/submissions/'+a.id+'/review',{revision:a.revision,rows:a.review!.map(r=>({...r,reviewed:true,needsReview:false})),manualReport:'protected',reportBase:'',confirm:true},'PUT');const confirmed=h.runtime.store.get<Submission>('submissions',a.id)!;
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids:[secondId],regrade:true});await h.wait();assert.deepEqual(seen,[ids[0],secondId,secondId]);assert.deepEqual(h.runtime.store.get<Submission>('submissions',a.id),confirmed);assert.deepEqual(h.runtime.store.get<AiCall>('ai_calls',bad.id),bad);
    const ledger=h.runtime.store.all<AiCall>('ai_calls');await h.close();stopped=true;const reopened=createApp(h.dir,{env:{},fetcher:async()=>{throw new Error('must not auto-call');}});try{assert.deepEqual(reopened.store.all('ai_calls'),ledger);assert.equal(reopened.store.get<Submission>('submissions',secondId)?.grade?.provider,'deepseek');assert.deepEqual(reopened.store.get('submissions',a.id),confirmed);}finally{reopened.close();}
  }finally{if(!stopped)await h.close();}
});

test('2.3 不可盲重试的HTTP/格式/超时分开诊断，unknown usage 保留预留',async()=>{
  let mode:'permission'|'schema'|'timeout'='permission';let calls=0;
  const h=await harness({env:{...env,AI_TIMEOUT_MS:'100'},fetcher:async(_u,init)=>{
    calls++;if(mode==='permission')return new Response('',{status:403});if(mode==='timeout')return await new Promise<Response>((_r,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('fixture secret must not persist')),{once:true}));
    return Response.json({model:'deepseek-flash',choices:[{message:{content:'{"rows":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}});
  }});
  try{for(const current of ['permission','schema','timeout'] as const){mode=current;const before=calls;await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);await h.wait();assert.equal(calls,before+1);const call=h.runtime.store.all<AiCall>('ai_calls').at(-1)!;assert.equal(call.status,'failed');assert.equal(call.diagnostic?.retryable,false);
    if(current==='permission'){assert.equal(call.error,'permission');assert.equal(call.diagnostic?.httpStatus,403);}
    if(current==='schema'){assert.equal(call.diagnostic?.stage,'validation');assert.equal(call.diagnostic?.validation,'rejected');assert.equal(call.outputTokens,5);}
    if(current==='timeout'){assert.equal(call.error,'timeout');assert.equal(call.estimatedCny,null);assert.equal(call.inputTokens,null);assert.ok(call.reservedCny>0);}
  }}finally{await h.close();}
});

test('2.2 状态变更拒绝旧预估，正式结果须明确重批，Mock/失败可继续，确认与缓存保护保留',async()=>{
  let calls=0;const h=await harness({env,fetcher:async(_u,init)=>{
    calls++;const body=JSON.parse(String(init?.body)) as {model:string};
    const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}));
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:200}});
  }});
  try{
    await h.upload('student','SyntheticBeta.pdf',1);await h.upload('student','SyntheticGamma.pdf',1);
    const ids=(await h.request<State>('/state')).submissions.map(s=>s.id);
    await h.request('/assignments/'+h.a.id+'/queue',{ids:ids.slice(1),acknowledged:true,replaceDraft:true});
    await until(()=>ids.slice(1).every(id=>h.runtime.store.get<Submission>('submissions',id)?.status==='review'));
    const quote=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,ids});
    await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);await h.wait();assert.equal(calls,1);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids,previewToken:quote.previewToken},'POST',400);assert.equal(calls,1);
    // Exact current result is a read-only, zero-cost reuse; provider/config changes require explicit regrade.
    const cached=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',h.options);assert.equal(cached.estimatedCny,0);
    await h.request('/assignments/'+h.a.id+'/ai/preview',{...h.options,provider:'qwen'},'POST',400);
    let a=h.runtime.store.get<Submission>('submissions',h.s.id)!;
    const original=structuredClone(a.grade);
    const onlyOthers=await h.request<{previewToken:string;items:{submissionId:string}[]}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,ids:ids.slice(1)});assert.deepEqual(onlyOthers.items.map(i=>i.submissionId),ids.slice(1));
    await h.request('/submissions/'+a.id+'/review',{revision:a.revision,rows:a.review!.map(r=>({...r,reviewed:true,needsReview:false})),manualReport:'',reportBase:'',confirm:true},'PUT');
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,previewToken:quote.previewToken},'POST',400);
    await h.request('/assignments/'+h.a.id+'/ai/preview',{...h.options,regrade:true},'POST',400);assert.equal(calls,1);
    await h.request('/submissions/'+a.id+'/reopen',{});
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,provider:'qwen',regrade:true});await h.wait();assert.equal(calls,2);
    assert.ok(h.runtime.store.all<{snapshot:Submission}>('history').some(v=>JSON.stringify(v.snapshot.grade)===JSON.stringify(original)));
    const failed=h.runtime.store.get<Submission>('submissions',ids[1])!;h.runtime.store.put('submissions',{...failed,status:'failed',error:'synthetic previous failure'});
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids:ids.slice(1),previewToken:onlyOthers.previewToken},'POST',400);assert.equal(calls,2);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids:ids.slice(1)});await h.wait();assert.equal(calls,4);
    a=h.runtime.store.get<Submission>('submissions',h.s.id)!;assert.equal(a.grade!.provider,'qwen');
  }finally{await h.close();}
});
test('五份同名提交只批已选两份：预估绑定ID/版本/预算，未选数据账本不变',async()=>{
  let calls=0;const h=await harness({env,fetcher:async(_u,init)=>{
    calls++;const body=JSON.parse(String(init?.body)) as {model:string};
    const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}));
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:200}});
  }});
  try{
    for(let i=1;i<5;i++)await h.upload('student','SameName-260001000'+i+'.pdf',1);
    const students=(await h.request<State>('/state')).submissions;
    const ids=[students[1].id,students[3].id];const options={...h.options,ids};
    const before=students.filter(s=>!ids.includes(s.id));
    const preview=await h.request<{previewToken:string;configVersion:number;items:{submissionId:string}[]}>('/assignments/'+h.a.id+'/ai/preview',options);
    assert.deepEqual(preview.items.map(i=>i.submissionId),ids);assert.equal(preview.configVersion,h.a.version);assert.equal(calls,0);
    const path='/assignments/'+h.a.id+'/ai/queue';
    await h.request(path,{...options,previewToken:preview.previewToken,ids:[...ids,students[4].id]},'POST',400);
    await h.request(path,{...options,previewToken:preview.previewToken,totalBudget:3},'POST',400);
    await h.request(path,{...options,previewToken:preview.previewToken,expectedVersion:h.a.version+1},'POST',400);
    await h.request(path,{...options,previewToken:preview.previewToken,ids:[ids[0],ids[0]]},'POST',400);
    await h.request(path,{...options,previewToken:preview.previewToken,ids:['foreign-submission']},'POST',400);
    const other=await h.request<Assignment>('/assignments',{courseId:h.a.courseId,title:'其他作业',scope:'',description:'',config:h.a.config},'POST',201);
    h.runtime.store.put('submissions',{...students[4],assignmentId:other.id});
    await h.request('/assignments/'+h.a.id+'/ai/preview',{...options,ids:[students[4].id]},'POST',400);
    h.runtime.store.put('submissions',students[4]);
    const smallBudget={...options,perSubmissionBudget:.00001};
    const smallQuote=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',smallBudget);
    const rejected=await h.request<{error:string}>(path,{...smallBudget,previewToken:smallQuote.previewToken},'POST',400);
    assert.match(rejected.error,/预算/);
    await h.request(path,options,'POST',400); // no preview token cannot authorize a queue
    assert.equal(calls,0);
    await h.request(path,{...options,previewToken:preview.previewToken,expectedVersion:preview.configVersion});await h.wait();
    assert.equal(calls,2);assert.deepEqual(h.runtime.store.all<AiCall>('ai_calls').map(c=>c.submissionId).sort(),[...ids].sort());
    for(const s of before)assert.deepEqual(h.runtime.store.get<Submission>('submissions',s.id),s);
    const stale=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',{...options,ids:[students[4].id]});
    await h.request('/assignments/'+h.a.id,{...h.a,config:{...h.a.config,principles:'新规则'},regradeUnconfirmed:false},'PUT');
    await h.request(path,{...options,ids:[students[4].id],previewToken:stale.previewToken},'POST',400);assert.equal(calls,2);
  }finally{await h.close();}
});
async function until(predicate:()=>boolean){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('等待模拟任务超时');}
test('无Key、未同意、预算拦截均不发请求',async()=>{
  let calls=0;const h=await harness({env:{},fetcher:async()=>{calls++;throw new Error('禁止真实调用');}});
  try{
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,consent:false},'POST',400);
    await h.request('/ai/providers/deepseek/test',{consent:true},'POST',400);
    const status=await h.request<unknown>('/ai/providers');assert.ok(!JSON.stringify(status).includes('fixture-credential'));assert.equal(calls,0);
  }finally{await h.close();}
  const b=await harness({env,fetcher:async()=>{calls++;throw new Error('预算拦截前不应调用');}});
  try{await b.request('/assignments/'+b.a.id+'/ai/queue',{...b.options,perSubmissionBudget:.00001},'POST',400);assert.equal(calls,0);}finally{await b.close();}
});
test('模拟两Provider端到端：全页视觉输入、单元结果、人工报告、缓存和用量持久化',async()=>{
  const seen:{model:string;messages:unknown}[]=[];let count=0;let invalid=false;
  const h=await harness({env,fetcher:async(_url,init)=>{
    count++;const body=JSON.parse(String(init?.body)) as {model:string;messages:{role:string;content:unknown}[]};
    seen.push(body);assert.ok(!JSON.stringify(body).includes('PrivateFixtureName'));assert.ok(!JSON.stringify(body).includes('2600010000'));
    const dynamic=body.messages.at(-1)!.content as {type:string;text?:string}[];
    assert.equal(dynamic.filter(v=>v.type==='image_url').length,7);
    const c=unitConfig(h.a.config);const rows=c.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1,4],reviewReason:''}));
    rows[2]={...rows[2],recognition:'not_found',verdict:'missing',pages:[]};
    rows[3]={...rows[3],verdict:'partial',reason:'只求出了特解，未给齐次解，通解不完整'};
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows:invalid?rows.slice(1):rows})},finish_reason:'stop'}],usage:{prompt_tokens:8000,completion_tokens:2000,prompt_tokens_details:{cached_tokens:2000}}});
  }});
  try{
    await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);await h.wait();
    let s=h.runtime.store.get<Submission>('submissions',h.s.id)!;
    assert.equal(s.grade?.provider,'deepseek');assert.equal(s.grade?.config.questions.length,4);assert.equal(s.grade?.config.policy,'linear-algebra-2');
    assert.equal(s.review![2].deduction,.2);assert.equal(s.review![3].deduction,.1);assert.equal(s.review![2].needsReview,true);
    await h.request('/submissions/'+s.id+'/review',{revision:s.revision,rows:s.review,manualReport:'保留的人工报告',reportBase:'',confirm:false},'PUT');
    const before=count;
    await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);assert.equal(count,before);
    assert.equal(h.runtime.store.get<Submission>('submissions',s.id)!.manualReport,'保留的人工报告');
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,provider:'qwen',regrade:true});await h.wait();
    s=h.runtime.store.get<Submission>('submissions',s.id)!;assert.equal(s.grade!.provider,'qwen');assert.equal(s.manualReport,'保留的人工报告');
    assert.equal(seen[0].model,'deepseek-flash');assert.equal(seen[1].model,'qwen3.7-flash');
    const calls=h.runtime.store.all<AiCall>('ai_calls');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.estimatedCny!==null&&c.cacheHitTokens===2000));
    assert.ok(!JSON.stringify(calls).includes('fixture-credential'));
    invalid=true;
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,provider:'deepseek',regrade:true});await h.wait();
    const preserved=h.runtime.store.get<Submission>('submissions',s.id)!;assert.deepEqual(preserved.grade,s.grade);assert.ok(preserved.error.includes('缺少'));assert.equal(preserved.manualReport,s.manualReport);
    const confirmedRows=s.review!.map(r=>({...r,needsReview:false,reviewed:true,reviewReason:''}));
    await h.request('/submissions/'+s.id+'/review',{revision:preserved.revision,rows:confirmedRows,manualReport:s.manualReport,reportBase:'',confirm:true},'PUT');
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,regrade:true},'POST',400);
  }finally{await h.close();}
});

test('暂停与服务重启不自动重发；续跑仅处理未完成项；重复排队被拒绝',async()=>{
  let count=0;let release=()=>{};const gate=new Promise<void>(r=>release=r);
  const deps:AiDependencies={env,fetcher:async(_u,init)=>{
    count++;if(count===1)await gate;
    const b=JSON.parse(String(init?.body)) as {messages:{content:unknown}[];model:string};
    const first=b.messages[1].content as {type:string;text?:string}[];
    const text=first[0].text!;const rules=JSON.parse(text.slice(text.indexOf('{'))) as {units:{key:string;type:string}[]};
    return Response.json({model:b.model,choices:[{message:{content:JSON.stringify({rows:rules.units.map(q=>({key:q.key,type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}))})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:300}});
  }};
  const h=await harness(deps);let stopped=false;let second:ReturnType<typeof createApp>|undefined;
  try{
    await h.upload('student','SynthSecond-2600010001.pdf',1);
    const ids=(await h.request<State>('/state')).submissions.map(s=>s.id);
    const queued=await h.request<{batchId:string}>('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids});
    await until(()=>count===1);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids},'POST',400);
    await h.request('/ai/batches/'+queued.batchId+'/control',{action:'pause'});release();
    await until(()=>h.runtime.store.get<AiBatch>('ai_batches',queued.batchId)!.items[0].state==='completed');
    assert.equal(count,1);assert.equal(h.runtime.store.get<AiBatch>('ai_batches',queued.batchId)!.status,'paused');
    await h.close();stopped=true;second=createApp(h.dir,deps);assert.equal(count,1);
    second.ai.control(queued.batchId,'resume');
    await until(()=>second!.store.get<AiBatch>('ai_batches',queued.batchId)!.status==='completed');
    assert.equal(count,2);assert.ok(second.store.all<Submission>('submissions').every(s=>s.status==='review'));
  }finally{release();if(!stopped)await h.close();second?.close();}
});

test('限流重试计入同份预算；放大或未知用量不能自动超额',async()=>{
  let count=0;let mode:'rate'|'zoom'|'unknown'='rate';
  const h=await harness({env,fetcher:async(_u,init)=>{
    count++;if(mode==='rate')return new Response('',{status:429});
    if(mode==='unknown')throw new Error('timeout with secret fixture-credential');
    const body=JSON.parse(String(init?.body)) as {model:string;messages:{content:unknown}[]};
    const text=(body.messages[1].content as {text:string}[])[0].text;
    const units=JSON.parse(text.slice(text.indexOf('{'))) as {units:{key:string;type:string}[]};
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows:units.units.map(q=>({key:q.key,type:q.type,recognition:'uncertain',verdict:'uncertain',reason:'',reviewReason:'矩阵小字与红笔重叠',pages:[2,3]})),zoomRequests:[{page:2,x:.1,y:.1,width:.3,height:.3}]})},finish_reason:'stop'}]});
  }});
  try{
    await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);await h.wait();assert.equal(count,2);
    assert.equal(h.runtime.store.all<AiCall>('ai_calls').length,2);
    const prior=count;mode='zoom';
    const preview=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,regrade:true});
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,regrade:true,perSubmissionBudget:preview.estimatedCny+.000001});await h.wait();
    assert.equal(count,prior+1);
    const partial=h.runtime.store.get<Submission>('submissions',h.s.id)!;assert.ok(partial.grade);assert.equal(partial.status,'review');
    assert.ok(partial.review!.every(r=>r.needsReview&&r.reviewReason?.includes('放大未完成')));
    mode='unknown';const before=count;
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...h.options,regrade:true});await h.wait();
    assert.equal(count,before+1);const ledger=h.runtime.store.all<AiCall>('ai_calls').at(-1)!;
    assert.equal(ledger.inputTokens,null);assert.equal(ledger.estimatedCny,null);assert.ok(ledger.reservedCny>0);
    assert.ok(!JSON.stringify(h.runtime.store.all('ai_calls')).includes('fixture-credential'));
    assert.deepEqual(h.runtime.store.get<Submission>('submissions',h.s.id)!.grade,partial.grade);
  }finally{await h.close();}
});

test('取消只停止当前批次：未调用项恢复，活动请求未知用量仍预留',async()=>{
  let calls=0;const h=await harness({env,fetcher:async(_u,init)=>{
    calls++;return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
  try{
    await h.upload('student','CancelSecond-2600010001.pdf',1);
    const ids=(await h.request<State>('/state')).submissions.map(s=>s.id);
    const batch=await h.request<{batchId:string}>('/assignments/'+h.a.id+'/ai/queue',{...h.options,ids});
    await until(()=>calls===1);await h.request('/ai/batches/'+batch.batchId+'/control',{action:'cancel'});
    await until(()=>h.runtime.store.get<AiBatch>('ai_batches',batch.batchId)!.items[0].state==='failed');
    assert.equal(calls,1);assert.equal(h.runtime.store.get<Submission>('submissions',ids[1])!.status,'uploaded');
    const ledger=h.runtime.store.all<AiCall>('ai_calls')[0];assert.equal(ledger.estimatedCny,null);assert.ok(ledger.reservedCny>0);
  }finally{await h.close();}
});

test('规则版本/参考内容变化使结果缓存失效，人工说明修改不触发调用',async()=>{
  let calls=0;const h=await harness({env,fetcher:async(_u,init)=>{
    calls++;const body=JSON.parse(String(init?.body)) as {model:string};
    const rows=unitConfig(h.a.config).questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}));
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:300}});
  }});
  try{
    await h.request('/assignments/'+h.a.id+'/ai/queue',h.options);await h.wait();
    assert.equal(calls,1);const s=h.runtime.store.get<Submission>('submissions',h.s.id)!;
    await h.request('/submissions/'+s.id+'/review',{revision:s.revision,rows:s.review,manualReport:'只改人工说明',reportBase:'',confirm:false},'PUT');
    const reused=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',h.options);assert.equal(reused.estimatedCny,0);assert.equal(calls,1);
    const current=h.runtime.store.get<Submission>('submissions',s.id)!;
    // Isolate reusable cache from an existing formal result; 2.2 protects that result from implicit replacement.
    h.runtime.store.put('submissions',{...current,status:'uploaded',grade:null,review:null});
    const reliable=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',h.options);assert.equal(reliable.estimatedCny,0);
    const cache=h.runtime.store.all<{id:string;at:string;grade:unknown}>('ai_cache')[0];
    h.runtime.store.putAi('ai_cache',{...cache,at:'2000-01-01T00:00:00Z'});
    const expired=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',h.options);assert.ok(expired.estimatedCny>0);
    h.runtime.store.put('submissions',current);
    await h.upload('reference','new-reference.pdf',2);
    await h.request('/assignments/'+h.a.id+'/ai/preview',h.options,'POST',400);
    const changed=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,regrade:true});assert.ok(changed.estimatedCny>0);assert.equal(calls,1);
    await h.request('/assignments/'+h.a.id,{...h.a,config:{...h.a.config,principles:'经人工确认的新原则'},regradeUnconfirmed:false},'PUT');
    const newVersion=await h.request<{estimatedCny:number}>('/assignments/'+h.a.id+'/ai/preview',{...h.options,regrade:true});assert.ok(newVersion.estimatedCny>0);
    assert.equal(h.runtime.store.get<Submission>('submissions',s.id)!.grade!.version,1);
  }finally{await h.close();}
});
