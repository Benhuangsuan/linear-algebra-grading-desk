import {chromium,expect} from '@playwright/test';
import express from 'express';
import {existsSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {batchHarness,mockPageResponse,mockGradeResponse,response} from '../tests/grading-batch-fixtures.js';
import type {AiCall} from '../shared/ai.js';

const h=await batchHarness({respond:(body,i,stage)=>i===2?new Response('',{status:500}):response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body))});
h.runtime.app.use(express.static(resolve('dist')));h.runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));
const executablePath=process.env.BROWSER_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1450,height:1000}}),errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());
const modal=page.getByRole('dialog'),rows=page.getByTestId('submission-row');
async function authorize(){await page.getByLabel('已核对本次计分题目与扣分规则').check();await page.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息').check();await page.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用').check();await modal.getByRole('button',{name:'预估费用',exact:true}).click();await expect(modal).toContainText('已预估',{timeout:60000});const warning=page.getByLabel('估算达到 ¥0.30，我已查看预算并确认继续');if(await warning.isVisible())await warning.check();}
try{
 await page.goto(h.base+'/?course='+h.assignment.courseId+'&assignment='+h.assignment.id);await expect(page).toHaveTitle(/2\.12\.0/);await expect(rows).toHaveCount(1);
 await rows.first().getByRole('checkbox').check();await page.getByRole('button',{name:'AI 批改已选（1）',exact:true}).click();await page.getByLabel('每份预算',{exact:true}).fill('0.01');await authorize();
 await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeDisabled();await expect(page.getByRole('status',{name:'下一步操作指引'})).toContainText('保守预估超过本次预算');expect(h.seen).toHaveLength(0);
 await page.getByLabel('每份预算',{exact:true}).fill('20');await page.getByLabel('批次预算',{exact:true}).fill('100');await authorize();await expect(modal).toContainText('共 6 页，已优化为');await expect(modal).toContainText('全部完成后');await page.screenshot({path:join(h.dir,'optimized-batch-preview.png'),fullPage:true});
 await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await h.wait();await expect.poll(()=>h.submission().status).toBe('failed');expect(h.seen).toHaveLength(2);expect(h.submission().grade).toBeNull();
 await expect(modal).toContainText('未处理页面不会视为漏做');await modal.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(rows.first()).toContainText('失败');const old=h.runtime.store.all<AiCall>('ai_calls');
 await page.reload();expect(h.seen).toHaveLength(2);await rows.first().getByRole('button',{name:'AI 重试',exact:true}).click();await page.getByLabel('每份预算',{exact:true}).fill('20');await page.getByLabel('批次预算',{exact:true}).fill('100');await authorize();await expect(modal).toContainText('将复用已成功的 1 批');await expect(modal).toContainText('未知用量预留');await expect(page.getByRole('button',{name:'开始真实批改',exact:true})).toBeEnabled();await page.getByRole('button',{name:'开始真实批改',exact:true}).click();await h.wait();await expect.poll(()=>h.submission().status).toBe('review');
 await modal.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(rows.first()).toContainText('9.8');expect(h.submission().grade!.rows[0].pages).toEqual([1,6]);expect(h.submission().grade!.rows[0].deduction).toBe(0);expect(h.submission().grade!.rows[1].deduction).toBe(.2);
 for(const call of old)expect(h.runtime.store.get('ai_calls',call.id)).toEqual(call);expect(h.seen.slice(2).some(s=>s.ids.includes(h.seen[0].ids[0]))).toBe(false);
 await page.reload();await expect(rows.first()).toContainText('9.8');await page.screenshot({path:join(h.dir,'recovered-cross-page-result.png'),fullPage:true});await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(h.dir,'mobile.png'),fullPage:true});expect(errors).toEqual([]);
 writeFileSync(join(h.dir,'browser-evidence.json'),JSON.stringify({passed:true,requests:h.seen.length,requestBodies:h.seen.map(s=>({stage:s.stage,bytes:s.bytes,views:s.ids})),originalPages:6,crossPageEvidence:[1,6],reusedSuccessfulBatch:true,oldLedgerUnchanged:true,paidRequests:0,errors},null,2));
 console.log('2.12 浏览器验收通过：预算拦截、优化分批提示、失败无成绩、刷新不重发、明确重试复用成功批、跨1/6页仅计一次、漏题只在全部成功后判定、账本保护、1450/390px；无真实API。输出：'+h.dir);
}finally{await browser.close();await h.close();}
