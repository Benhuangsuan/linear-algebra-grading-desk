import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApp} from '../server/app.js';import type {AiDependencies} from '../server/ai/service.js';
import {testDirectory,syntheticPdf} from './fixtures.js';import {inferIdentity} from '../server/identity.js';
import {blankQuestion,questionKey,type Assignment,type Submission,type State} from '../shared/domain.js';
import {courseConfig} from '../shared/course.js';import {aiActionBlockers,gradingBlockers} from '../shared/ai-readiness.js';
import type {AiBatch,ProviderStatus} from '../shared/ai.js';import {APP_VERSION} from '../shared/version.js';

const config={...courseConfig([{...blankQuestion(),number:'2',prompt:'Synthetic question',answer:'Synthetic answer'}]),confirmed:true};
async function harness(deps:AiDependencies={env:{},fetcher:async()=>{throw Error('External calls forbidden');}}){
  const dir=testDirectory('assistant-usability-'),runtime=createApp(dir,deps);runtime.app.use(runtime.errorHandler);
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  async function request<T>(path:string,body?:unknown,status=200,method=body?'POST':'GET'):Promise<T>{const res=await fetch(url+'/api'+path,{method,...(body instanceof FormData?{body}:body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data as T;}
  const c=await request<{id:string}>('/courses',{name:'Synthetic course'},201);
  const a=await request<Assignment>('/assignments',{courseId:c.id,title:'Synthetic assignment',scope:'1.1',description:'',config},201);
  async function upload(name:string,keep=false,status=201){const form=new FormData();form.append('kind','student');form.append('file',new Blob([new Uint8Array(await syntheticPdf('Synthetic student page'))]),name);if(keep)form.append('duplicate','keep');return request('/assignments/'+a.id+'/files',form,status);}
  async function close(){await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));runtime.close();}
  return {dir,runtime,a,request,upload,close};
}

test('十位学号严格识别：分隔符、前导零、作业次数、歧义和日期',()=>{
  for(const filename of ['线代作业2-测试甲-0123456789.pdf','线代作业2 测试甲 0123456789.pdf','线代作业2+测试甲+0123456789.pdf','线代作业 2－测试甲 + 0123456789.pdf'])assert.deepEqual(inferIdentity(filename),{studentName:'测试甲',studentId:'0123456789'},filename);
  assert.deepEqual(inferIdentity('线代作业10+测试乙.pdf'),{studentName:'测试乙',studentId:''});
  for(const filename of ['测试甲-12345678.pdf','测试甲-12345678901.pdf','测试甲-0123456789-1234567890.pdf','日期-2026010100.pdf','题号-1234567890.pdf','1234567890.pdf','测试甲1234567890.pdf'])assert.equal(inferIdentity(filename).studentId,'',filename);
});

test('阻塞提示使用真实校对数量、服务权限、选择和现有批次状态',()=>{
  const a={id:'a',config:structuredClone(config),archived:false} as Assignment;
  a.config.questions[0]={...a.config.questions[0],kind:'true_false',unitMode:'independent',subparts:['a','b','c'],children:['a','b','c'].map(label=>({id:label,label,confirmed:label==='c'}))};
  assert.match(gradingBlockers(a,[])[0].message,/还有 2 个/);assert.match(gradingBlockers(a,[])[0].message,/1.1 \/ 2 \/ a/);
  const s={id:'s',status:'uploaded',grade:null} as Submission;const provider={id:'deepseek',configured:true,enabled:true} as ProviderStatus;
  const base={assignment:{...a,config},files:[],ids:['s'],submissions:[s],provider,batches:[],regrade:false,consent:true,deidentified:true,unitsConfirmed:true,busy:false,per:.5,total:2};
  assert.deepEqual(aiActionBlockers(base),[]);
  assert.ok(aiActionBlockers({...base,ids:[]}).some(r=>r.code==='selection'));
  assert.equal(aiActionBlockers({...base,provider:{...provider,enabled:false,configured:false}}).filter(r=>r.code==='service').length,2);
  const batch={status:'paused',items:[{submissionId:'s',state:'queued'}]} as AiBatch;
  assert.ok(aiActionBlockers({...base,batches:[batch]}).some(r=>r.code==='queue'));
  assert.ok(aiActionBlockers({...base,per:0}).some(r=>r.code==='budget'));
});

test('普通模式关闭模拟入口和接口，保留人工评分；测试模式不会使用已有 AI 配置',async()=>{
  const h=await harness();try{
    assert.equal((await h.request<State>('/state')).mockEnabled,false);assert.equal((await h.request<{version:string}>('/health')).version,APP_VERSION);
    await h.upload('线代作业2-测试甲-0123456789.pdf');const s=(await h.request<State>('/state')).submissions[0];
    await h.request('/assignments/'+h.a.id+'/queue',{ids:[s.id],acknowledged:true},403);
    await h.request('/assignments/'+h.a.id,{...h.a,regradeUnconfirmed:true},403,'PUT');
    assert.equal((await h.request<Submission>('/submissions/'+s.id+'/manual',{})).grade?.provider,'manual');
  }finally{await h.close();}
  let attempts=0;const m=await harness({env:{ENABLE_MOCK_UI:'true',AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only'},fetcher:async()=>{attempts++;throw Error('Mock must not use transport');}});
  try{assert.equal((await m.request<State>('/state')).mockEnabled,true);await m.upload('Synthetic.pdf');const s=(await m.request<State>('/state')).submissions[0];await m.request('/assignments/'+m.a.id+'/queue',{ids:[s.id],acknowledged:true});
    for(let i=0;i<200;i++){if(m.runtime.store.get<Submission>('submissions',s.id)?.status==='review')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(m.runtime.store.get<Submission>('submissions',s.id)?.grade?.provider,'mock');assert.equal(attempts,0);assert.equal(m.runtime.store.all('ai_calls').length,0);
  }finally{await m.close();}
});

test('学号人工修改、冲突检查、同名重传和重启兼容；AI 请求不新增身份信息',async()=>{
  const bodies:string[]=[];const deps:AiDependencies={env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only',DASHSCOPE_API_KEY:'fixture-only'},fetcher:async(_url,init)=>{
    bodies.push(String(init?.body));return Response.json({choices:[{message:{content:JSON.stringify({rows:[{key:'1.1 / 2',type:'graded',recognition:'found',verdict:'correct',reason:'',pages:[1],reviewReason:''}]})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100}});
  }};
  const h=await harness(deps);let saved:Submission;
  try{
    const filename='线代作业2-测试甲-0123456789.pdf';await h.upload(filename);let s=(await h.request<State>('/state')).submissions[0];assert.equal(s.studentId,'0123456789');
    for(const id of ['12345678','12345678901','012345678x',1234567890])await h.request('/submissions/'+s.id+'/identity',{studentName:'测试甲',studentId:id},400,'PATCH');
    assert.deepEqual(h.runtime.store.get('submissions',s.id),s);
    s=await h.request<Submission>('/submissions/'+s.id+'/identity',{studentName:'人工姓名',studentId:'0000000042',revision:s.revision},200,'PATCH');
    await h.request('/submissions/'+s.id+'/identity',{studentName:'旧窗口姓名',studentId:'1234567890',revision:0},409,'PATCH');
    // A second upload creates a distinct record and never overwrites the first identity.
    await h.upload(filename,false,409);assert.equal((await h.request<State>('/state')).submissions.length,1);
    await h.upload(filename,true);assert.equal((await h.request<State>('/state')).submissions.length,2);assert.equal(h.runtime.store.get<Submission>('submissions',s.id)?.studentId,'0000000042');
    for(const provider of ['deepseek','qwen']){
      const options={ids:[s.id],provider,consent:true,deidentified:true,unitsConfirmed:true,warningAcknowledged:true,regrade:provider==='qwen',perSubmissionBudget:.5,totalBudget:2};
      const quote=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',options);await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,previewToken:quote.previewToken});
      for(let i=0;i<300;i++){if(h.runtime.store.get<Submission>('submissions',s.id)?.status==='review')break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(h.runtime.store.get<Submission>('submissions',s.id)?.grade?.provider,provider);
    }
    assert.equal(bodies.length,2);for(const body of bodies){assert.ok(!body.includes('0000000042'));assert.ok(!body.includes('0123456789'));assert.ok(!body.includes('studentId'));assert.ok(!body.includes('人工姓名'));}
    s=h.runtime.store.get<Submission>('submissions',s.id)!;assert.equal(s.studentId,'0000000042');assert.equal(s.studentName,'人工姓名');
    saved=s;
    // Model a legacy JSON payload without migration; an unchanged old ID remains editable.
    const legacy=(await h.request<State>('/state')).submissions[1];h.runtime.store.put('submissions',{...legacy,studentId:'23000001'});
    const old=await h.request<Submission>('/submissions/'+legacy.id+'/identity',{studentName:'旧记录姓名',studentId:'23000001'},200,'PATCH');assert.equal(old.studentId,'23000001');
    const cleared=await h.request<Submission>('/submissions/'+legacy.id+'/identity',{studentName:old.studentName,studentId:''},200,'PATCH');assert.equal(cleared.studentId,'');
  }finally{await h.close();}
  const reopened=createApp(h.dir,{env:{},fetcher:async()=>{throw Error('Must not call on restart');}});
  try{assert.deepEqual(reopened.store.get('submissions',saved!.id),saved!);assert.equal(reopened.store.all('ai_calls').length,2);}finally{reopened.close();}
});

test('后端仍拦截未核对小问和未授权请求，不产生调用记录',async()=>{
  const h=await harness({env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only'},fetcher:async()=>{throw Error('Must not reach transport');}});
  try{await h.upload('Synthetic.pdf');const s=(await h.request<State>('/state')).submissions[0];const options={ids:[s.id],provider:'deepseek',consent:true,deidentified:true,unitsConfirmed:true};
    const q={...config.questions[0],kind:'true_false' as const,subparts:['a','b'],children:['a','b'].map(label=>({id:label,label,confirmed:false}))};h.runtime.store.put('assignments',{...h.a,config:{...config,questions:[q]}});
    const failure=await h.request<{error:string}>('/assignments/'+h.a.id+'/ai/preview',options,400);assert.match(failure.error,/还有 2 个/);
    await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,consent:false},400);assert.equal(h.runtime.store.all('ai_calls').length,0);
  }finally{await h.close();}
});
