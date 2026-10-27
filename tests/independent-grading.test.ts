import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';import {createApp} from '../server/app.js';import {manualGrade,MockProvider} from '../server/provider.js';
import {blankQuestion,questionKey,summarize,validateRows,type Assignment,type Submission,type Judgment,type History,type Grade,type State} from '../shared/domain.js';
import {courseConfig,suggestedDeduction} from '../shared/course.js';import {localGradingConfig,unitConfig} from '../shared/units.js';import {gradeCell} from '../server/grades-export.js';
import {validateVision} from '../server/ai/validate.js';import {testDirectory} from './fixtures.js';import type {AiCall,AiBatch} from '../shared/ai.js';

const config={...courseConfig([{...blankQuestion(),section:'3.1',number:'40',kind:'true_false',prompt:'Synthetic statements',answer:'Synthetic answers',subparts:['a','b'],children:['a','b'].map(label=>({id:'stable-'+label,label,confirmed:true}))}]),confirmed:true};
const assignment={id:'assignment',version:1,config} as Assignment;
const cases=[['missing','missing','9.6，漏2题'],['missing','error','9.7，漏1题'],['error','correct','9.9'],['error','error','9.8'],['correct','correct','10']] as const;
type Verdict='missing'|'error'|'correct';
function facts(c:typeof config,values:readonly Verdict[]){return c.questions.map((q,i)=>({key:questionKey(q),type:q.type,recognition:values[i]==='missing'?'missing' as const:'found' as const,verdict:values[i]==='missing'?'missing' as const:values[i]==='error'?'partial' as const:q.type==='completion_only'?'completed' as const:'correct' as const,reason:values[i]==='missing'?'Synthetic missing':values[i]==='error'?'Synthetic calculation incomplete':'',pages:values[i]==='missing'?[]:[1],reviewReason:''}));}
function rows(c:typeof config,values:readonly Verdict[]):Judgment[]{return facts(c,values).map((f,i)=>({...f,deduction:suggestedDeduction(c,c.questions[i],f.recognition,f.verdict),needsReview:false,reviewed:true}));}
function saved(grade:Grade,review:Judgment[]):Submission{return {id:'synthetic',assignmentId:'assignment',fileId:'file',studentName:'测试人工',studentId:'0123456789',status:'confirmed',grade,review,manualReport:'',reportBase:'',error:'',revision:1,updatedAt:'2026-10-27'};}

test('新人工、Mock和视觉评分使用同一稳定小问身份及规则，五种状态汇总/CSV一致',async()=>{
  const before=structuredClone(config);const manual=manualGrade(assignment),ai=unitConfig(config);
  assert.deepEqual(manual.config,ai);assert.deepEqual(manual.rows.map(r=>r.key),['3.1 / 40 / a','3.1 / 40 / b']);assert.deepEqual(ai.questions.map(q=>q.childId),['stable-a','stable-b']);
  for(const [a,b,csv] of cases){const human=rows(manual.config,[a,b]);assert.deepEqual(validateRows(manual.config,human,1,true),[]);const model=validateVision(JSON.stringify({rows:facts(ai,[a,b])}),ai,1).rows;assert.deepEqual(model.map(r=>r.deduction),human.map(r=>r.deduction));assert.equal(gradeCell(saved(manual,human)),csv);assert.equal(summarize(ai,model).score,summarize(manual.config,human).score);}
  assert.throws(()=>validateVision(JSON.stringify({rows:[{...facts(ai,['missing','correct'])[0],key:'3.1 / 40'}]}),ai,1),/未知或重复/);
  const mock=await new MockProvider().grade(assignment,{pages:1} as never);assert.deepEqual(mock.config,ai);assert.deepEqual(mock.rows.map(r=>r.key),manual.rows.map(r=>r.key));assert.deepEqual(validateRows(mock.config,mock.rows,1),[]);assert.deepEqual(config,before);
});

test('整题部分完成、完成性题、独立解答题及个别扣分不混用；旧通用赋分模式不变',()=>{
  const q={...config.questions[0],kind:'solution' as const,unitMode:'whole' as const};const whole=manualGrade({...assignment,config:{...config,questions:[q]}}).config;
  assert.equal(whole.questions.length,1);assert.equal(rows(whole,['error'])[0].deduction,.1);assert.ok(validateRows(whole,[{...rows(whole,['error'])[0],deduction:.2,errorCount:2}],1).length);
  const complete=manualGrade({...assignment,config:{...config,questions:[{...q,type:'completion_only',errorPenalty:0,unitMode:'independent'}]}}).config;assert.equal(complete.questions.length,1);assert.equal(rows(complete,['correct'])[0].deduction,0);
  const custom=localGradingConfig({...config,questions:[{...q,unitMode:'independent',children:[{...q.children![0],missingPenalty:.3,errorPenalty:.25},q.children![1]]}]});assert.equal(custom.questions.length,2);assert.equal(custom.questions[0].errorPenalty,.25);assert.equal(custom.questions[0].missingPenalty,.3);assert.equal(custom.questions[0].childId,'stable-a');
  const points={...config,policy:undefined,mode:'points' as const,questions:[{...q,maxPoints:10,unitMode:'whole' as const}]};assert.deepEqual(localGradingConfig(points),points);
});

