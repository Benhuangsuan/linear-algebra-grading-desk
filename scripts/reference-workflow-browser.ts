import {chromium,expect} from '@playwright/test';
import express from 'express';import {once} from 'node:events';
import {existsSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';
import {createApp} from '../server/app.js';import {courseConfig} from '../shared/course.js';
import {questionKey,type Assignment,type State} from '../shared/domain.js';
import {testDirectory,syntheticPdf} from '../tests/fixtures.js';import {styledReference} from '../tests/reference-fixtures.js';

const dir=testDirectory('reference-workflow-');let externalAttempts=0;
const runtime=createApp(dir,{env:{},fetcher:async()=>{externalAttempts++;throw Error('本测试禁止模型调用');}});
runtime.app.use(express.static(resolve('dist')));runtime.app.use(runtime.errorHandler);
const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const executablePath=process.env.BROWSER_PATH??['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if(!executablePath)throw Error('请设置 BROWSER_PATH');
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});
let dismissNext=false;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>{const dismiss=dismissNext;dismissNext=false;void(dismiss?d.dismiss():d.accept());});
async function request<T>(path:string,body?:unknown){const r=await page.request.fetch(url+'/api'+path,{method:body?'POST':'GET',data:body});expect(r.ok()).toBe(true);return await r.json() as T;}
const state=()=>request<State>('/state');const modal=page.getByRole('dialog',{name:'调整题目'});
const review=page.getByRole('dialog',{name:'检查整理出的题目'});
async function save(){const response=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/assignments/'));await page.getByRole('button',{name:'保存设置'}).click();expect((await response).status()).toBe(200);await expect(page.getByRole('button',{name:'保存设置'})).toBeEnabled();}
async function upload(name:string,buffer:Buffer){await page.getByLabel('添加文件',{exact:true}).setInputFiles({name,mimeType:'application/pdf',buffer});await expect(review).toBeVisible();}
async function adopt(){await review.getByRole('button',{name:'添加新发现的题目（推荐）',exact:true}).click();await expect(page.getByRole('status')).toContainText('尚未保存');}
async function edit32(){await page.locator('.question-disclosure>summary').click();await page.getByRole('button',{name:'调整 3.3 / 32',exact:true}).click();await modal.getByText(/题目对应的参考答案页面/).click();}
const ref31=await syntheticPdf('习题3.1\n2. 合成题干甲\n合成答案甲');
const ref32=await syntheticPdf('习题3.2\n2. 合成题干乙\n合成答案乙');
const ref33=await styledReference();let saved:unknown,calls:unknown;
try{
  const course=await request<{id:string}>('/courses',{name:'Synthetic workflow course'});
  const first=await request<Assignment>('/assignments',{courseId:course.id,title:'Import order one',scope:'3.1-3.3',description:'',config:courseConfig()});
  const open=(a:Assignment)=>page.goto(url+'/?course='+course.id+'&assignment='+a.id+'&tab=settings');
  await open(first);await upload('3.2 synthetic.pdf',ref32);
  await expect(review).toContainText('当前已有 0 道题');await review.getByRole('button',{name:'暂不添加，保持现有题目',exact:true}).click();
  expect((await state()).assignments[0].config.questions).toHaveLength(0);expect((await state()).files).toHaveLength(1);
  await page.getByRole('button',{name:'整理题目清单',exact:true}).click();await adopt();
  expect((await state()).assignments[0].config.questions).toHaveLength(0);await save();
  await page.locator('.question-disclosure>summary').click();await page.getByRole('button',{name:'调整 3.2 / 2',exact:true}).click();
  await modal.getByLabel('特殊说明',{exact:true}).fill('Synthetic teacher note');await modal.getByLabel('本单元错误扣分',{exact:true}).fill('0.3');
  await modal.getByRole('button',{name:'应用调整',exact:true}).click();await save();
  await upload('3.3 synthetic.pdf',ref33);await expect(review).toContainText('当前已有 1 道题');await expect(review).toContainText('7 道是新题');await expect(review).toContainText('3.3 synthetic.pdf（识别出 7 道题）');await adopt();await save();
  const f33=(await state()).files.find(f=>f.name==='3.3 synthetic.pdf')!,f32=(await state()).files.find(f=>f.name==='3.2 synthetic.pdf')!;
  await edit32();const existing=modal.locator('.reference-existing .reference-source');
  await expect(existing).toHaveCount(1);await expect(existing.first()).toContainText('3.3 synthetic.pdf · 第 1 页');
  await expect(modal.getByLabel('要添加的参考答案',{exact:true})).toHaveValue(f33.id);
  await modal.getByLabel('要添加的参考答案',{exact:true}).selectOption(f32.id);await modal.getByRole('button',{name:'应用调整',exact:true}).click();
  await expect(modal).toContainText('参考页选择还没有加入本题');await expect(existing).toHaveCount(1);
  dismissNext=true;await modal.getByRole('button',{name:'关闭',exact:true}).click();await expect(modal).toBeVisible();
  await modal.getByRole('button',{name:'取消本次选择',exact:true}).click();
  await modal.getByLabel('PDF 页码',{exact:true}).fill('2');await modal.getByLabel('添加的这页包含本题需要的图形',{exact:true}).uncheck();
  await modal.getByRole('button',{name:'添加这页作为题目参考',exact:true}).click();await expect(existing).toHaveCount(2);
  await modal.getByRole('button',{name:'应用调整',exact:true}).click();await expect(page.getByRole('status')).toContainText('尚未保存');
  await page.getByRole('button',{name:'调整 3.3 / 32',exact:true}).click();await modal.getByText(/题目对应的参考答案页面/).click();await expect(existing).toHaveCount(2);
  await existing.nth(1).getByRole('button',{name:'更换这页参考',exact:true}).click();await modal.getByLabel('要换成的参考答案',{exact:true}).selectOption(f32.id);await modal.getByLabel('PDF 页码',{exact:true}).fill('1');
  await modal.getByRole('button',{name:'确认更换这页参考',exact:true}).click();await expect(modal).toContainText('请先确认这页确实用于本题');
  await modal.getByLabel('我确认这页确实用于本题',{exact:true}).check();await modal.getByRole('button',{name:'确认更换这页参考',exact:true}).click();
  await modal.getByRole('button',{name:'应用调整',exact:true}).click();await save();await page.reload();await edit32();
  await expect(existing).toHaveCount(2);await expect(existing.nth(1)).toContainText('3.2 synthetic.pdf · 第 1 页');
  await existing.nth(1).getByRole('button',{name:'移除这页参考',exact:true}).click();await expect(existing).toHaveCount(1);
  await modal.getByLabel('PDF 页码',{exact:true}).fill('2');await modal.getByLabel('添加的这页包含本题需要的图形',{exact:true}).uncheck();await modal.getByRole('button',{name:'添加这页作为题目参考',exact:true}).click();
  await modal.getByRole('button',{name:'应用调整',exact:true}).click();await save();expect((await state()).files).toHaveLength(2);
  await upload('3.1 synthetic.pdf',ref31);await expect(review).toContainText('当前已有 8 道题');await expect(review).toContainText('1 道是新题');await expect(review).toContainText('8 道已在清单中');
  await review.getByText(/已有题目与新内容的比较/).click();await review.getByText('比较题干、参考解和参考页面',{exact:true}).click();
  await expect(review.getByText(/现有参考页：/)).toContainText('3.3 synthetic.pdf · 第 2 页');await expect(review.getByText(/这次整理的参考页：/)).toContainText('3.3 synthetic.pdf · 第 1 页');await expect(review.getByLabel('更新大题内容 3.3 / 32',{exact:true})).not.toBeChecked();await adopt();await save();
  const firstConfig=(await state()).assignments.find(a=>a.id===first.id)!.config;
  expect(firstConfig.questions).toHaveLength(9);expect(firstConfig.questions.find(q=>q.section==='3.2')?.notes).toBe('Synthetic teacher note');expect(firstConfig.questions.find(q=>q.section==='3.2')?.errorPenalty).toBe(.3);
  expect(firstConfig.questions.find(q=>q.number==='32')?.referenceSources).toEqual([{fileId:f33.id,page:1,graphic:true},{fileId:f33.id,page:2,graphic:false}]);
  const steps=page.locator('.reference-step');await expect(steps).toHaveCount(3);
  expect(await steps.evaluateAll(els=>els.every(e=>e.parentElement===els[0].parentElement))).toBe(true);
  expect(new Set(await steps.locator(':scope > summary').evaluateAll(els=>els.map(e=>getComputedStyle(e).fontSize+' '+getComputedStyle(e).fontWeight))).size).toBe(1);
  await page.getByLabel('要怎样从参考答案整理出题目？').selectOption('text');await page.getByText('整理参考答案',{exact:true}).click();await page.getByText('整理参考答案',{exact:true}).click();await expect(page.getByLabel('要怎样从参考答案整理出题目？')).toHaveValue('text');
  await page.getByLabel('要怎样从参考答案整理出题目？').selectOption('ai');const helper=page.getByRole('region',{name:'AI 辅助整理'});await expect(helper.getByRole('button',{name:'开始 AI 辅助整理'})).toBeDisabled();
  await page.getByLabel('添加文件',{exact:true}).setInputFiles({name:'Extra synthetic.pdf',mimeType:'application/pdf',buffer:ref31});await expect(page.getByText('文件已上传。请选择要交给 AI 整理的页面，再预估费用并决定是否开始。',{exact:true})).toBeVisible();await expect(review).toHaveCount(0);expect(externalAttempts).toBe(0);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(e=>e.scrollWidth)).toBe(390);await page.screenshot({path:join(dir,'workflow-mobile.png'),fullPage:true});await page.setViewportSize({width:1450,height:1000});
  const second=await request<Assignment>('/assignments',{courseId:course.id,title:'Import order two',scope:'3.1-3.3',description:'',config:courseConfig()});await open(second);
  for(const [name,bytes] of [['3.1 synthetic.pdf',ref31],['3.3 synthetic.pdf',ref33],['3.2 synthetic.pdf',ref32]] as const){await upload(name,bytes);await adopt();await save();}
  const secondConfig=(await state()).assignments.find(a=>a.id===second.id)!.config;expect(secondConfig.questions.map(questionKey).sort()).toEqual(firstConfig.questions.map(questionKey).sort());
  await page.screenshot({path:join(dir,'workflow-desktop.png'),fullPage:true});expect(errors).toEqual([]);expect(externalAttempts).toBe(0);expect(runtime.store.all('ai_calls')).toEqual([]);
  saved=runtime.store.all('assignments');calls=runtime.store.all('ai_calls');writeFileSync(join(dir,'workflow-evidence.json'),JSON.stringify({externalAttempts,sourcePersistence:true,importOrders:2,currentQuestions:9,layoutLevels:3},null,2));
}catch(e){await page.screenshot({path:join(dir,'failed.png'),fullPage:true});writeFileSync(join(dir,'failed-page.html'),await page.content());throw e;}
finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
const reopened=createApp(dir,{env:{},fetcher:async()=>{throw Error('must not call');}});try{expect(reopened.store.all('assignments')).toEqual(saved);expect(reopened.store.all('ai_calls')).toEqual(calls);}finally{reopened.close();}
console.log('2.6流程浏览器验收通过：分小节推荐、未添加提示、跨节确认、更换/移除、应用与保存、导入计数/不同顺序、人工规则保护、三级同级布局、无付费调用与重启保留。输出：'+dir);
