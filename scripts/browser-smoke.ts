import {syntheticReferences} from '../tests/fixtures.js';
import { chromium, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { summarize, deductionRows, type State } from '../shared/domain.js';

const work=resolve('codex输出/codex工作区');mkdirSync(work,{recursive:true});
const dataDir=mkdtempSync(join(work,'stage2-browser-'));const port=3108;const url=`http://127.0.0.1:${port}`;
const pdf=await PDFDocument.create();for(let i=0;i<3;i++)pdf.addPage([450,640]).drawText(`Synthetic homework / page ${i+1}`,{x:35,y:570,size:23});
const bytes=await pdf.save();
const fixtures=['测试甲-2600010001.pdf','测试乙-2600010002.pdf','Re_9.9作业_测试同学（人工批改参考文件）.pdf'].map(name=>{const path=join(dataDir,name);writeFileSync(path,bytes);return path;});
let proc:ChildProcess|undefined;
async function start(){proc=spawn(process.execPath,['build/server/index.js'],{cwd:process.cwd(),env:{...process.env,AI_ALLOW_PAID:'false',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',PORT:String(port),DATA_DIR:dataDir,AI_PROVIDER:'mock'},windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';proc.stdout?.on('data',b=>logs+=String(b));proc.stderr?.on('data',b=>logs+=String(b));for(let i=0;i<100;i++){if(proc.exitCode!==null)throw new Error(logs);try{if((await fetch(url+'/api/health')).ok)return;}catch(e){if(i===99)throw e;}await new Promise(r=>setTimeout(r,100));}throw new Error(logs);}
async function stop(){if(proc&&proc.exitCode===null){const child=proc;await new Promise<void>(done=>{child.once('exit',()=>done());child.kill();});}}
const executable=process.env.BROWSER_PATH??['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if(!executable)throw new Error('未找到 Chrome / Edge，请设置 BROWSER_PATH。');
await start();const browser=await chromium.launch({executablePath:executable,headless:true});
const page=await browser.newPage({viewport:{width:1450,height:1000}});const errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('dialog',d=>void d.accept());
const getState=async()=>await page.request.get(url+'/api/state').then(r=>r.json()) as State;
try {
  await page.goto(url);await page.getByRole('button',{name:'新增课程',exact:true}).click();await page.getByLabel('课程名称').fill('线性代数与几何');await page.getByRole('button',{name:'保存课程'}).click();
  await page.getByRole('button',{name:'新建作业',exact:true}).click();await page.getByLabel('作业名称').fill('第 1 次作业');await page.getByLabel('作业范围').fill('1.1-1.3');await page.getByRole('button',{name:'创建作业',exact:true}).click();
  await page.getByLabel('添加文件',{exact:true}).setInputFiles((await syntheticReferences()).map(f=>({...f,mimeType:'application/pdf'})));
  await expect(page.locator('.material-row')).toHaveCount(3,{timeout:20000});await expect(page.getByRole('dialog',{name:'检查整理出的题目'})).toContainText('本次共整理出 19 道');await page.getByRole('button',{name:'添加新发现的题目（推荐）',exact:true}).click();await expect(page.getByRole('status')).toContainText('尚未保存');
  await page.getByRole('button',{name:'保存设置'}).click();
  await expect.poll(async()=>(await getState()).assignments[0].config.confirmed).toBe(true);
  const a=(await getState()).assignments[0];if(a.config.questions.length!==19)throw new Error('题号生成不完整');
  await page.getByRole('button',{name:'学生作业',exact:true}).click();await page.getByLabel('上传作业',{exact:true}).setInputFiles(fixtures);
  const rows=page.getByTestId('submission-row');await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).locator('.submission-name strong')).toHaveText('测试同学');
  await page.getByRole('button',{name:'模拟批改',exact:true}).first().click();await page.getByRole('button',{name:'开始模拟',exact:true}).click();
  await expect.poll(async()=>(await getState()).submissions.filter(s=>s.status==='review').length).toBe(3);
  await expect(rows.first().getByRole('button',{name:'确认成绩'})).toBeVisible();
  await expect(page.locator('canvas, iframe, img')).toHaveCount(0);await expect(page.locator('.deduction-item')).toHaveCount(0);
  await page.screenshot({path:join(work,'stage2-学生作业列表.png')});
  await rows.first().getByRole('button',{name:/扣分点/}).click();
  const s=(await getState()).submissions[0];const affected=deductionRows(s.grade!.config,s.review!).filter(r=>(r.deduction??0)>0||r.deduction===null||r.recognition==='uncertain');
  await expect(rows.first().locator('.deduction-item')).toHaveCount(affected.length);
  await rows.first().getByRole('button',{name:'更多操作 测试甲',exact:true}).click();await page.getByRole('button',{name:'修改评分',exact:true}).click();
  await page.getByLabel('选择题目',{exact:true}).selectOption('1.1 / 34');await page.getByLabel('评分判定').selectOption('error');await page.getByLabel('错误处数').fill('2');await page.getByLabel('扣分原因').fill('第 a、c 小问判断错误。');await page.getByLabel('证据页码',{exact:true}).fill('2,3');await page.getByLabel('证据页码',{exact:true}).blur();
  await page.getByRole('button',{name:'保存评分',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  let saved=(await getState()).submissions[0];if(saved.review!.find(r=>r.key==='1.1 / 34')!.deduction!==.2)throw new Error('错误处数扣分不符');
  await expect(rows.first().locator('.submission-score strong')).toHaveText(String(summarize(saved.grade!.config,saved.review!).score));
  const item=rows.first().locator('.deduction-item').filter({hasText:'1.1 / 34'});await expect(item).toContainText('−0.2');
  const evidence=item.getByRole('link',{name:/第 2 页/});await expect(evidence).toHaveAttribute('target','_blank');await expect(evidence).toHaveAttribute('href',/#page=2$/);
  await item.getByRole('button',{name:'修改',exact:true}).click();await page.getByLabel('评分判定').selectOption('correct');await page.getByRole('button',{name:'保存评分'}).click();await expect(rows.first().locator('.deduction-item').filter({hasText:'1.1 / 34'})).toHaveCount(0);
  await rows.first().getByRole('button',{name:'确认成绩'}).click();await expect(rows.first()).toHaveClass(/confirmed/);await expect(rows.first().getByRole('button',{name:'确认成绩'})).toHaveCount(0);
  // Mock omissions are at indices 3, 10, 17; remaining errors at 1 and 16.
  // After correcting 1.1/34: 10 - 3*0.2 - 2*0.1 = 9.2, with 3 distinct omissions.
  await expect(rows.first().locator('.submission-score strong')).toHaveText('9.2');
  await page.getByRole('button',{name:'作业列表操作',exact:true}).click();
  const pendingDownload=page.waitForEvent('download');
  await page.getByRole('link',{name:'导出成绩',exact:true}).click();
  const download=await pendingDownload;const csvPath=join(dataDir,'grades.csv');await download.saveAs(csvPath);
  expect(download.suggestedFilename()).toBe('grades.csv');
  expect(readFileSync(csvPath,'utf8')).toBe('\uFEFF"姓名","成绩"\r\n"测试甲","9.2分，漏3题"\r\n"测试乙","待确认"\r\n"测试同学","待确认"');
  await rows.nth(1).getByRole('button',{name:'更多操作 测试乙'}).click();await page.getByRole('button',{name:'报告',exact:true}).click();await page.getByLabel('补充报告').fill('这是一份独立保存的人工反馈。');await page.getByRole('button',{name:'保存报告'}).click();
  await rows.nth(1).getByRole('button',{name:'更多操作 测试乙'}).click();await page.getByRole('button',{name:'重新模拟批改'}).click();await page.getByRole('button',{name:'开始模拟'}).click();
  await expect.poll(async()=>(await getState()).submissions[1].status).toBe('review');
  if((await getState()).submissions[1].manualReport!=='这是一份独立保存的人工反馈。')throw new Error('重批覆盖了手工报告');
  await expect(rows.nth(1).getByRole('button',{name:'确认成绩'})).toBeVisible();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(work,'stage2-展开扣分点.png')});
  const address=page.url();await page.reload();await expect(page.getByRole('heading',{name:'第 1 次作业',exact:true})).toBeVisible();await expect(rows).toHaveCount(3);if(page.url()!==address)throw new Error('刷新后路由丢失');
  await stop();await start();await page.reload();await expect(rows.first()).toHaveClass(/confirmed/);await expect(rows).toHaveCount(3);
  for(const width of [700,390]){await page.setViewportSize({width,height:1000});await expect.poll(()=>page.locator('body').evaluate(el=>el.scrollWidth)).toBe(width);}
  await page.screenshot({path:join(work,'stage2-窄屏列表.png'),fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('第2阶段兼容 浏览器验收通过：PDF 参考答案自动整理 19 题、每人一行、默认隐藏正确题与原稿、扣分修改/撤销、一次确认、独立报告、刷新与重启保留、窄屏；无控制台错误。');
}finally{await browser.close();await stop();}
