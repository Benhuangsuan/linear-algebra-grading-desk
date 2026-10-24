import {testDirectory} from '../tests/fixtures.js';
import {chromium,expect} from '@playwright/test';
import express from 'express';
import {once} from 'node:events';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {blankQuestion,type Assignment,type State,type Submission} from '../shared/domain.js';
import {courseConfig} from '../shared/course.js';
import type {AiCall,AiBatch} from '../shared/ai.js';

const dir=testDirectory('v2.2-selection-');
const calls:string[]=[];const gates=new Map<string,Promise<void>>();const releases:(()=>void)[]=[];
function hold(id:string){let release=()=>{};gates.set(id,new Promise<void>(r=>release=r));releases.push(release);return release;}
const runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential'},fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body)) as {model:string;messages:{content:{text?:string}[]}[]};
  const id=body.messages[2].content[0].text!.match(/当前随机提交标识 ([a-f0-9-]+)/)![1];calls.push(id);await gates.get(id);
  const text=body.messages[1].content[0].text!;const data=JSON.parse(text.slice(text.indexOf('{'))) as {units:{key:string;type:string}[]};
  return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows:data.units.map(q=>({key:q.key,type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}))})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:200}});
}});
runtime.app.use(express.static(resolve('dist')));runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));runtime.app.use(runtime.errorHandler);
const server=runtime.app.listen(3111,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:3111';
const executablePath=process.env.BROWSER_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>void d.accept());await page.route('https://**',route=>route.abort());
async function request<T>(path:string,data?:unknown,method=data?'POST':'GET'):Promise<T>{const r=await page.request.fetch(url+'/api'+path,{method,data});if(!r.ok())throw new Error(await r.text());return await r.json() as T;}
const state=()=>request<State>('/state');
const rows=page.getByTestId('submission-row');const row=(name:string)=>rows.filter({has:page.locator('.submission-name strong',{hasText:new RegExp('^'+name+'$')})});
const dialog=page.getByRole('dialog');
async function authorize(){await page.getByLabel('已核对本次扣分单元与规则').check();await page.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息').check();await page.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用').check();}
async function preview(count:number){await authorize();await page.getByRole('button',{name:'预估费用',exact:true}).click();await expect(dialog).toContainText('已预估 '+count+' 份');const warning=page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续');if(await warning.isVisible())await warning.check();}
async function close(){await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();}
async function start(){await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await expect(dialog).toContainText('已加入所选服务批次');}
async function focusSync(){await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}
async function done(id:string){await expect.poll(async()=>(await state()).submissions.find(s=>s.id===id)?.grade?.provider).toBe('deepseek');}
const pdf=await PDFDocument.create();pdf.addPage([300,400]).drawText('Synthetic mathematics only',{x:20,y:350});const bytes=Buffer.from(await pdf.save());
async function setup(title:string){
  const course=await request<{id:string}>('/courses',{name:'Synthetic course'});
  const a=await request<Assignment>('/assignments',{courseId:course.id,title,scope:'1.1',description:'',config:{...courseConfig([{...blankQuestion(),number:'7'}]),confirmed:true}});
  for(const name of ['Alpha','Beta','Gamma']){const r=await page.request.post(url+'/api/assignments/'+a.id+'/files',{multipart:{kind:'student',file:{name:name+'.pdf',mimeType:'application/pdf',buffer:bytes}}});expect(r.ok()).toBe(true);}
  const ss=(await state()).submissions.filter(s=>s.assignmentId===a.id);
  await request('/assignments/'+a.id+'/queue',{ids:ss.slice(1).map(s=>s.id),acknowledged:true,replaceDraft:true});
  await expect.poll(async()=>(await state()).submissions.filter(s=>s.assignmentId===a.id&&s.grade?.provider==='mock').length).toBe(2);
  await page.goto(url+'/?course='+course.id+'&assignment='+a.id);await expect(rows).toHaveCount(3);return {a,ss};
}
try{
  const first=await setup('2.2 sequential batches');const [a,b,c]=first.ss;
  const releaseA=hold(a.id);await row('Alpha').getByRole('checkbox').check();await page.getByRole('button',{name:'AI 批改已选（1）',exact:true}).click();await preview(1);await start();await close();
  await expect(row('Alpha').getByRole('checkbox')).not.toBeChecked();await expect(row('Alpha').getByRole('checkbox')).toBeDisabled();
  await row('Beta').getByRole('checkbox').check();await row('Gamma').getByRole('checkbox').check();releaseA();await done(a.id);
  await expect(row('Alpha').getByRole('checkbox')).not.toBeChecked();await expect(page.getByRole('button',{name:'AI 批改已选（2）',exact:true})).toBeVisible();
  await page.getByLabel('筛选状态').selectOption('ungraded');await expect(rows).toHaveCount(2);await expect(row('Alpha')).toHaveCount(0); // AI pending confirmation is already graded.
  await page.getByLabel('搜索学生').fill('Beta');await expect(rows).toHaveCount(1);await expect(page.getByRole('button',{name:'AI 批改已选（2）',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'清空选择',exact:true}).click();await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await expect(page.getByRole('button',{name:'AI 批改已选（1）',exact:true})).toBeVisible();
  await page.getByLabel('搜索学生').fill('');await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await expect(rows.locator('input:checked')).toHaveCount(2);
  await page.getByRole('button',{name:'AI 批改已选（2）',exact:true}).click();await expect(page.locator('.selected-submissions p')).toHaveCount(2);await expect(page.locator('.selected-submissions')).not.toContainText('Alpha');await preview(2);await close();
  await page.getByLabel('筛选状态').selectOption('all');await row('Alpha').getByRole('button',{name:'确认成绩',exact:true}).click();await expect(row('Alpha')).toHaveClass(/confirmed/);await expect(row('Alpha').getByRole('checkbox')).not.toBeChecked();
  await page.screenshot({path:join(dir,'after-confirmed-selection.png'),fullPage:true});
  await page.getByRole('button',{name:'清空选择',exact:true}).click();await page.getByLabel('筛选状态').selectOption('ungraded');await row('Beta').getByRole('checkbox').check();
  const releaseB=hold(b.id);await page.getByRole('button',{name:'AI 批改已选（1）',exact:true}).click();await preview(1);await start();await close();await row('Gamma').getByRole('checkbox').check();releaseB();await done(b.id);
  await expect(rows).toHaveCount(1);await expect(row('Gamma').getByRole('checkbox')).toBeChecked();await expect(page.getByRole('button',{name:'AI 批改已选（1）',exact:true})).toBeVisible();
  await page.screenshot({path:join(dir,'ungraded-after-beta.png'),fullPage:true});
  await page.getByRole('button',{name:'AI 批改已选（1）',exact:true}).click();await preview(1);await start();await done(c.id);await close();await expect(rows).toHaveCount(0);expect(calls).toEqual([a.id,b.id,c.id]);
  await page.getByLabel('筛选状态').selectOption('all');await expect(rows).toHaveCount(3);
  await row('Alpha').getByRole('button',{name:'更多操作 Alpha',exact:true}).click();await page.getByRole('button',{name:'修改评分',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
  await row('Alpha').getByRole('button',{name:'更多操作 Alpha',exact:true}).click();await page.getByRole('button',{name:'重新 AI 批改…',exact:true}).click();await expect(dialog).toContainText('可能产生新增费用');await expect(page.getByLabel('明确忽略已有结果缓存并重批（新增费用）')).toBeChecked();await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();await close();expect(calls).toHaveLength(3);
  // Another tab changes a selection while the dialog/old preview remains open.
  const second=await setup('2.2 stale selection');const [x,y,z]=second.ss;await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选（3）',exact:true}).click();await preview(3);
  const other=await browser.newPage();
  const manualResponse=await other.request.post(url+'/api/submissions/'+x.id+'/manual',{data:{}});const manual:Submission=await manualResponse.json();
  const graded=manual.review!.map(r=>({...r,recognition:'found',verdict:r.type==='completion_only'?'completed':'correct',deduction:0,reason:'',pages:[1],reviewed:true,needsReview:false}));
  const confirmed=await other.request.put(url+'/api/submissions/'+x.id+'/review',{data:{revision:manual.revision,rows:graded,manualReport:'',reportBase:'',confirm:true}});expect(confirmed.ok()).toBe(true);
  await expect(dialog).toContainText('Alpha（成绩已确认');await expect(page.locator('.selected-submissions p')).toHaveCount(2);await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();await expect(page.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用')).not.toBeChecked();expect(calls).toHaveLength(3);
  await page.screenshot({path:join(dir,'dialog-invalid-removed.png'),fullPage:true});await preview(2);await start();await close();await done(y.id);await done(z.id);await expect(page.getByRole('button',{name:'AI 批改已选',exact:true})).toBeVisible();expect(calls.slice(3)).toEqual([y.id,z.id]);
  // Completed human review is not ungraded; an untouched manual placeholder is.
  await page.getByLabel('筛选状态').selectOption('ungraded');await expect(rows).toHaveCount(0);
  const upload=await other.request.post(url+'/api/assignments/'+second.a.id+'/files',{multipart:{kind:'student',file:{name:'ManualDraft.pdf',mimeType:'application/pdf',buffer:bytes}}});expect(upload.ok()).toBe(true);
  await other.close();await focusSync();await expect(rows).toHaveCount(1);await row('ManualDraft').getByRole('checkbox').check();
  const draft=(await state()).submissions.find(s=>s.assignmentId===second.a.id&&s.studentName==='ManualDraft')!;
  const human=await request<Submission>('/submissions/'+draft.id+'/manual',{});await focusSync();await expect(rows).toHaveCount(1);
  await request('/submissions/'+draft.id+'/review',{revision:human.revision,rows:human.review!.map(r=>({...r,recognition:'found',verdict:'completed',deduction:0,reason:'',pages:[1],reviewed:true,needsReview:false})),manualReport:'',reportBase:'',confirm:false},'PUT');await focusSync();await expect(rows).toHaveCount(0);await expect(page.getByRole('button',{name:'AI 批改已选',exact:true})).toBeVisible();
  await page.getByLabel('筛选状态').selectOption('review');await expect(rows).toHaveCount(3); // two AI results + completed human draft
  // Deleting a selected submission must retain the other selection and report its cached display name.
  for(const name of ['DeleteOne','DeleteTwo']){const r=await page.request.post(url+'/api/assignments/'+second.a.id+'/files',{multipart:{kind:'student',file:{name:name+'.pdf',mimeType:'application/pdf',buffer:bytes}}});expect(r.ok()).toBe(true);}
  await focusSync();await page.getByLabel('筛选状态').selectOption('ungraded');await expect(rows).toHaveCount(2);await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选（2）',exact:true}).click();await preview(2);
  const deleting=(await state()).submissions.find(s=>s.assignmentId===second.a.id&&s.studentName==='DeleteOne')!;
  const deleted=await page.request.delete(url+'/api/files/'+deleting.fileId);expect(deleted.ok()).toBe(true);await expect(dialog).toContainText('DeleteOne（提交已删除）');await expect(page.locator('.selected-submissions p')).toHaveCount(1);await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();expect(calls).toHaveLength(5);await close();await expect(row('DeleteTwo').getByRole('checkbox')).toBeChecked();
  await page.getByRole('button',{name:'清空选择',exact:true}).click();const retained=(await state()).submissions.find(s=>s.assignmentId===second.a.id&&s.studentName==='DeleteTwo')!;await page.request.delete(url+'/api/files/'+retained.fileId);await focusSync();
  await page.getByLabel('筛选状态').selectOption('all');await row('ManualDraft').getByRole('button',{name:'更多操作 ManualDraft',exact:true}).click();await page.getByRole('button',{name:'删除作业',exact:true}).click();await expect(rows).toHaveCount(3);
  await page.reload();await expect(rows).toHaveCount(3);await expect(rows.locator('input:checked')).toHaveCount(0);
  // A delayed old /state response must not undo a newer in-app refresh.
  const stale=await state();let blocked=false;let firstRequest=true;let releaseStale=()=>{};const staleGate=new Promise<void>(r=>releaseStale=r);
  await page.route(url+'/api/state',async route=>{if(firstRequest){firstRequest=false;blocked=true;await staleGate;await route.fulfill({json:stale});}else await route.continue();});
  await focusSync();await expect.poll(()=>blocked).toBe(true);
  const racing=await page.request.post(url+'/api/assignments/'+second.a.id+'/files',{multipart:{kind:'student',file:{name:'RefreshRace.pdf',mimeType:'application/pdf',buffer:bytes}}});expect(racing.ok()).toBe(true);
  await focusSync();await expect(row('RefreshRace')).toHaveCount(1);const oldResponse=page.waitForResponse(url+'/api/state');releaseStale();await oldResponse;await expect(row('RefreshRace')).toHaveCount(1);
  const raceSubmission=(await state()).submissions.find(s=>s.assignmentId===second.a.id&&s.studentName==='RefreshRace')!;await page.request.delete(url+'/api/files/'+raceSubmission.fileId);await page.unroute(url+'/api/state');await focusSync();await expect(rows).toHaveCount(3);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(dir,'selection-mobile.png'),fullPage:true});
  expect(runtime.store.all<AiCall>('ai_calls').filter(c=>c.purpose==='grade').map(c=>c.submissionId)).toEqual(calls);expect(runtime.store.all<AiBatch>('ai_batches').every(b=>b.status==='completed')).toBe(true);expect(errors).toEqual([]);
  console.log('2.2 状态同步浏览器验收通过：不刷新连续批次、Mock/AI/人工/待确认筛选、搜索范围、残留选择清理、跨标签失效预估/重新授权、显式重批入口、刷新及390px；仅合成PDF和模拟API。输出：'+dir);
}finally{for(const release of releases)release();await browser.close();await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
