import {chromium,expect} from '@playwright/test';
import express from 'express';
import {existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {uxHarness} from '../tests/grading-ux-fixtures.js';
import type {StoredFile} from '../shared/domain.js';
import {gradesCsv} from '../server/grades-export.js';

const h=await uxHarness();await h.upload('student','SyntheticBroken.pdf');const broken=h.submissions()[1],file=h.runtime.store.get<StoredFile>('files',broken.fileId)!;writeFileSync(join(h.runtime.store.uploads,file.diskName),'broken synthetic PDF');
h.runtime.app.use(express.static(resolve('dist')));h.runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));
const executablePath=process.env.BROWSER_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage({viewport:{width:1450,height:1000}}),errors:string[]=[];let checks=0;
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/ai/check'))checks++;});await page.route('https://**',r=>r.abort());page.on('dialog',d=>d.accept());
const modal=page.getByRole('dialog'),rows=page.getByTestId('submission-row');
try{
  await page.goto(h.base+'/?course='+h.assignment.courseId+'&assignment='+h.assignment.id);await expect(page).toHaveTitle(/2\.13\.0/);await expect(rows).toHaveCount(2);
  await page.getByRole('button',{name:'选择当前可批改项',exact:true}).click();await page.getByRole('button',{name:'AI 批改已选（2）',exact:true}).click();await expect(modal.getByRole('button',{name:'预估费用',exact:true})).toHaveCount(0);
  const t=performance.now();await modal.getByRole('button',{name:'快速检查',exact:true}).click();await expect(modal).toContainText('已检查 2/2 份，可批改 1 份');const allMs=performance.now()-t;expect(h.seen).toHaveLength(0);
  await page.screenshot({path:join(h.dir,'partial-check-desktop.png'),fullPage:true});await page.getByRole('button',{name:'移出无法批改的文件（1）',exact:true}).click();await expect(modal).toContainText('本次已选 1 份');
  await modal.getByLabel('已核对本次计分题目与扣分规则').check();await modal.getByLabel('学生与参考 PDF 页面已去除姓名、学号等身份信息').check();await modal.getByLabel('同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用').check();
  await modal.getByRole('button',{name:'开始 AI 批改',exact:true}).click();await h.wait();expect(checks).toBe(1);expect(h.seen).toHaveLength(1);await modal.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(rows.first()).toContainText('9.9');expect(h.submissions()[1].grade).toBeNull();
  await rows.first().getByRole('button',{name:'扣分点 1',exact:true}).click();await rows.first().getByRole('button',{name:'解释这项扣分',exact:true}).click();await expect(modal).toContainText('你将行列式');expect(h.seen).toHaveLength(1);
  await modal.getByRole('button',{name:'向 AI 追问（可能收费）',exact:true}).click();await modal.getByLabel('追问内容').fill('为什么这里应相乘？');await modal.getByLabel('确认上述页面与追问已去除身份信息').check();await modal.getByLabel('授权本次云端追问，费用上限 ¥0.10；解释不自动改分').check();
  const before=structuredClone(h.submissions()[0]);await modal.getByRole('button',{name:'发送本次追问',exact:true}).click();await expect(modal).toContainText('AI 解释，供人工复核');await expect(modal).toContainText('应核对相乘的规则');expect(h.submissions()[0]).toEqual(before);expect(h.seen).toHaveLength(2);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(h.dir,'explanation-mobile.png'),fullPage:true});await page.setViewportSize({width:1450,height:1000});await modal.getByRole('button',{name:'关闭',exact:true}).last().click();
  await rows.first().getByRole('button',{name:'更多操作 SyntheticAlpha',exact:true}).click();await page.getByRole('button',{name:'修改评分',exact:true}).click();const key=h.submissions()[0].review![1].key;await modal.getByLabel('选择题目').selectOption(key);const csv=gradesCsv(h.submissions());await modal.getByLabel('助教备注（不扣分）').fill('这一问过程清楚');await modal.getByRole('button',{name:'保存评分',exact:true}).click();
  await expect(rows.first()).toContainText('助教备注（不扣分）：这一问过程清楚');await expect(rows.first()).toContainText('备注');expect(gradesCsv(h.submissions())).toBe(csv);expect(h.submissions()[0].review![1].deduction).toBe(0);
  await page.reload();await rows.first().getByRole('button',{name:'扣分点 2',exact:true}).click();await expect(rows.first()).toContainText('这一问过程清楚');await page.screenshot({path:join(h.dir,'note-desktop.png'),fullPage:true});
  await rows.first().getByRole('button',{name:'修改',exact:true}).nth(1).click();await modal.getByLabel('助教备注（不扣分）').fill('');await modal.getByRole('button',{name:'保存评分',exact:true}).click();await expect(rows.first().getByRole('button',{name:'扣分点 1',exact:true})).toBeVisible();await expect(rows.first()).not.toContainText('这一问过程清楚');expect(gradesCsv(h.submissions())).toBe(csv);
  await page.setViewportSize({width:390,height:1000});expect(await page.locator('body').evaluate(el=>el.scrollWidth)).toBe(390);await page.screenshot({path:join(h.dir,'results-mobile.png'),fullPage:true});expect(errors).toEqual([]);
  writeFileSync(join(h.dir,'ux-browser-evidence.json'),JSON.stringify({passed:true,allCheckMs:allMs,checkRequests:checks,modelRequests:h.seen.length,freeExplanationRequests:0,gradeUnchangedByExplanation:true,csvUnchangedByNote:true,brokenNeverQueued:true,errors},null,2));console.log('v2.13 browser passed: '+h.dir);
}finally{await browser.close();await h.close();}
