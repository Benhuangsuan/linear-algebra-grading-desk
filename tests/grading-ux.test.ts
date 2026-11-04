import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {uxHarness,shortPdf} from './grading-ux-fixtures.js';
import type {AiCall,CheckResult} from '../shared/ai.js';
import {questionKey,summarize,type StoredFile} from '../shared/domain.js';
import {gradesCsv} from '../server/grades-export.js';
import {SYSTEM} from '../server/ai/prompt.js';

test('2.13 全选择集立即返回，逐文件隔离损坏/超限/缺页/缺文件，剔除后复用检查直接收费',async()=>{
  const h=await uxHarness();try{
    for(const n of ['Broken','Oversize','MissingPages','MissingFile','LastGood'])await h.upload('student','Synthetic'+n+'.pdf');
    const ss=h.submissions(),file=(i:number)=>h.runtime.store.get<StoredFile>('files',ss[i].fileId)!;
    await writeFile(join(h.runtime.store.uploads,file(1).diskName),'not PDF');
    await writeFile(join(h.runtime.store.uploads,file(2).diskName),Buffer.alloc(30*1024*1024+1));
    h.runtime.store.put('files',{...file(3),pages:3});h.runtime.store.delete('files',file(4).id);
    // Recreate a missing physical-file case without deleting its owning submission.
    await h.upload('student','SyntheticAbsent.pdf');const absent=h.submissions().at(-1)!;const f=h.runtime.store.get<StoredFile>('files',absent.fileId)!;h.runtime.store.put('files',{...f,diskName:randomUUID()+'.pdf'});
    const ids=h.submissions().map(s=>s.id),t=performance.now();let result=await h.request<CheckResult>(h.path+'/check',{...h.options,ids});const firstMs=performance.now()-t;
    assert.equal(result.items.length,ids.length);assert.ok(result.items.every(i=>i.state==='checking'));assert.ok(firstMs<10000);
    while(!result.done){await new Promise(r=>setTimeout(r,10));result=await h.request(h.path+'/check/'+result.id);}
    assert.equal(result.items.filter(i=>i.state==='ready').length,2);assert.equal(result.items.filter(i=>i.state==='blocked').length,4);assert.equal(h.seen.length,0);
    await h.queue(result,{}).then(()=>assert.fail('blocked files entered queue'),()=>{});assert.equal(h.seen.length,0);
    const good={...result,items:result.items.filter(i=>i.state==='ready')};let prepares=0;const ai=h.runtime.ai as any,original=ai.prepare.bind(ai);ai.prepare=(...args:any[])=>{prepares++;return original(...args);};
    await h.queue(good);await h.wait();assert.equal(prepares,0);assert.equal(h.seen.length,2);assert.ok(h.runtime.store.all<AiCall>('ai_calls').every(c=>good.items.some(i=>i.submissionId===c.submissionId)));
    for(const item of result.items.filter(i=>i.state==='blocked')){const s=h.submissions().find(s=>s.id===item.submissionId)!;assert.equal(s.grade,null);assert.equal(s.status,'uploaded');}
    await writeFile(join(h.dir,'partial-evidence.json'),JSON.stringify({firstMs,states:result.items.map(i=>i.state),goodQueued:good.items.length,extraPrepares:prepares,paidCalls:0}));
  }finally{await h.close();}
});

test('2.13 未确认题目先提示核对；无Key和未授权与PDF可处理性分开',async()=>{
  const h=await uxHarness({env:{DEEPSEEK_API_KEY:'',AI_ALLOW_PAID:'false'}});try{
    h.runtime.store.put('assignments',{...h.assignment,config:{...h.assignment.config,confirmed:false}});
    const error=await h.request(h.path+'/check',{...h.options,ids:h.submissions().map(s=>s.id)},400);assert.match(error.error,/需先核对题目清单/);
    h.runtime.store.put('assignments',h.assignment);const result=await h.check();assert.equal(result.items[0].state,'ready');
    await h.queue(result).then(()=>assert.fail(),()=>{});await h.queue(result,{consent:false}).then(()=>assert.fail(),()=>{});assert.equal(h.seen.length,0);assert.equal(h.runtime.store.all('ai_calls').length,0);
  }finally{await h.close();}
});

