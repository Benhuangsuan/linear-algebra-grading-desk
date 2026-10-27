import {chromium,expect} from '@playwright/test';import express from 'express';import {once} from 'node:events';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';import {testDirectory} from '../tests/fixtures.js';import {courseConfig} from '../shared/course.js';
import {blankQuestion,questionKey,summarize,type Assignment,type Submission,type State,type Grade,type History} from '../shared/domain.js';import type {AiCall} from '../shared/ai.js';

const dir=testDirectory('independent-grading-browser-');let states:readonly string[]=['missing','missing'];let simulatedCalls=0;
const runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only'},fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body)),text=body.messages[1].content[0].text;const {units}=JSON.parse(text.slice(text.indexOf('{')));expect(units.map((q:{key:string})=>q.key)).toEqual(['3.1 / 40 / a','3.1 / 40 / b']);simulatedCalls++;
  return Response.json({choices:[{message:{content:JSON.stringify({rows:units.map((q:{key:string;type:string},i:number)=>({key:q.key,type:q.type,recognition:states[i]==='missing'?'missing':'found',verdict:states[i]==='missing'?'missing':states[i]==='error'?'partial':'correct',reason:states[i]==='error'?'Synthetic calculation incomplete':'',pages:states[i]==='missing'?[]:[1],reviewReason:''}))})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100}});
}});runtime.app.use(express.static(resolve('dist')));runtime.app.use(runtime.errorHandler);const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const executablePath=process.env.BROWSER_PATH??['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);if(!executablePath)throw Error('请设置 BROWSER_PATH');
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>void d.accept());
async function request<T>(path:string,body?:unknown){const r=await page.request.fetch(url+'/api'+path,{method:body?'POST':'GET',data:body});expect(r.ok()).toBe(true);return await r.json() as T;}
const state=()=>request<State>('/state');const row=(name:string)=>page.getByTestId('submission-row').filter({has:page.locator('.submission-name strong',{hasText:name})});
const editor=page.getByRole('dialog',{name:/^修改评分/});
async function edit(name:string){await row(name).getByRole('button',{name:'更多操作 '+name,exact:true}).click();await page.getByRole('button',{name:/^(人工评分|修改评分)$/,exact:true}).click();await expect(editor).toBeVisible();}
async function verdict(part:string,value:string){await editor.getByLabel('选择题目',{exact:true}).selectOption('3.1 / 40 / '+part);await editor.getByLabel('评分判定',{exact:true}).selectOption(value);if(value==='error')await editor.getByLabel('扣分原因',{exact:true}).fill('计算未完成（合成测试）');}
async function save(){await editor.getByRole('button',{name:'保存评分',exact:true}).click();await expect(editor).toHaveCount(0);}
async function confirm(name:string){await row(name).getByRole('button',{name:'确认成绩',exact:true}).click();await expect(row(name)).toHaveClass(/confirmed/);}
async function csv(label:string){await page.getByRole('button',{name:'作业列表操作',exact:true}).click();const pending=page.waitForEvent('download');await page.getByRole('link',{name:'导出成绩',exact:true}).click();const file=await pending;const path=join(dir,label+'.csv');await file.saveAs(path);const bytes=readFileSync(path);expect([...bytes.subarray(0,3)]).toEqual([239,187,191]);return bytes.toString('utf8');}
let finalState:State|undefined,ledger:AiCall[]=[];
try{
  const c=await request<{id:string}>('/courses',{name:'合成独立小问验收'});const config={...courseConfig([{...blankQuestion(),section:'3.1',number:'40',kind:'true_false',prompt:'Synthetic statements',answer:'Synthetic answers',subparts:['a','b'],children:['a','b'].map(label=>({id:'stable-'+label,label,confirmed:true}))}]),confirmed:true};
  const a=await request<Assignment>('/assignments',{courseId:c.id,title:'独立小问合成验收',scope:'3.1',description:'',config});const pdf=await PDFDocument.create();pdf.addPage([300,400]).drawText('Synthetic student',{x:20,y:300});const bytes=Buffer.from(await pdf.save());
  for(const name of ['人工测试甲','模型测试乙','旧记录测试丙']){const r=await page.request.post(url+'/api/assignments/'+a.id+'/files',{multipart:{kind:'student',file:{name:name+'.pdf',mimeType:'application/pdf',buffer:bytes}}});expect(r.status()).toBe(201);}
  const legacy=(await state()).submissions[2];const oldGrade:Grade={provider:'manual',model:'legacy-human',at:'2026-01-01',version:1,config,raw:null,rows:[{key:'3.1 / 40',type:'graded',recognition:'missing',verdict:'missing',deduction:.2,reason:'合成旧整题记录',pages:[],needsReview:false,reviewed:true}]};
  const old:Submission={...legacy,status:'confirmed',grade:oldGrade,review:structuredClone(oldGrade.rows),manualReport:'旧人工报告',revision:3};runtime.store.put('submissions',old);runtime.store.history(old,'合成旧确认记录');
  await page.goto(url+'/?course='+c.id+'&assignment='+a.id);await expect(page.getByText('选择会随批改进度更新；搜索或筛选不会清空选择。',{exact:true})).toHaveCount(0);await expect(row('旧记录测试丙').locator('.submission-score strong')).toHaveText('9.8');
  const results:unknown[]=[];const combinations=[['missing','missing','9.6，漏2题'],['missing','error','9.7，漏1题'],['error','correct','9.9'],['error','error','9.8'],['correct','correct','10']];
  for(const [av,bv,expected] of combinations){
    await edit('人工测试甲');await expect(editor.getByLabel('错误处数',{exact:true})).toHaveCount(0);expect(await editor.getByLabel('选择题目',{exact:true}).locator('option').evaluateAll(els=>els.map(e=>(e as HTMLOptionElement).value))).toEqual(['3.1 / 40 / a','3.1 / 40 / b']);
    await verdict('a',av);await verdict('b',bv);if(av==='missing'&&bv==='missing')await editor.screenshot({path:join(dir,'independent-editor.png')});await save();await confirm('人工测试甲');
    const model=(await state()).submissions[1];if(model.status==='confirmed'){await edit('模型测试乙');await editor.getByRole('button',{name:'取消',exact:true}).click();}
    states=[av,bv];
    if(model.grade){await row('模型测试乙').getByRole('button',{name:'更多操作 模型测试乙',exact:true}).click();await page.getByRole('button',{name:'重新 AI 批改…',exact:true}).click();}
    else{await row('模型测试乙').getByRole('checkbox').check();await page.getByRole('button',{name:/^AI 批改已选/}).click();}
    const ai=page.getByRole('dialog',{name:/^(AI 批改|重新 AI 批改)$/});await expect(ai).toContainText('deepseek-flash');
    await ai.getByLabel('已核对本次计分题目与扣分规则').check();await ai.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息').check();await ai.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用').check();await ai.getByRole('button',{name:'预估费用',exact:true}).click();await expect(ai).toContainText('保守估算');await ai.getByRole('button',{name:'开始真实批改',exact:true}).click();await ai.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(row('模型测试乙')).toContainText('DeepSeek');
    await edit('模型测试乙');for(const part of ['a','b']){await editor.getByLabel('选择题目',{exact:true}).selectOption('3.1 / 40 / '+part);await editor.getByRole('button',{name:'已核对当前项',exact:true}).click();}await save();await confirm('模型测试乙');
    const text=await csv(av+'-'+bv);expect(text).toContain('"人工测试甲","'+expected+'"');expect(text).toContain('"模型测试乙","'+expected+'"');expect(text).toContain('"旧记录测试丙","9.8，漏1题"');expect(runtime.store.get('submissions',old.id)).toEqual(old);results.push({a:av,b:bv,csv:expected});
    if(av==='missing'&&bv==='missing'){await row('人工测试甲').getByRole('button',{name:'扣分点 2',exact:true}).click();await expect(row('人工测试甲').locator('.deduction-item')).toHaveCount(2);await expect(row('人工测试甲')).toContainText('3.1 / 40 / a');await page.screenshot({path:join(dir,'two-independent-deductions.png')});}
  }
  // Follow the same submission through correction and cancellation rather than appending deductions.
  await edit('人工测试甲');await verdict('a','missing');await verdict('b','correct');await save();await confirm('人工测试甲');expect(await csv('a-missing')).toContain('"人工测试甲","9.8，漏1题"');
  await edit('人工测试甲');await verdict('a','error');await save();await confirm('人工测试甲');expect(await csv('a-corrected-error')).toContain('"人工测试甲","9.9"');
  await edit('人工测试甲');await verdict('a','correct');await save();await confirm('人工测试甲');expect(await csv('a-deduction-cancelled')).toContain('"人工测试甲","10"');
  await edit('旧记录测试丙');await expect(editor).toContainText('这份旧评分仍按整题记录');await editor.screenshot({path:join(dir,'legacy-guidance.png')});await editor.getByRole('button',{name:'按当前题目重新人工评分',exact:true}).click();await expect(editor.getByLabel('选择题目',{exact:true}).locator('option')).toHaveCount(2);await verdict('a','correct');await verdict('b','correct');await save();await confirm('旧记录测试丙');expect(runtime.store.all<History>('history').some(h=>h.snapshot.grade?.model==='legacy-human'&&h.snapshot.manualReport==='旧人工报告')).toBe(true);
  await page.reload();for(const width of [1450,390]){await page.setViewportSize({width,height:1000});await expect.poll(()=>page.locator('body').evaluate(el=>el.scrollWidth)).toBe(width);await page.screenshot({path:join(dir,'list-'+width+'.png'),fullPage:true});}
  finalState=await state();ledger=runtime.store.all('ai_calls');expect(simulatedCalls).toBe(5);expect(errors).toEqual([]);writeFileSync(join(dir,'evidence.json'),JSON.stringify({results,simulatedCalls,externalPaidCalls:0,legacyPreservedUntilExplicitRestart:true,historyRetained:true},null,2));
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));runtime.close();}
if(finalState){const reopened=createApp(dir,{env:{},fetcher:async()=>{throw Error('No restart calls');}});try{expect(reopened.store.all('submissions')).toEqual(finalState.submissions);expect(reopened.store.all('ai_calls')).toEqual(ledger);}finally{reopened.close();}}
console.log('2.8 独立小问浏览器验收通过：人工与模拟AI五组状态、两个独立扣分项、CSV实际文件、改判/撤销、旧父题保留与明确重新人工评分、历史/费用/重启持久化、精简提示和390px。产物：'+dir);
