import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {batchHarness,mockPageResponse,mockGradeResponse,response} from './grading-batch-fixtures.js';
import type {AiCall} from '../shared/ai.js';
import type {GradingRun} from '../server/ai/grading-recovery.js';
import {validateEvidence,planGrading} from '../server/ai/grading-plan.js';
import {providerConfig} from '../server/ai/config.js';
import {requestBytes,requestBody,MAX_REQUEST_BYTES,assertRequestLimits} from '../server/ai/transport.js';
import {hash,renderPdf,IMAGE_EDGE,completeImageCoverage} from '../server/ai/pdf.js';
import {blankQuestion,questionKey,type Judgment} from '../shared/domain.js';
import {courseConfig} from '../shared/course.js';
import {testDirectory} from './fixtures.js';
import {PDFDocument} from 'pdf-lib';

test('2.12 实际编码体积包含 Unicode/模型/输出参数，保持46MiB和单图保护',()=>{
  const c=providerConfig('deepseek',{}),m=[{role:'user' as const,content:'合成字符与数学 α²'}];
  assert.equal(requestBytes(c,m),Buffer.byteLength(JSON.stringify(requestBody(c,m))));assert.equal(MAX_REQUEST_BYTES,46*1024*1024);
  assert.throws(()=>assertRequestLimits(c,[{role:'user',content:'x'.repeat(MAX_REQUEST_BYTES)}]),/未发送请求/);
  assert.throws(()=>assertRequestLimits(providerConfig('qwen',{}),[{role:'user',content:[{type:'image_url',image_url:{url:'x'.repeat(20*1024*1024+1),detail:'high'}}]}]),/单幅图像/);
});
test('2.12 自动分批覆盖每幅图与原页，原始图像哈希真正进入请求，跨1/6页只评一次',async()=>{
  const h=await batchHarness();try{
    const q=await h.quote();assert.ok(q.items[0].imageBatches>1);assert.equal(q.items[0].pages,6);assert.equal(h.seen.length,0);
    await h.queue();assert.equal((await h.wait()).items[0].state,'completed');
    const extracts=h.seen.filter(s=>s.stage==='extract');assert.equal(extracts.length,q.items[0].imageBatches);const views=extracts.flatMap(s=>JSON.parse(s.body.messages[1].content[0].text).views);
    assert.deepEqual([...new Set(views.filter((v:any)=>v.kind==='student').map((v:any)=>v.page))].sort(),[1,2,3,4,5,6]);assert.equal(new Set(views.map((v:any)=>v.id)).size,views.length);
    for(const req of h.seen){assert.ok(req.bytes<=3*1024*1024);assert.equal(req.bytes,requestBytes(providerConfig('deepseek',{AI_MAX_OUTPUT_TOKENS:'8192'}),req.body.messages));}
    const file=h.runtime.store.all<any>('files').find(f=>f.kind==='student'),bytes=await readFile(join(h.runtime.store.uploads,file.diskName)),images=await renderPdf(bytes,join(h.runtime.store.dir,'ai-cache'),undefined,{maxEdge:4096});
    for(const image of images)assert.ok(extracts.some(r=>r.imageHashes.includes(image.hash)),'Every optimized original image must reach a real constructed request');
    const final=h.seen.find(s=>s.stage==='grade')!;assert.match(JSON.stringify(final.body),/ALL_PAGE_EVIDENCE.*first half.*continuation/s);assert.equal(h.submission().grade!.rows[0].deduction,0);assert.deepEqual(h.submission().grade!.rows[0].pages,[1,6]);assert.equal(h.submission().grade!.rows[1].deduction,.2);
    assert.equal(h.runtime.store.all<AiCall>('ai_calls').length,h.seen.length);assert.equal(h.runtime.store.all<GradingRun>('grading_runs')[0].status,'complete');assert.equal(hash(bytes),hash(await readFile(join(h.runtime.store.uploads,file.diskName))));
  }finally{await h.close();}
});
test('2.12 第二识别批失败不判漏做；重启不付费，重新预估续跑仅重发失败批且旧账本不变',async()=>{
  let failed=false;const h=await batchHarness({respond:(body,i,stage)=>{if(stage==='extract'&&i===2&&!failed){failed=true;return new Response('',{status:500});}return response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body));}});
  try{await h.queue();assert.equal((await h.wait()).items[0].state,'failed');assert.equal(h.seen.length,2);assert.equal(h.submission().grade,null);assert.match(h.submission().error,/不会视为漏做/);
    const old=h.runtime.store.all<AiCall>('ai_calls'),first=h.seen[0].ids;assert.equal(old[1].estimatedCny,null);assert.ok(old[1].reservedCny>0);
    await h.restart();assert.equal(h.seen.length,2);const q=await h.quote();assert.equal(q.items[0].reusedBatches,1);assert.ok(q.items[0].priorCny>=old[1].reservedCny);
    await h.queue({regrade:true});assert.equal((await h.wait()).items[0].state,'completed');assert.equal(h.seen.slice(2).filter(s=>s.stage==='extract'&&s.ids.some(id=>first.includes(id))).length,0);
    for(const call of old)assert.deepEqual(h.runtime.store.get('ai_calls',call.id),call);assert.equal(h.runtime.store.all<AiCall>('ai_calls').length,h.seen.length);
    assert.equal(h.submission().grade!.rows[0].deduction,0);
  }finally{await h.close();}
});
test('2.12 漏识别一个区域即失败，保留有效前批，不生成任何本次扣分',async()=>{
  const h=await batchHarness({respond:(body,i,stage)=>response(body,stage==='extract'?mockPageResponse(body,{omit:i===2}):mockGradeResponse(body))});
  try{await h.queue();assert.equal((await h.wait()).items[0].state,'failed');assert.equal(h.seen.length,2);assert.equal(h.submission().grade,null);assert.match(h.submission().error,/页面或区域未完整识别/);assert.equal(h.runtime.store.all<GradingRun>('grading_runs')[0].status,'partial');}finally{await h.close();}
});
test('2.12 转录不清晰时即使最终模型返回漏做也改为待确认且不扣漏题分',async()=>{
  const h=await batchHarness({limit:5*1024*1024,respond:(body,_i,stage)=>response(body,stage==='extract'?mockPageResponse(body,{unclear:true}):mockGradeResponse(body))});
  try{await h.queue();assert.equal((await h.wait()).items[0].state,'completed',h.submission().error);const rows=h.submission().grade!.rows;assert.equal(rows[1].recognition,'uncertain');assert.equal(rows[1].deduction,null);assert.ok(rows.every(r=>r.needsReview));}finally{await h.close();}
});
test('2.12 预算不足不发请求、不创建账单；输出额度耗尽与大小超限准确区分且不自动重试',async()=>{
  const h=await batchHarness({respond:(body,_i,stage)=>response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body),'length')});
  try{const q=await h.quote({perSubmissionBudget:.0001});await h.request('/assignments/'+h.assignment.id+'/ai/queue',{...h.batchOptions,perSubmissionBudget:.0001,previewToken:q.previewToken},400);assert.equal(h.seen.length,0);assert.equal(h.runtime.store.all('ai_calls').length,0);
    await h.queue();assert.equal((await h.wait()).items[0].failure?.code,'output_limit');assert.equal(h.seen.length,1);assert.match(h.submission().error,/输出额度/);const call=h.runtime.store.all<AiCall>('ai_calls')[0];assert.equal(call.outputTokens,8192);assert.ok(call.estimatedCny!>0);assert.equal(h.submission().grade,null);
  }finally{await h.close();}
});
test('2.12 识别输出不能评分、漏区域、重复ID、未知题号或空转录均拒绝',()=>{
  const config=courseConfig([{...blankQuestion(),number:'2'}]),image={page:1,width:10,height:10,data:'data:image/jpeg;base64,AAA=',hash:'fixture'},views=[{id:'v1',kind:'student' as const,image}];
  for(const data of [{views:[]},{views:[{id:'v1',text:'',keys:[],unclear:false,blank:false}]},{views:[{id:'v1',text:'x',keys:['unknown'],unclear:false,blank:false}]},{views:[{id:'v1',text:'x',keys:[],unclear:false,blank:false},{id:'v1',text:'y',keys:[],unclear:false,blank:false}]},{rows:[]}])assert.throws(()=>validateEvidence(JSON.stringify(data),views,config));
});
test('2.12 巨幅扫描式points不再固定放大3倍，视图有界且单页区域完整',async()=>{
  const p=await PDFDocument.create(),page=p.addPage([2502,3671]);page.drawText('Synthetic powers x^2, matrix [1 2; 0 1]',{x:100,y:3400,size:40});const bytes=await p.save(),before=hash(bytes),images=await renderPdf(bytes,testDirectory('v2.12-render-'),undefined,{maxEdge:4096});
  assert.ok(images.length<7);assert.ok(images.every(p=>p.width<=IMAGE_EDGE&&p.height<=IMAGE_EDGE));const tiles=images.filter(i=>i.tile);assert.ok(tiles.length>0);assert.equal(Math.min(...tiles.map(t=>t.crop!.x)),0);assert.equal(Math.max(...tiles.map(t=>t.crop!.y+t.crop!.height)),1);assert.equal(hash(bytes),before);
});
test('2.12 汇总分组跨页评分中途失败，重试不重复识别也不重复处理成功评分组',async()=>{
  let gradingCalls=0,failed=false;
  const h=await batchHarness({respond:(body,_i,stage)=>{
    if(stage==='extract'){const result=mockPageResponse(body),meta=JSON.parse(body.messages[1].content[0].text);for(const row of result.views){const v=meta.views.find((v:any)=>v.id===row.id);if(v.kind==='student'&&[3,4].includes(v.page)){row.blank=false;row.keys=[meta.units[1].key];row.text='Separate synthetic question 4, continuation on pages 3 and 4.';}}return response(body,result);}
    gradingCalls++;if(gradingCalls===2&&!failed){failed=true;return new Response('',{status:500});}
    const result=mockGradeResponse(body);for(const r of result.rows)if(r.key.includes(' / 4')){r.recognition='found';r.verdict='correct';r.pages=[3,4];}return response(body,result);
  }});
  try{await h.queue();const first=await h.wait();assert.equal(first.items[0].state,'failed');assert.equal(gradingCalls,2);assert.equal(h.submission().grade,null);const old=h.runtime.store.all<AiCall>('ai_calls'),extracts=h.seen.filter(r=>r.stage==='extract').length;
    await h.queue();assert.equal((await h.wait()).items[0].state,'completed');assert.equal(gradingCalls,3);assert.equal(h.seen.filter(r=>r.stage==='extract').length,extracts);assert.ok(h.submission().grade!.rows.every(r=>r.deduction===0));for(const call of old)assert.deepEqual(h.runtime.store.get('ai_calls',call.id),call);
  }finally{await h.close();}
});
test('2.12 分批超时用量未知只预留一次，既有人工结果/修订不被不完整处理覆盖',async()=>{
  const h=await batchHarness({timeout:100,respond:async(_b,_i,_s,signal)=>new Promise<Response>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(Error('synthetic timeout')),{once:true}))});
  try{const rows:Judgment[]=h.assignment.config.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:'correct',reason:'',pages:[1],deduction:0,reviewed:true,needsReview:false,reviewReason:''}));const old={...h.submission(),status:'review' as const,grade:{provider:'manual' as const,model:'manual',at:new Date().toISOString(),version:h.assignment.version,config:h.assignment.config,rows,raw:{fixture:true}},review:rows};h.runtime.store.put('submissions',old);const history=h.runtime.store.all('history');
    await h.queue({regrade:true});assert.equal((await h.wait()).items[0].failure?.code,'timeout');assert.equal(h.seen.length,1);assert.deepEqual(h.submission().grade,old.grade);assert.deepEqual(h.submission().review,old.review);for(const row of history as any[])assert.deepEqual(h.runtime.store.get('history',row.id),row);
    const call=h.runtime.store.all<AiCall>('ai_calls')[0];assert.equal(call.estimatedCny,null);assert.ok(call.reservedCny>0);assert.equal(call.error,'timeout');
  }finally{await h.close();}
});
test('2.12 规则变化使续跑证据失效且保留旧批次/费用，不隐式扩大作用范围',async()=>{
  const h=await batchHarness({respond:(body,i,stage)=>i===2?new Response('',{status:500}):response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body))});
  try{await h.queue();await h.wait();const old=h.runtime.store.all('grading_runs'),calls=h.runtime.store.all<AiCall>('ai_calls');assert.equal((await h.quote()).items[0].reusedBatches,1);
    await h.request('/assignments/'+h.assignment.id,{...h.assignment,config:{...h.assignment.config,principles:'Changed only in this synthetic environment'},regradeUnconfirmed:false},200,'PUT');assert.equal((await h.quote()).items[0].reusedBatches,0);assert.deepEqual(h.runtime.store.all('grading_runs'),old);for(const c of calls)assert.deepEqual(h.runtime.store.get('ai_calls',c.id),c);
  }finally{await h.close();}
});
test('2.12 损坏缓存缺原页或分区不能静默漏页，自动从原件重建',async()=>{
  const doc=await PDFDocument.create();for(let n=0;n<3;n++)doc.addPage([300,420]).drawText('Synthetic '+n,{x:30,y:300,size:20});const bytes=await doc.save(),dir=testDirectory('v2.12-cache-');
  const original=await renderPdf(bytes,dir,undefined,{expectedPages:3}),folder=join(dir,'pdf',(await readdir(join(dir,'pdf')))[0]),path=join(folder,'pages.json');const manifest=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify(manifest.filter((p:any)=>p.page!==3)));const rebuilt=await renderPdf(bytes,dir,undefined,{expectedPages:3});assert.deepEqual(rebuilt.map(p=>p.hash),original.map(p=>p.hash));assert.deepEqual(rebuilt.map(p=>p.page),[1,2,3]);
  assert.equal(completeImageCoverage([{page:1,width:10,height:10,hash:'synthetic',overview:true}],1),false);
});
test('2.12 暂停在当前识别批结束后停止后续调用，继续沿用原预算且不重发成功批',async()=>{
  const h=await batchHarness({respond:(body,i,stage)=>{if(i===1)h.runtime.ai.control(h.runtime.store.all<any>('ai_batches').at(-1).id,'pause');return response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body));}});
  try{const queued=await h.queue();for(let i=0;i<500;i++){if(h.runtime.store.all<any>('ai_batches').at(-1)?.items[0].state==='queued')break;await new Promise(r=>setTimeout(r,20));}
    const paused=h.runtime.store.get<any>('ai_batches',queued.batchId);assert.equal(paused.status,'paused');assert.equal(paused.items[0].state,'queued');assert.equal(h.seen.length,1);assert.equal(h.submission().grade,null);assert.match(h.submission().error,/已暂停/);
    const old=h.runtime.store.all<AiCall>('ai_calls');h.runtime.ai.control(queued.batchId,'resume');assert.equal((await h.wait()).items[0].state,'completed');assert.equal(h.seen.slice(1).some(s=>s.ids.some(id=>h.seen[0].ids.includes(id))),false);for(const c of old)assert.deepEqual(h.runtime.store.get('ai_calls',c.id),c);
  }finally{await h.close();}
});
test('2.12 已定位跨页作答与最终漏做判定矛盾时，不扣漏题分并展示全部关联原页',async()=>{
  const h=await batchHarness({respond:(body,_i,stage)=>{if(stage==='extract')return response(body,mockPageResponse(body));const result=mockGradeResponse(body);for(const row of result.rows){row.recognition='not_found';row.verdict='missing';row.pages=[];}return response(body,result);}});
  try{await h.queue();assert.equal((await h.wait()).items[0].state,'completed');const row=h.submission().grade!.rows[0];assert.equal(row.recognition,'uncertain');assert.equal(row.deduction,null);assert.deepEqual(row.pages,[1,6]);assert.match(row.reviewReason!,/已找到关联作答/);assert.equal(h.submission().grade!.rows[1].deduction,.2);}finally{await h.close();}
});