test('2.13 名单缩小无需重扫；重复检查复用；单个文件变化只重新预处理该文件',async()=>{
  const h=await uxHarness();try{
    await h.upload('student','SyntheticBeta.pdf');const ai=h.runtime.ai as any,original=ai.prepare.bind(ai);let calls=0;ai.prepare=(...args:any[])=>{calls++;return original(...args);};
    const first=await h.check();assert.equal(calls,2);await h.check();assert.equal(calls,2);
    const ss=h.submissions(),f=h.runtime.store.get<StoredFile>('files',ss[0].fileId)!;await writeFile(join(h.runtime.store.uploads,f.diskName),await shortPdf(2,'Synthetic changed content'));
    await h.queue(first).then(()=>assert.fail('changed original accepted'),()=>{});const second=await h.check();assert.equal(calls,3);
    await h.queue({...second,items:[second.items[1]]});await h.wait();assert.equal(calls,3);assert.equal(h.seen.length,1);assert.equal(h.submissions()[0].grade,null);
  }finally{await h.close();}
});

test('2.13 检查凭据绑定规则/输出/模型/修订/服务重启/过期，不授权额外名单',async()=>{
  const h=await uxHarness();try{
    const check=await h.check();await h.queue(check,{maxOutputTokens:16384}).then(()=>assert.fail(),()=>{});
    await h.queue(check,{provider:'qwen'}).then(()=>assert.fail(),()=>{});
    const entry=(h.runtime.ai as any).checks.get(check.items[0].token);entry.at-=16*60000;await h.queue(check).then(()=>assert.fail(),()=>{});entry.at=Date.now();
    h.runtime.store.put('assignments',{...h.assignment,version:2});await h.queue(check).then(()=>assert.fail(),()=>{});h.runtime.store.put('assignments',h.assignment);
    const s=h.submissions()[0];h.runtime.store.put('submissions',{...s,revision:s.revision+1});await h.queue(check).then(()=>assert.fail(),()=>{});h.runtime.store.put('submissions',s);
    await h.restart();await h.queue(check).then(()=>assert.fail(),()=>{});assert.equal(h.seen.length,0);
  }finally{await h.close();}
});

test('2.13 理论整批极值不阻断；第一笔不足拒绝；逐次预算阻止下一份且未知预留保留',async()=>{
  const h=await uxHarness({fetcher:async()=>{throw Error('synthetic network interruption');}});try{
    await h.upload('student','SyntheticBeta.pdf');const check=await h.check();
    const rejected=await h.request(h.path+'/queue',{...h.options,ids:check.items.map(i=>i.submissionId),checkTokens:Object.fromEntries(check.items.map(i=>[i.submissionId,i.token])),perSubmissionBudget:.001},400);assert.match(rejected.error,/第一笔.*预算/);assert.equal(h.seen.length,0);
    const quote=await h.runtime.ai.preview(h.assignment.id,{...h.options,ids:check.items.map(i=>i.submissionId)}),one=quote.items[0].firstReserveCny;
    assert.ok(quote.firstReserveCny>one*1.5);
    await h.queue(check,{totalBudget:one+.000001});await h.wait();assert.equal(h.seen.length,1);
    const ledger=h.runtime.store.all<AiCall>('ai_calls');assert.equal(ledger.length,1);assert.equal(ledger[0].estimatedCny,null);assert.ok(ledger[0].reservedCny>0);
    await h.restart();assert.equal(h.seen.length,1);assert.deepEqual(h.runtime.store.all('ai_calls'),ledger);
  }finally{await h.close();}
});

