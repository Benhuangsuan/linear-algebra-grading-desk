import {testDirectory} from '../tests/fixtures.js';
import {chromium,expect} from '@playwright/test';
import express from 'express';
import {once} from 'node:events';
import {existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {courseConfig,parseCourseMaterials} from '../shared/course.js';
import {childrenOf} from '../shared/questions.js';
import {unitConfig} from '../shared/units.js';
import {inspectFile} from '../server/files.js';
import type {Assignment,State,Submission} from '../shared/domain.js';
import type {AiCall,AiBatch} from '../shared/ai.js';

const dir=testDirectory('v2.3-browser-');const seen:string[]=[];let failId='';let failed=false;
const runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential'},fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body)) as {model:string;messages:{content:{text?:string}[]}[]};
  const id=body.messages[2].content[0].text!.match(/当前随机提交标识 ([a-f0-9-]+)/)![1];seen.push(id);
  const text=body.messages[1].content[0].text!;const rules=JSON.parse(text.slice(text.indexOf('{'))) as {units:{key:string;type:string;prompt:string;answer:string}[]};
  expect(rules.units).toHaveLength(2);expect(rules.units.every(q=>q.prompt.includes('矩阵'))).toBe(true);expect(rules.units[1].prompt).toContain('元素之和');expect(rules.units[1].answer).toContain('元素之积');
  const truncated=id===failId&&!failed;if(truncated)failed=true;
  return Response.json({model:body.model,choices:[{message:{content:truncated?'{"rows":[':JSON.stringify({rows:rules.units.map(q=>({key:q.key,type:q.type,recognition:'found',verdict:'correct',reason:'',pages:[1],reviewReason:''}))})},finish_reason:truncated?'length':'stop'}],usage:{prompt_tokens:1000,completion_tokens:truncated?8191:200}});
}});
runtime.app.use(express.static(resolve('dist')));runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));runtime.app.use(runtime.errorHandler);
const server=runtime.app.listen(3112,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:3112';
const executablePath=process.env.BROWSER_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}});const printer=await browser.newPage();
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>void d.accept());await page.route('https://**',route=>route.abort());
let savedAssignments:Assignment[]=[];let savedSubmissions:Submission[]=[];let savedCalls:AiCall[]=[];
async function request<T>(path:string,data?:unknown,method=data?'POST':'GET'):Promise<T>{const response=await page.request.fetch(url+'/api'+path,{method,data});if(!response.ok())throw new Error(await response.text());return await response.json() as T;}
const state=()=>request<State>('/state');const modal=page.getByRole('dialog');const rows=page.getByTestId('submission-row');
async function authorize(){await page.getByLabel('已核对本次计分题目与扣分规则').check();await page.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息').check();await page.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用').check();await page.getByRole('button',{name:'预估费用',exact:true}).click();await expect(modal).toContainText('已预估');const warning=page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续');if(await warning.isVisible())await warning.check();}
function html(color:string,crossPage:boolean){return '<html><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei",sans-serif;font-size:16px}p{line-height:1.5;margin:10px 0}.answer{color:'+color+';margin-left:37px}.b{margin-left:3px;'+(crossPage?'break-before:page;':'')+'}</style><body><p>习题 3.1 参考答案</p><p>40. 设矩阵 M=diag(2,3)，判断下列命题</p><p>a. det M 等于 6</p><p class="answer">对，两个对角元素相乘得到 6。</p><p class="b">b. det M 等于 5（合成的元素之和命题）</p><p class="answer">错，行列式是元素之积，不是元素之和。</p></body></html>';}
try{
  let reference:Buffer=Buffer.alloc(0);
  for(const [color,crossPage] of [['red',true],['black',false],['#2244aa',true]] as const){
    await printer.setContent(html(color,crossPage));const bytes=await printer.pdf({format:'A4',printBackground:true});
    const info=await inspectFile(bytes,'synthetic-reference.pdf',false);const q=parseCourseMaterials([info.text],'3.1').find(q=>q.number==='40')!;expect(childrenOf(q)).toHaveLength(2);expect(childrenOf(q)[0].answer).toMatch(/^对/);expect(childrenOf(q)[1].answer).toContain('元素之积');expect(childrenOf(q)[1].prompt).toContain('元素之和');if(color==='red')reference=bytes;
  }
  writeFileSync(join(dir,'synthetic-reference.pdf'),reference);
  const course=await request<{id:string}>('/courses',{name:'合成可靠性课程'});let assignment=await request<Assignment>('/assignments',{courseId:course.id,title:'2.3 本地解析与失败恢复',scope:'3.1',description:'',config:courseConfig([])});
  await page.goto(url+'/?course='+course.id+'&assignment='+assignment.id+'&tab=settings');await page.getByLabel('添加文件',{exact:true}).setInputFiles(join(dir,'synthetic-reference.pdf'));await expect(page.getByRole('dialog',{name:'检查整理出的题目'})).toContainText('本次共整理出 1 道');await page.getByRole('button',{name:'添加新发现的题目（推荐）',exact:true}).click();await expect(page.getByRole('status')).toContainText('尚未保存');await page.getByRole('button',{name:'保存设置'}).click();
  await expect.poll(async()=>(await state()).assignments.find(a=>a.id===assignment.id)?.version).toBe(2);
  // Unchecked subparts still block grading; do not weaken the existing integrity gate.
  await page.getByRole('button',{name:'学生作业',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选',exact:true}).click();await expect(modal).toContainText('候选小问尚未核对');await expect(page.getByRole('button',{name:'预估费用',exact:true})).toBeDisabled();await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.getByRole('button',{name:'作业设置',exact:true}).click();await page.locator('.question-disclosure>summary').click();await page.getByRole('button',{name:'调整 3.1 / 40',exact:true}).click();
  const child=page.locator('.child-editor-item');await child.nth(0).getByText('小问内容与个别扣分',{exact:true}).click();await expect(child.nth(0).getByLabel('小问题干（可选）')).toHaveValue(/等于 6/);await expect(child.nth(0).getByLabel('小问参考解（可选）')).toHaveValue(/^对/);
  await child.nth(0).getByLabel('小问题干（可选）').fill('人工核对：det M 等于 6');await child.nth(0).getByLabel('小问参考解（可选）').fill('对。人工核对乘积为 6。');await page.getByLabel('已核对全部小问',{exact:true}).check();await page.getByRole('button',{name:'应用调整',exact:true}).click();await page.getByRole('button',{name:'保存设置'}).click();
  await expect.poll(async()=>(await state()).assignments.find(a=>a.id===assignment.id)?.version).toBe(3);await page.reload();await page.getByRole('button',{name:'整理题目清单',exact:true}).click();await page.getByRole('button',{name:'暂不添加，保持现有题目',exact:true}).click();await page.getByRole('button',{name:'保存设置'}).click();
  assignment=(await state()).assignments.find(a=>a.id===assignment.id)!;expect(childrenOf(assignment.config.questions[0])[0].prompt).toContain('人工核对');
  // Simulate an old 2.2 mixed-content configuration, then adopt corrected content explicitly.
  const oldConfig={...assignment.config,questions:assignment.config.questions.map(q=>({...q,children:childrenOf(q).map(c=>({...c,prompt:'',answer:c.sourceText??'',confirmed:true}))}))};
  assignment=await request('/assignments/'+assignment.id,{...assignment,config:oldConfig,regradeUnconfirmed:false},'PUT');await page.reload();await page.getByRole('button',{name:'整理题目清单',exact:true}).click();
  await modal.getByText(/已有题目与新内容的比较/).click();
  for(const label of ['a','b']){await modal.getByText('3.1 / 40 / '+label+' 内容差异',{exact:true}).click();await page.getByLabel('更新小问内容 3.1 / 40 / '+label,{exact:true}).check();}
  await page.getByRole('button',{name:'采用勾选的修改',exact:true}).click();await page.locator('.question-disclosure>summary').click();await page.getByRole('button',{name:'调整 3.1 / 40',exact:true}).click();await child.nth(1).getByText('小问内容与个别扣分',{exact:true}).click();await expect(child.nth(1).getByLabel('小问题干（可选）')).toHaveValue(/元素之和/);await expect(child.nth(1).getByLabel('小问参考解（可选）')).toHaveValue(/元素之积/);await expect(page.getByLabel('已核对全部小问',{exact:true})).not.toBeChecked();
  await child.nth(1).getByLabel('小问参考解（可选）').scrollIntoViewIfNeeded();await page.screenshot({path:join(dir,'split-fields.png'),fullPage:true});await page.getByLabel('已核对全部小问',{exact:true}).check();await page.getByRole('button',{name:'应用调整',exact:true}).click();await page.getByRole('button',{name:'保存设置'}).click();await expect.poll(async()=>{const a=(await state()).assignments.find(a=>a.id===assignment.id)!;try{return unitConfig(a.config).questions.length;}catch{return 0;}}).toBe(2);
  const pdf=await PDFDocument.create();pdf.addPage([300,400]).drawText('Synthetic student only',{x:20,y:350});const student=Buffer.from(await pdf.save());
  for(const name of ['线代作业5-SyntheticAlpha-23000001.pdf','线代作业 5 - SyntheticBeta.pdf']){const r=await page.request.post(url+'/api/assignments/'+assignment.id+'/files',{multipart:{kind:'student',file:{name,mimeType:'application/pdf',buffer:student}}});expect(r.ok()).toBe(true);}
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('button',{name:'学生作业',exact:true}).click();await expect(rows).toHaveCount(2);await expect(rows.nth(0).locator('.submission-name strong')).toHaveText('SyntheticAlpha');await expect(rows.nth(1).locator('.submission-name strong')).toHaveText('SyntheticBeta');
  const ss=(await state()).submissions.filter(s=>s.assignmentId===assignment.id);failId=ss[1].id;
  await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选（2）',exact:true}).click();await authorize();await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await expect.poll(()=>runtime.store.all<AiBatch>('ai_batches').at(-1)?.status).toBe('completed');await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
  await expect(rows.nth(1)).toContainText('失败');expect(seen).toEqual([ss[0].id,ss[1].id]);const protectedFirst=runtime.store.get<Submission>('submissions',ss[0].id)!;const failedCall=runtime.store.all<AiCall>('ai_calls').at(-1)!;
  await page.screenshot({path:join(dir,'batch-one-failed.png'),fullPage:true});await page.reload();await rows.nth(1).getByRole('button',{name:'AI 重试',exact:true}).click();await expect(modal).toContainText('可能产生新增费用');await expect(page.locator('.selected-submissions p')).toHaveCount(1);await expect(page.locator('.selected-submissions')).toContainText('SyntheticBeta');await modal.getByText('批次与费用',{exact:true}).click();await expect(modal).toContainText('output_limit');await expect(modal).toContainText('结束 length');await expect(modal).toContainText('HTTP 200');
  await modal.getByText(/结束 length/).scrollIntoViewIfNeeded();await page.screenshot({path:join(dir,'single-retry-diagnostics.png'),fullPage:true});await authorize();await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await expect.poll(()=>runtime.store.get<Submission>('submissions',failId)?.grade?.provider).toBe('deepseek');await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
  expect(seen).toEqual([ss[0].id,ss[1].id,ss[1].id]);expect(runtime.store.get('submissions',ss[0].id)).toEqual(protectedFirst);expect(runtime.store.get('ai_calls',failedCall.id)).toEqual(failedCall);expect(errors).toEqual([]);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(dir,'mobile.png'),fullPage:true});
  await page.setViewportSize({width:1450,height:1000});
  const ambiguous=await request<Assignment>('/assignments',{courseId:course.id,title:'合成模糊片段',scope:'3.1',description:'',config:courseConfig(parseCourseMaterials(['习题3.1\n40.判断正误\na. 对称矩阵是否满足条件\n对称条件需要讨论\nb. 解释对与错的关系\n未提供标准判断'],'3.1'))});
  await page.goto(url+'/?course='+course.id+'&assignment='+ambiguous.id+'&tab=settings');await page.locator('.question-disclosure>summary').click();await page.getByRole('button',{name:'调整 3.1 / 40',exact:true}).click();await child.nth(0).getByText('小问内容与个别扣分',{exact:true}).click();
  await expect(modal).toContainText('未能可靠分离命题与参考判断');await expect(child.nth(0).getByLabel('小问题干（可选）')).toHaveValue('');await expect(child.nth(0).getByLabel('小问参考解（可选）')).toHaveValue('');await expect(page.getByLabel('已核对全部小问',{exact:true})).not.toBeChecked();
  await child.nth(0).getByText('原始提取片段',{exact:true}).click();await expect(child.nth(0)).toContainText('对称条件需要讨论');await page.screenshot({path:join(dir,'ambiguous-reference.png'),fullPage:true});
  await child.nth(0).getByLabel('小问题干（可选）').fill('人工核对的命题');await child.nth(0).getByLabel('小问参考解（可选）').fill('人工核对的参考判断');await page.getByRole('button',{name:'应用调整',exact:true}).click();await page.getByRole('button',{name:'保存设置'}).click();
  await expect.poll(async()=>childrenOf((await state()).assignments.find(a=>a.id===ambiguous.id)!.config.questions[0])[0].prompt).toBe('人工核对的命题');
  expect(errors).toEqual([]);savedAssignments=runtime.store.all<Assignment>('assignments');savedSubmissions=runtime.store.all<Submission>('submissions');savedCalls=runtime.store.all<AiCall>('ai_calls');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
const reopened=createApp(dir,{env:{},fetcher:async()=>{throw new Error('must not call on restart');}});
try{expect(reopened.store.all('assignments')).toEqual(savedAssignments);expect(reopened.store.all('submissions')).toEqual(savedSubmissions);expect(reopened.store.all('ai_calls')).toEqual(savedCalls);}finally{reopened.close();}
console.log('2.3 浏览器验收通过：合成中文PDF的颜色/缩进/跨页、字段分离/人工保存/显式重整/模糊片段提示/校对门禁、新文件名、双人部分失败/仅重试一份/费用诊断/刷新、服务重启及窄屏。无真实API调用。输出：'+dir);
