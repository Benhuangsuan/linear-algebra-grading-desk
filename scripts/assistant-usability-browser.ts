import {chromium,expect} from '@playwright/test';import express from 'express';import {once} from 'node:events';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {execFileSync} from 'node:child_process';
import {createApp} from '../server/app.js';import {manualGrade} from '../server/provider.js';import {testDirectory,syntheticPdf} from '../tests/fixtures.js';
import {courseConfig} from '../shared/course.js';import {blankQuestion,questionKey,type Assignment,type State,type Submission} from '../shared/domain.js';
import type {AiBatch} from '../shared/ai.js';import {APP_VERSION} from '../shared/version.js';

const dir=testDirectory('assistant-usability-browser-');const env:Record<string,string|undefined>={};const requests:string[]=[];
const runtime=createApp(dir,{env,fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests.push(JSON.stringify(body));const text=body.messages[1].content[0].text;const {units}=JSON.parse(text.slice(text.indexOf('{')));
  return Response.json({choices:[{message:{content:JSON.stringify({rows:units.map((q:{key:string;type:string})=>({key:q.key,type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',pages:[1],reason:'',reviewReason:''}))})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100}});
}});
runtime.app.use(express.static(resolve('dist')));runtime.app.use(runtime.errorHandler);
const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const executablePath=process.env.BROWSER_PATH??['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if(!executablePath)throw Error('请设置 BROWSER_PATH');
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});const errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>void d.accept());
await page.route('**/*',r=>new URL(r.request().url()).origin===url?r.continue():r.abort());
async function request<T>(path:string,body?:unknown,method=body?'POST':'GET'){const r=await page.request.fetch(url+'/api'+path,{method,data:body});expect(r.ok()).toBe(true);return await r.json() as T;}
const state=()=>request<State>('/state');const dialog=page.getByRole('dialog',{name:'AI 批改',exact:true});const guidance=page.getByRole('status',{name:'下一步操作指引'});
async function openAi(){await page.getByRole('button',{name:/^AI 批改已选/}).click();await expect(dialog).toContainText('deepseek-flash');}
async function closeAi(){await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();}
async function authorize(){for(const label of ['已核对本次计分题目与扣分规则','学生与参考 PDF 页面已去除姓名、学号等身份信息','同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用'])await dialog.getByLabel(label,{exact:true}).check();}
async function dimensions(){return page.locator('.reference-add .form-grid').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns,fields:Array.from(el.querySelectorAll('input,select')).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,height:r.height};})}));}
let saved:State|undefined;
try{
  const c=await request<{id:string}>('/courses',{name:'合成助教验收课程'});
  const q={...blankQuestion(),number:'2',kind:'true_false' as const,prompt:'Synthetic statements',answer:'Synthetic answers',subparts:['a','b','c'],children:['a','b','c'].map(label=>({id:label,label,confirmed:label==='c'}))};
  const a=await request<Assignment>('/assignments',{courseId:c.id,title:'合成可用性验收',scope:'1.1',description:'',config:{...courseConfig([q]),confirmed:true}});
  const pdf=await syntheticPdf('Synthetic page without identity');
  for(const [kind,name] of [['reference','1.1 synthetic.pdf'],['student','线代作业2+测试甲+0123456789.pdf']]){const r=await page.request.post(url+'/api/assignments/'+a.id+'/files',{multipart:{kind,file:{name,mimeType:'application/pdf',buffer:pdf}}});expect(r.status()).toBe(201);}
  await page.goto(url+'/?course='+c.id+'&assignment='+a.id);await expect(page).toHaveTitle('线代作业批改平台 '+APP_VERSION);await expect(page.locator('.sidebar-bottom')).toContainText(APP_VERSION);
  await expect(page.getByRole('button',{name:'模拟批改',exact:true})).toHaveCount(0);await expect(page.locator('.mode-pill')).toHaveCount(0);
  const row=page.getByTestId('submission-row');await expect(row).toContainText('学号：0123456789');
  await openAi();await expect(guidance).toContainText('尚未选择学生作业');await expect(guidance).toContainText('还有 2 个');await expect(dialog.getByRole('button',{name:'预估费用',exact:true})).toBeDisabled();await expect(dialog.getByRole('button',{name:'预估费用',exact:true})).toHaveAttribute('aria-describedby','ai-action-guidance');await closeAi();
  await row.getByRole('checkbox').check();await openAi();await expect(guidance).toContainText('还有 2 个');await guidance.getByRole('button',{name:'前往作业设置'}).click();
  await page.getByText('题目清单与扣分规则',{exact:true}).click();await page.getByTitle('调整 1.1 / 2',{exact:true}).click();const modal=page.getByRole('dialog',{name:'调整题目'});
  await modal.getByLabel('已核对全部小问',{exact:true}).check();await modal.getByText('题目对应的参考答案页面（0）',{exact:true}).click();
  await modal.getByLabel('要添加的参考答案',{exact:true}).selectOption({label:'1.1 synthetic.pdf'});
  const baselineCss=execFileSync('git',['--no-optional-locks','show','a696879:src/styles.css'],{encoding:'utf8',windowsHide:true});
  await page.locator('link[rel="stylesheet"]').evaluateAll(els=>els.forEach(e=>(e as HTMLLinkElement).disabled=true));const oldStyle=await page.addStyleTag({content:baselineCss});const before=await dimensions();await modal.locator('.reference-add').screenshot({path:join(dir,'reference-before.png')});await oldStyle.evaluate(el=>el.remove());await page.locator('link[rel="stylesheet"]').evaluateAll(els=>els.forEach(e=>(e as HTMLLinkElement).disabled=false));
  const desktop=await dimensions();expect(Math.abs(desktop.fields[0].y-desktop.fields[1].y)).toBeLessThan(1);expect(desktop.fields[0].height).toBe(desktop.fields[1].height);await modal.locator('.reference-add').screenshot({path:join(dir,'reference-after-desktop.png')});
  await page.setViewportSize({width:390,height:1000});const mobile=await dimensions();expect(mobile.fields[1].y).toBeGreaterThan(mobile.fields[0].y+mobile.fields[0].height);expect(mobile.fields[0].x).toBe(mobile.fields[1].x);await modal.locator('.reference-add').screenshot({path:join(dir,'reference-after-mobile.png')});
  await modal.getByLabel('添加的这页包含本题需要的图形',{exact:true}).uncheck();if(await modal.getByLabel('我确认这页确实用于本题',{exact:true}).isVisible())await modal.getByLabel('我确认这页确实用于本题',{exact:true}).check();
  await modal.getByRole('button',{name:'添加这页作为题目参考',exact:true}).focus();await page.keyboard.press('Enter');await expect(modal.getByText('已关联的参考页',{exact:true})).toBeVisible();await modal.getByRole('button',{name:'应用调整',exact:true}).click();await page.getByRole('button',{name:'保存设置'}).click();await expect.poll(async()=>(await state()).assignments[0].config.questions[0].children?.every(c=>c.confirmed)).toBe(true);
  await page.setViewportSize({width:1450,height:1000});await page.getByRole('button',{name:'学生作业',exact:true}).click();await row.getByRole('checkbox').check();await openAi();await expect(guidance).not.toContainText('未核对');await expect(guidance).toContainText('尚未配置');await expect(guidance).toContainText('尚未允许付费');await authorize();await expect(dialog.getByRole('button',{name:'预估费用',exact:true})).toBeDisabled();await closeAi();
  env.AI_ALLOW_PAID='true';env.DEEPSEEK_API_KEY='fixture-only';await openAi();await authorize();await expect(dialog.getByRole('button',{name:'预估费用',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'预估费用',exact:true}).click();await expect(dialog).toContainText('保守估算');await expect(dialog.getByRole('button',{name:'开始真实批改',exact:true})).toBeEnabled();
  await dialog.getByLabel('每份预算',{exact:true}).fill('0.6');await expect(guidance).toContainText('费用预估已失效');await expect(dialog.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'预估费用',exact:true}).click();await expect(dialog.getByRole('button',{name:'开始真实批改',exact:true})).toBeEnabled();await closeAi();
  const s=(await state()).submissions[0];const batch:AiBatch={id:'synthetic-paused',assignmentId:a.id,provider:'deepseek',configVersion:1,options:{ids:[s.id],provider:'deepseek',consent:true,deidentified:true,unitsConfirmed:true,perSubmissionBudget:.5,totalBudget:2,warningAcknowledged:true,regrade:false},status:'paused',items:[{submissionId:s.id,state:'queued',error:''}],createdAt:'2026-01-01',updatedAt:'2026-01-01'};runtime.store.putAi('ai_batches',batch);
  await openAi();await expect(guidance).toContainText('已有未结束的批次');await authorize();await expect(dialog.getByRole('button',{name:'预估费用',exact:true})).toBeDisabled();await dialog.getByText('批次与费用',{exact:true}).click();await dialog.getByRole('button',{name:'取消批次',exact:true}).click();await expect(guidance).not.toContainText('已有未结束的批次');await closeAi();
  await row.getByRole('button',{name:'修改学号 测试甲',exact:true}).click();const identity=page.getByRole('dialog',{name:'修改姓名与学号'});await identity.getByLabel('学号',{exact:true}).fill('123');await identity.getByRole('button',{name:'保存',exact:true}).click();await expect(identity.getByRole('alert')).toContainText('恰好 10 位数字');await identity.getByLabel('学号',{exact:true}).fill('0000000042');await identity.getByLabel('姓名',{exact:true}).fill('人工校对姓名');await identity.getByRole('button',{name:'保存',exact:true}).click();await expect(row).toContainText('学号：0000000042');await page.reload();await expect(row).toContainText('人工校对姓名');await expect(row).toContainText('0000000042');
  await row.getByRole('checkbox').check();await openAi();await authorize();await dialog.getByRole('button',{name:'预估费用',exact:true}).click();await expect(dialog).toContainText('保守估算');await dialog.getByRole('button',{name:'开始真实批改',exact:true}).click();await closeAi();await expect(row).toContainText('DeepSeek');await expect(row).toContainText('学号：0000000042');
  for(const body of requests){expect(body).not.toContain('0000000042');expect(body).not.toContain('studentId');expect(body).not.toContain('人工校对姓名');}expect(requests).toHaveLength(1);
  await row.getByRole('button',{name:'更多操作 人工校对姓名',exact:true}).click();await expect(page.getByRole('button',{name:'修改评分',exact:true})).toBeEnabled();await page.getByRole('button',{name:'修改评分',exact:true}).click();await expect(page.getByRole('dialog',{name:'修改评分 · 人工校对姓名'})).toBeVisible();await page.getByRole('button',{name:'取消',exact:true}).click();
  const historyUpload=await page.request.post(url+'/api/assignments/'+a.id+'/files',{multipart:{kind:'student',file:{name:'线代作业2-测试乙-0123456790.pdf',mimeType:'application/pdf',buffer:pdf}}});expect(historyUpload.status()).toBe(201);
  const historical=(await state()).submissions.at(-1)!;runtime.store.put('submissions',{...historical,status:'review',grade:{...manualGrade(a),provider:'mock',model:'synthetic-mock-history'}});await page.reload();await expect(row.last()).toContainText('模拟结果');await row.last().getByRole('button',{name:'更多操作 测试乙',exact:true}).click();await expect(page.getByRole('button',{name:'重新模拟批改',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'报告',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('模拟评分，未识别或批改 PDF');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();
  const check=await request<{version:string}>('/health');expect(check.version).toBe(APP_VERSION);saved=await state();await page.screenshot({path:join(dir,'students-desktop.png')});
  await page.setViewportSize({width:390,height:1000});await expect.poll(()=>page.locator('body').evaluate(e=>e.scrollWidth)).toBe(390);await expect(row.getByRole('button',{name:'修改学号 人工校对姓名'})).toBeVisible();await page.screenshot({path:join(dir,'students-mobile.png'),fullPage:true});
  writeFileSync(join(dir,'evidence.json'),JSON.stringify({version:APP_VERSION,before,desktop,mobile,capturedSimulatedRequests:requests.length,studentIdTransmitted:false,externalPaidCalls:0},null,2));expect(errors).toEqual([]);
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));runtime.close();}
if(saved){const reopened=createApp(dir,{env:{},fetcher:async()=>{throw Error('No calls on restart');}});try{expect(reopened.store.all<Submission>('submissions')).toEqual(saved.submissions);expect(reopened.store.all('ai_calls')).toHaveLength(1);}finally{reopened.close();}}
console.log('2.7 助教可用性浏览器验收通过：五类阻塞与解除、版本一致、参考页对齐/单列/键盘、普通模式隐藏模拟、人工评分、十位学号校验/修改/刷新/重启与模拟批改保留、请求不新增学号、390px。产物：'+dir);