test('2.13 并发重复启动只能创建一个批次；没有显式启动零调用',async()=>{
  const h=await uxHarness();try{const c=await h.check();assert.equal(h.seen.length,0);const results=await Promise.allSettled([h.queue(c),h.queue(c)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await h.wait();assert.equal(h.seen.length,1);assert.equal(h.runtime.store.all('ai_batches').length,1);}finally{await h.close();}
});

test('2.13 正确题人工备注保留全部评分标记、总分/CSV/漏题不变，确认/重开/重启可追溯',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();const original=h.submissions()[0],rows=structuredClone(original.review!),csv=gradesCsv(h.submissions()),sum=summarize(original.grade!.config,rows);assert.ok(rows.every(r=>!r.teacherNote));
    rows[1].teacherNote='这一步过程清楚';const saved=await h.request('/submissions/'+original.id+'/review',{revision:original.revision,rows,manualReport:'',reportBase:'',confirm:false},200,'PUT');
    assert.deepEqual({...saved.review[1],teacherNote:undefined},{...original.review![1],teacherNote:undefined});assert.deepEqual(summarize(saved.grade.config,saved.review),sum);assert.equal(gradesCsv(h.submissions()),csv);
    const confirmed=await h.request('/submissions/'+original.id+'/review',{revision:saved.revision,rows:saved.review.map((r:any)=>({...r,reviewed:true,needsReview:false})),manualReport:'',reportBase:'',confirm:true},200,'PUT');
    await h.request('/submissions/'+original.id+'/review',{revision:confirmed.revision,rows,manualReport:'',reportBase:'',confirm:false},409,'PUT');await h.restart();assert.equal(h.submissions()[0].review![1].teacherNote,'这一步过程清楚');
    const reopened=await h.request('/submissions/'+original.id+'/reopen',{});reopened.review[1].teacherNote='';await h.request('/submissions/'+original.id+'/review',{revision:reopened.revision,rows:reopened.review,manualReport:'',reportBase:'',confirm:false},200,'PUT');
    assert.ok(h.runtime.store.all<any>('history').some(r=>r.snapshot.review?.[1].teacherNote==='这一步过程清楚'));assert.equal(h.submissions()[0].review![1].deduction,0);assert.equal(h.submissions()[0].review![1].verdict,'correct');
  }finally{await h.close();}
});

test('2.13 免费解释零调用；授权追问绑定单元/学生/评分版本，原页完整且不改成绩和历史',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();const original=h.submissions()[0],key=original.review![0].key,url='/submissions/'+original.id+'/explanation',query='?key='+encodeURIComponent(key),history=h.runtime.store.all('history'),csv=gradesCsv(h.submissions());
    const local=await h.request(url+query);assert.equal(h.seen.length,1);assert.equal(local.reason,original.review![0].reason);
    const options={key,contextToken:local.contextToken,requestId:randomUUID(),question:'为什么是相乘？',provider:'deepseek',budget:.1,consent:true,deidentified:true};
    await h.request(url,{...options,consent:false},400);await h.request(url,{...options,budget:.001},400);assert.equal(h.seen.length,1);
    const answer=await h.request(url,options);assert.equal(h.seen.length,2);assert.equal(answer.turns.length,1);assert.equal(answer.turns[0].uncertain,true);
    await h.request(url,options,400);assert.equal(h.seen.length,2);
    await h.upload('student','SyntheticBeta.pdf');const second=h.submissions()[1];h.runtime.store.put('submissions',{...second,grade:original.grade,review:original.review,status:'review'});
    await h.request('/submissions/'+second.id+'/explanation',{...options,requestId:randomUUID()},400);
    const request=h.seen.at(-1);assert.equal(request.messages[2].content.filter((p:any)=>p.type==='image_url').length,2);assert.ok(!JSON.stringify(request).includes('SyntheticAlpha'));assert.ok(!JSON.stringify(request).includes('teacherNote'));
    assert.deepEqual(h.submissions()[0],original);assert.deepEqual(h.runtime.store.all('history'),history);assert.equal(gradesCsv([h.submissions()[0]]),csv);
    await h.restart();assert.equal((await h.request(url+query)).turns.length,1);assert.equal(h.seen.length,2);
    await h.request(url+query,undefined,200,'DELETE');assert.equal((await h.request(url+query)).turns.length,0);assert.equal(h.runtime.store.all('ai_calls').length,2);
  }finally{await h.close();}
});

