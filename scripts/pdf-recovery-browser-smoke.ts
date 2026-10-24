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
import type {AiBatch,AiCall} from '../shared/ai.js';

const dir=testDirectory('v2.4-browser-');const failIds=new Set<string>();const seen:{id:string;limit:number}[]=[];
const runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential',AI_MAX_OUTPUT_TOKENS:'8192'},fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const id=body.messages[2].content[0].text.match(/当前随机提交标识 ([a-f0-9-]+)/)[1];seen.push({id,limit:body.max_tokens});
  if(failIds.has(id)&&body.max_tokens===8192)return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'synthetic reasoning must not persist'},finish_reason:'length'}],usage:{prompt_tokens:5000,completion_tokens:8192}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const rules=JSON.parse(body.messages[1].content[0].text.slice(body.messages[1].content[0].text.indexOf('{')));
  if(id===[...failIds].at(-1)){expect(body.messages[2].content.filter(p=>p.type==='image_url')).toHaveLength(3);expect(JSON.stringify(body.messages[2])).toContain('原第 1 页 连续分区');expect(JSON.stringify(body.messages[2])).not.toContain('原第 2 页');}
  return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({rows:rules.units.map(q=>({key:q.key,type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1],reviewReason:''}))})},finish_reason:'stop'}],usage:{prompt_tokens:5000,completion_tokens:6000}});
}});
runtime.app.use(express.static(resolve('dist')));runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));runtime.app.use(runtime.errorHandler);
const server=runtime.app.listen(3113,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:3113';
const executablePath=process.env.BROWSER_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());
async function request<T>(path:string,data?:unknown):Promise<T>{const r=await page.request.fetch(url+'/api'+path,{method:data?'POST':'GET',data});if(!r.ok())throw new Error(await r.text());return await r.json() as T;}
const state=()=>request<State>('/state');const modal=page.getByRole('dialog');const rows=page.getByTestId('submission-row');
const units=page.getByLabel('已核对本次扣分单元与规则'),deidentified=page.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息'),consent=page.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用');
async function authorize(acknowledge=true){await units.check();await deidentified.check();await consent.check();await modal.getByRole('button',{name:'预估费用',exact:true}).click();await expect(modal).toContainText('已预估');const warning=page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续');if(acknowledge&&await warning.isVisible())await warning.check();}
async function finished(){await expect.poll(()=>runtime.store.all<AiBatch>('ai_batches').at(-1)?.status).toBe('completed');}
async function options(limit:number){const summary=modal.locator('summary').filter({hasText:'批改选项 · 输出额度'});if(!(await summary.locator('..').evaluate(el=>(el as HTMLDetailsElement).open)))await summary.click();await page.getByLabel('输出额度',{exact:true}).selectOption(String(limit));}
let savedCalls:AiCall[]=[];let savedSubmissions:Submission[]=[];
try{
  const course=await request<{id:string}>('/courses',{name:'合成批改恢复课程'});const assignment=await request<Assignment>('/assignments',{courseId:course.id,title:'五人批次与长页恢复',scope:'3.1',description:'',config:{...courseConfig(Array.from({length:20},(_,i)=>({...blankQuestion(),section:'3.1',number:String(i+1),answer:'Synthetic verified reference only.'}))),confirmed:true}});
  for(let i=0;i<5;i++){const pdf=await PDFDocument.create();const p=pdf.addPage(i===4?[816,1922.702]:[300,420]);for(let n=0;n<20;n++)p.drawText('Synthetic '+(n+1)+' [1 2; 0 1]',{x:20,y:p.getHeight()-30-n*(p.getHeight()-60)/20,size:11});const r=await page.request.post(url+'/api/assignments/'+assignment.id+'/files',{multipart:{kind:'student',file:{name:'Synthetic'+(i+1)+'.pdf',mimeType:'application/pdf',buffer:Buffer.from(await pdf.save())}}});expect(r.ok()).toBe(true);}
  const ss=(await state()).submissions;failIds.add(ss[2].id);failIds.add(ss[4].id);await page.goto(url+'/?course='+course.id+'&assignment='+assignment.id);await expect(rows).toHaveCount(5);
  await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选（5）',exact:true}).click();await authorize();await expect(modal).toContainText('1 个原页已本地整理为 3 幅');await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await finished();await modal.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(rows.nth(2)).toContainText('失败');await expect(rows.nth(4)).toContainText('失败');expect(seen).toHaveLength(5);
  const protectedResults=ss.filter(s=>!failIds.has(s.id)).map(s=>runtime.store.get('submissions',s.id));const originalCalls=runtime.store.all<AiCall>('ai_calls');await page.screenshot({path:join(dir,'five-two-failed.png'),fullPage:true});
  await rows.nth(4).getByRole('button',{name:'AI 重试',exact:true}).click();await expect(modal).toContainText('耗尽本次 8192 token');await expect(page.locator('.selected-submissions p')).toHaveCount(1);await options(8192);await authorize();await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeEnabled();
  await options(16384);await expect(units).not.toBeChecked();await expect(deidentified).not.toBeChecked();await expect(consent).not.toBeChecked();await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();expect(seen).toHaveLength(5);
  await page.getByLabel('每份预算',{exact:true}).fill('0.01');await authorize();await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await expect(modal).toContainText('保守估算超过本次预算');expect(seen).toHaveLength(5);await page.getByLabel('每份预算',{exact:true}).fill('0.5');await authorize();await page.screenshot({path:join(dir,'long-page-recovery-options.png'),fullPage:true});await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await finished();await modal.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(rows.nth(4)).toContainText('DeepSeek');expect(seen.at(-1)).toEqual({id:ss[4].id,limit:16384});expect(runtime.store.get<Submission>('submissions',ss[2].id)?.status).toBe('failed');
  await page.reload();await rows.nth(2).getByRole('checkbox').check();await page.getByRole('button',{name:'AI 批改已选（1）',exact:true}).click();await options(32768);await authorize(false);await expect(page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续')).toBeVisible();await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();await page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续').check();await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await finished();await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
  expect(seen).toHaveLength(7);expect(seen.at(-1)).toEqual({id:ss[2].id,limit:32768});expect(ss.filter(s=>!failIds.has(s.id)).map(s=>runtime.store.get('submissions',s.id))).toEqual(protectedResults);for(const call of originalCalls)expect(runtime.store.get('ai_calls',call.id)).toEqual(call);expect(runtime.store.get<Submission>('submissions',ss[4].id)!.grade!.rows.every(r=>r.pages.every(p=>p===1))).toBe(true);expect(errors).toEqual([]);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(dir,'mobile.png'),fullPage:true});savedCalls=runtime.store.all<AiCall>('ai_calls');savedSubmissions=runtime.store.all<Submission>('submissions');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
const reopened=createApp(dir,{env:{},fetcher:async()=>{throw new Error('must not call on restart');}});try{expect(reopened.store.all('ai_calls')).toEqual(savedCalls);expect(reopened.store.all('submissions')).toEqual(savedSubmissions);}finally{reopened.close();}
console.log('2.4 浏览器验收通过：五人两失败、单页连续分区/原页码、8192→16384/32768、额度变更撤销预估及授权、预算拦截、单人恢复及普通勾选恢复、成功者与旧账本保护、刷新/重启及390px。无真实API。输出：'+dir);