async function harness(){
  const dir=testDirectory('independent-grading-');let values:readonly Verdict[]=['missing','missing'];const bodies:string[]=[];
  const runtime=createApp(dir,{env:{ENABLE_MOCK_UI:'true',AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only',DASHSCOPE_API_KEY:'fixture-only'},fetcher:async(_url,init)=>{bodies.push(String(init?.body));return Response.json({choices:[{message:{content:JSON.stringify({rows:facts(unitConfig(config),values)})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100}});}});runtime.app.use(runtime.errorHandler);
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  async function request<T>(path:string,body?:unknown,method=body?'POST':'GET',status=200):Promise<T>{const r=await fetch(url+'/api'+path,{method,...(body instanceof FormData?{body}:body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})});const text=await r.text();assert.equal(r.status,status,text);return JSON.parse(text) as T;}
  const c=await request<{id:string}>('/courses',{name:'Synthetic independent grading'},'POST',201);const a=await request<Assignment>('/assignments',{courseId:c.id,title:'Synthetic units',scope:'3.1',description:'',config},'POST',201);
  const pdf=await PDFDocument.create();pdf.addPage([300,400]).drawText('Synthetic student page',{x:20,y:300});const bytes=await pdf.save();
  for(const name of ['测试人工','测试模型']){const form=new FormData();form.append('kind','student');form.append('file',new Blob([new Uint8Array(bytes)]),name+'.pdf');await request('/assignments/'+a.id+'/files',form,'POST',201);}
  const state=await request<State>('/state');async function close(){await new Promise<void>(done=>server.close(()=>done()));runtime.close();}
  return {dir,runtime,a,request,state,bodies,setValues:(v:readonly Verdict[])=>values=v,close,url};
}

test('API端到端：人工与两个模型五组状态、重复保存、非法单元拒绝、确认/导出/重启保持一致',async()=>{
  const h=await harness();let finalState:State;let ledger:AiCall[];
  try{
    let manual=await h.request<Submission>('/submissions/'+h.state.submissions[0].id+'/manual',{});let model=h.state.submissions[1];
    for(const provider of ['deepseek','qwen'])for(const [a,b,csv] of cases){
      if(manual.status==='confirmed')manual=await h.request('/submissions/'+manual.id+'/reopen',{});
      const review=rows(manual.grade!.config,[a,b]);const body={revision:manual.revision,rows:review,manualReport:'Synthetic teacher report',reportBase:'',confirm:false};
      await h.request('/submissions/'+manual.id+'/review',{...body,rows:[...review,review[0]]},'PUT',400);
      await h.request('/submissions/'+manual.id+'/review',{...body,rows:[...review,{...review[0],key:'3.1 / 40'}]},'PUT',400);
      await h.request('/submissions/'+manual.id+'/review',{...body,rows:[{...review[0],recognition:'found',verdict:'missing'},review[1]]},'PUT',400);
      manual=await h.request('/submissions/'+manual.id+'/review',body,'PUT');const score=summarize(manual.grade!.config,manual.review!).score;
      manual=await h.request('/submissions/'+manual.id+'/review',{...body,revision:manual.revision},'PUT');assert.equal(summarize(manual.grade!.config,manual.review!).score,score);
      manual=await h.request('/submissions/'+manual.id+'/review',{...body,revision:manual.revision,confirm:true},'PUT');assert.equal(gradeCell(manual),csv);
      if(model.status==='confirmed')model=await h.request('/submissions/'+model.id+'/reopen',{});h.setValues([a,b]);
      const options={ids:[model.id],provider,consent:true,deidentified:true,unitsConfirmed:true,regrade:true,warningAcknowledged:true,perSubmissionBudget:.5,totalBudget:2};const quote=await h.request<{previewToken:string}>('/assignments/'+h.a.id+'/ai/preview',options);await h.request('/assignments/'+h.a.id+'/ai/queue',{...options,previewToken:quote.previewToken});
      for(let i=0;i<300;i++){if(h.runtime.store.all<AiBatch>('ai_batches').at(-1)?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(h.runtime.store.all<AiBatch>('ai_batches').at(-1)?.items[0].state,'completed');model=h.runtime.store.get<Submission>('submissions',model.id)!;
      model=await h.request('/submissions/'+model.id+'/review',{revision:model.revision,rows:model.grade!.rows.map(r=>({...r,reviewed:true,needsReview:false})),manualReport:'',reportBase:'',confirm:true},'PUT');assert.equal(gradeCell(model),csv);
      const exported=await fetch(h.url+'/api/assignments/'+h.a.id+'/export').then(async r=>Buffer.from(await r.arrayBuffer()).toString('utf8'));assert.equal(exported,'\uFEFF"姓名","成绩"\r\n"测试人工","'+csv+'"\r\n"测试模型","'+csv+'"');
    }
    assert.equal(h.bodies.length,10);assert.ok(h.bodies.every(s=>s.includes('3.1 / 40 / a')&&s.includes('3.1 / 40 / b')));finalState=await h.request('/state');ledger=h.runtime.store.all('ai_calls');
  }finally{await h.close();}
  const reopened=createApp(h.dir,{env:{},fetcher:async()=>{throw Error('No calls on restart');}});try{assert.deepEqual(reopened.store.all('submissions'),finalState!.submissions);assert.deepEqual(reopened.store.all('ai_calls'),ledger!);}finally{reopened.close();}
});

test('旧父题成绩/错误处数不静默重算；明确重开并重新人工评分保留原快照与费用',async()=>{
  const h=await harness();let old:Submission;let oldCalls:AiCall[];
  try{
    old={...h.state.submissions[0],status:'confirmed',revision:3,grade:{provider:'manual',model:'legacy-human',version:1,at:'2026-01-01',config:structuredClone(config),rows:rows({...config,questions:[config.questions[0]]},['missing']),raw:null},review:null,manualReport:'Legacy teacher report'};
    h.runtime.store.put('submissions',old);h.runtime.store.history(old,'Synthetic legacy confirmation');
    const call:AiCall={id:'synthetic-old-call',batchId:'synthetic-old-batch',submissionId:old.id,assignmentId:h.a.id,version:1,provider:'deepseek',model:'fixture-model',pages:1,at:'2026-01-01',attempt:1,purpose:'grade',status:'success',reservedCny:.1,estimatedCny:.02,inputTokens:100,outputTokens:10,cacheHitTokens:0,usage:{prompt_tokens:100,completion_tokens:10},price:{input:1,output:1,cached:0,date:'2026-01-01',currency:'CNY',tier:'fixture'},error:''};h.runtime.store.putAi('ai_calls',call);oldCalls=h.runtime.store.all('ai_calls');
    await h.request('/assignments/'+h.a.id,{...h.a,config:{...config,principles:config.principles+' Synthetic revision'}},'PUT');assert.deepEqual(h.runtime.store.get('submissions',old.id),old);
    assert.equal(gradeCell(old),'9.8，漏1题');const legacyRows=rows(config,['error']);legacyRows[0]={...legacyRows[0],deduction:.2,errorCount:2};assert.deepEqual(validateRows(config,legacyRows,1,true),[]);
    await h.request('/submissions/'+old.id+'/manual',{replace:true,revision:old.revision,expectedVersion:1},'POST',409);assert.deepEqual(h.runtime.store.get('submissions',old.id),old);
  }finally{await h.close();}
  const runtime=createApp(h.dir,{env:{},fetcher:async()=>{throw Error('No calls');}});runtime.app.use(runtime.errorHandler);const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  async function post(path:string,body:unknown,status=200){const r=await fetch(url+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status);return data as Submission;}
  try{
    assert.deepEqual(runtime.store.get('submissions',old!.id),old!);assert.equal(gradeCell(runtime.store.get<Submission>('submissions',old!.id)!),'9.8，漏1题');assert.deepEqual(runtime.store.all('ai_calls'),oldCalls!);
    const reopened=await post('/submissions/'+old!.id+'/reopen',{});const same=await post('/submissions/'+old!.id+'/manual',{});assert.deepEqual(same,reopened);
    await post('/submissions/'+old!.id+'/manual',{replace:true,revision:0,expectedVersion:1},409);
    const next=await post('/submissions/'+old!.id+'/manual',{replace:true,revision:reopened.revision,expectedVersion:runtime.store.get<Assignment>('assignments',h.a.id)!.version});assert.deepEqual(next.grade!.rows.map(r=>r.key),['3.1 / 40 / a','3.1 / 40 / b']);assert.equal(next.manualReport,old!.manualReport);assert.ok(next.grade!.rows.every(r=>r.deduction===null));
    assert.ok(runtime.store.all<History>('history').some(h=>h.snapshot.grade?.model==='legacy-human'&&h.snapshot.manualReport==='Legacy teacher report'));assert.deepEqual(runtime.store.all('ai_calls'),oldCalls!);
  }finally{await new Promise<void>(done=>server.close(()=>done()));runtime.close();}
});