test('2.13 连续追问只含本项历史，评分变化留存历史问答，删除学生清除对话而保留账本',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();let s=h.submissions()[0];const key=s.review![0].key,url='/submissions/'+s.id+'/explanation',query='?key='+encodeURIComponent(key),local=await h.request(url+query);
    for(let i=0;i<3;i++)await h.request(url,{key,contextToken:local.contextToken,requestId:randomUUID(),question:'核对第 '+i+' 步',provider:'deepseek',budget:.1,consent:true,deidentified:true});
    assert.match(JSON.stringify(h.seen.at(-1)),/核对第 0 步/);await h.request(url,{key,contextToken:local.contextToken,requestId:randomUUID(),question:'第四次',provider:'deepseek',budget:.1,consent:true,deidentified:true},400);assert.equal(h.seen.length,4);
    s.review![0].reason='人工修订：请核对相乘';h.runtime.store.put('submissions',{...s,revision:s.revision+1});const next=await h.request(url+query);assert.equal(next.turns.length,0);assert.equal(next.archived[0].turns.length,3);
    await h.request(url,{key,contextToken:local.contextToken,requestId:randomUUID(),question:'旧授权',provider:'deepseek',budget:.1,consent:true,deidentified:true},400);assert.equal(h.seen.length,4);
    h.runtime.store.delete('submissions',s.id);assert.equal(h.runtime.store.all('explanations').length,0);assert.equal(h.runtime.store.all('ai_calls').length,4);
  }finally{await h.close();}
});

test('2.13 首轮理由要求面对学生、简明可核对；不索取思维链或让AI生成无扣分备注',()=>{
  assert.match(SYSTEM,/助教直接面对学生/);assert.match(SYSTEM,/1至3句/);assert.match(SYSTEM,/矩阵元素/);assert.match(SYSTEM,/不得写“该学生”/);assert.match(SYSTEM,/正确项留空，不生成助教备注/);
});

test('2.13 参考页缺失逐份阻止，检查中和不存在的凭据均不能入收费队列',async()=>{
  const h=await uxHarness();try{
    await h.upload('student','SyntheticBeta.pdf');const initial=await h.request<CheckResult>(h.path+'/check',{...h.options,ids:h.submissions().map(s=>s.id)});await h.queue(initial).then(()=>assert.fail(),()=>{});assert.equal(h.seen.length,0);
    const q=h.assignment.config.questions[0];h.runtime.store.put('assignments',{...h.assignment,config:{...h.assignment.config,questions:[{...q,referenceSources:[{fileId:'missing-reference',page:1,graphic:true}]}]}});
    const result=await h.check();assert.ok(result.items.every(i=>i.state==='blocked'));assert.match(result.items[0].message,/参考页/);assert.equal(h.seen.length,0);
  }finally{await h.close();}
});

