import {referenceTexts,syntheticDocx} from '../tests/fixtures.js';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {ignoreDevelopmentPath} from '../server/watch-policy.js';

const work=resolve('codex输出/codex工作区');mkdirSync(work,{recursive:true});
const folder=mkdtempSync(join(work,'stage2-dev-'));const lockedPath=join(folder,'mso369B.tmp');
const lockScript=join(folder,'hold-lock.ps1');
writeFileSync(lockScript,'param([string]$Path)\n$heldStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)\n[Console]::Out.WriteLine("LOCKED")\n[Console]::Out.Flush()\nStart-Sleep -Seconds 30\n$heldStream.Dispose()\n');
const lock=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',lockScript,lockedPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let lockReady=false;lock.stdout?.on('data',b=>{if(String(b).includes('LOCKED'))lockReady=true;});
for(let i=0;i<50&&!lockReady;i++){if(lock.exitCode!==null)throw new Error('锁定测试文件失败');await new Promise(r=>setTimeout(r,100));}
if(!lockReady)throw new Error('锁定文件超时');
let denied=false;try{readFileSync(lockedPath);}catch(e){denied=e instanceof Error&&'code'in e&&['EBUSY','EPERM','EACCES'].includes(String(e.code));}
if(!denied)throw new Error('测试文件没有获得独占锁');
if(!ignoreDevelopmentPath(process.cwd(),lockedPath)||!ignoreDevelopmentPath(process.cwd(),resolve('人工批改参考/作业批改参考答案/mso369B.tmp')))throw new Error('监听策略未排除 Word 临时文件');
const expectedVersion=JSON.parse(readFileSync(resolve('package.json'),'utf8')).version as string;
const port=3109;const url=`http://127.0.0.1:${port}`;
const dev=spawn('cmd.exe',['/d','/s','/c','npm.cmd run dev'],{cwd:process.cwd(),env:{...process.env,ENABLE_MOCK_UI:'true',AI_ALLOW_PAID:'false',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',PORT:String(port),DATA_DIR:join(folder,'data'),AI_PROVIDER:'mock'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';dev.stdout?.on('data',b=>logs+=String(b));dev.stderr?.on('data',b=>logs+=String(b));
const executable=process.env.BROWSER_PATH??['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
async function killTree(child:ChildProcess){if(child.exitCode!==null||!child.pid)return;await new Promise<void>((done,reject)=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},error=>error&&child.exitCode===null?reject(error):done()));}
try{
  for(let i=0;i<120;i++){if(dev.exitCode!==null)throw new Error(logs);try{if((await fetch(url+'/api/health')).ok)break;}catch(e){if(i===119)throw e;}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:executable,headless:true});const page=await browser.newPage({viewport:{width:1400,height:950}});const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url);await expect(page).toHaveTitle('线代作业批改平台 '+expectedVersion);await page.getByRole('button',{name:'新增课程'}).click();await page.getByLabel('课程名称').fill('开发稳定性测试');await page.getByRole('button',{name:'保存课程'}).click();
  await page.getByRole('button',{name:'新建作业',exact:true}).click();await page.getByLabel('作业名称').fill('临时文件与刷新回归');await page.getByLabel('作业范围').fill('1.1-1.3');await page.getByRole('button',{name:'创建作业'}).click();
  await page.getByLabel('添加文件',{exact:true}).setInputFiles(referenceTexts.map((text,i)=>({name:`synthetic-${i+1}.docx`,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:syntheticDocx(text)})));
  await expect(page.getByRole('dialog',{name:'检查整理出的题目'})).toContainText('本次共整理出 19 道');await page.getByRole('button',{name:'添加新发现的题目（推荐）',exact:true}).click();await expect(page.getByRole('status')).toContainText('尚未保存');await page.getByRole('button',{name:'保存设置'}).click();await page.getByRole('button',{name:'学生作业',exact:true}).click();
  const address=page.url();
  for(let i=0;i<5;i++){
    await page.reload();await expect(page.getByRole('heading',{name:'临时文件与刷新回归',exact:true})).toBeVisible();if(page.url()!==address)throw new Error('刷新后地址变化');
    const health=await page.request.get(url+'/api/health').then(r=>r.json());if(health.version!==expectedVersion)throw new Error('服务未响应');
    writeFileSync(join(folder,`upload-cache-${i}.tmp`),'ignored temporary data');
  }
  await page.getByRole('button',{name:'作业设置',exact:true}).click();await page.screenshot({path:join(work,'stage2-作业设置.png'),fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  if(/EBUSY|resource busy or locked|Emitted 'error'/.test(logs))throw new Error(logs);
  if(logs.split('线代作业批改平台 '+expectedVersion).length-1!==1)throw new Error('数据写入触发了服务重启：'+logs);
  console.log('第2阶段兼容 开发稳定性测试通过：真实 Windows 独占文件锁、三份 DOCX 上传与保存、连续五次刷新、SQLite/临时文件写入均未导致退出或服务重启；无浏览器错误。');
}finally{await browser?.close();await killTree(dev);if(lock.exitCode===null){lock.kill();await once(lock,'exit');}}