test('2.13 追问未知用量不重发、格式失败记账、无Key仍可免费查看与人工复核',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();const s=h.submissions()[0],key=s.review![0].key,url='/submissions/'+s.id+'/explanation',query='?key='+encodeURIComponent(key),local=await h.request(url+query),snapshot=JSON.stringify(s);
    const deps=(h.runtime.ai as any).deps,original=deps.fetcher;deps.fetcher=async()=>{throw Error('synthetic interrupted');};const o={key,contextToken:local.contextToken,requestId:randomUUID(),question:'核对计算',provider:'deepseek',budget:.1,consent:true,deidentified:true};
    await h.request(url,o,400);const call=h.runtime.store.all<AiCall>('ai_calls').at(-1)!;assert.equal(call.estimatedCny,null);assert.ok(call.reservedCny>0);await h.request(url,o,400);assert.equal(h.runtime.store.all('ai_calls').length,2);
    deps.fetcher=async()=>Response.json({choices:[{message:{content:'{"answer":"no page validation","pages":[999],"uncertain":false}'},finish_reason:'stop'}],usage:{prompt_tokens:500,completion_tokens:50}});
    await h.request(url,{...o,requestId:randomUUID()},400);assert.equal(h.runtime.store.all<AiCall>('ai_calls').at(-1)!.error,'explanation_format');assert.equal(JSON.stringify(h.submissions()[0]),snapshot);
    h.env.DEEPSEEK_API_KEY='';assert.equal((await h.request(url+query)).turns.length,2);await h.request(url,{...o,requestId:randomUUID()},400);assert.equal(h.runtime.store.all('ai_calls').length,3);deps.fetcher=original;
  }finally{await h.close();}
});

test('2.13 Windows冷缓存短作业与较大批次计时、缓存复用计时',async()=>{
  const measurements=[];for(const count of [5,25]){const h=await uxHarness();try{
    for(let i=1;i<count;i++)await h.upload('student','Synthetic'+i+'.pdf',await shortPdf(2,'Synthetic distinct '+i));
    const t=performance.now(),initial=await h.request<CheckResult>(h.path+'/check',{...h.options,ids:h.submissions().map(s=>s.id)}),firstMs=performance.now()-t;assert.equal(initial.items.length,count);assert.ok(firstMs<10000);
    let r=initial;while(!r.done){await new Promise(resolve=>setTimeout(resolve,10));r=await h.request(h.path+'/check/'+r.id);}const allMs=performance.now()-t;assert.ok(r.items.every(i=>i.state==='ready'));
    const cached=performance.now();await h.check();const cachedMs=performance.now()-cached;measurements.push({files:count,pages:count*2,firstMs,allMs,cachedMs});assert.equal(h.seen.length,0);
  }finally{await h.close();}}await writeFile(join(process.cwd(),'codex工作区','quick-check-timing.json'),JSON.stringify(measurements,null,2));
});

test('2.13 付费解释核对原评分文件指纹，材料替换后免费理由仍可查看',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();const s=h.submissions()[0],key=s.review![0].key,url='/submissions/'+s.id+'/explanation',query='?key='+encodeURIComponent(key),local=await h.request(url+query),f=h.runtime.store.get<StoredFile>('files',s.fileId)!;
    await writeFile(join(h.runtime.store.uploads,f.diskName),await shortPdf(2,'Synthetic replacement'));
    const rejected=await h.request(url,{key,contextToken:local.contextToken,requestId:randomUUID(),question:'解释计算',provider:'deepseek',budget:.1,consent:true,deidentified:true},400);assert.match(rejected.error,/原评分所用材料已变化/);assert.equal(h.seen.length,1);assert.equal((await h.request(url+query)).reason,s.review![0].reason);assert.deepEqual(h.submissions()[0],s);
  }finally{await h.close();}
});

test('2.13 兼容没有对话表和备注字段的旧SQLite，启动不重算成绩或改账本',async()=>{
  const h=await uxHarness();try{
    await h.queue(await h.check());await h.wait();const before={submissions:h.submissions(),history:h.runtime.store.all('history'),calls:h.runtime.store.all('ai_calls')};
    h.runtime.store.db.exec('DROP TABLE explanations');await h.restart();
    assert.deepEqual(h.submissions(),before.submissions);assert.deepEqual(h.runtime.store.all('history'),before.history);assert.deepEqual(h.runtime.store.all('ai_calls'),before.calls);assert.equal(h.runtime.store.all('explanations').length,0);assert.equal(h.seen.length,1);assert.ok(h.submissions()[0].review!.every(r=>r.teacherNote===undefined));
  }finally{await h.close();}
});
