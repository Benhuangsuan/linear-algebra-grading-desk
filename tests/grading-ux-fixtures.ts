import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {blankQuestion,questionKey,type Assignment,type Submission} from '../shared/domain.js';
import type {AiBatch,CheckResult} from '../shared/ai.js';
import type {AiDependencies} from '../server/ai/service.js';
import {courseConfig} from '../shared/course.js';
import {testDirectory} from './fixtures.js';

export async function shortPdf(pages=2,label='Synthetic matrix A=[1 2;0 1], x=2'){
  const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([300,420]).drawText(label+' page '+(i+1),{x:15,y:300,size:11});return Buffer.from(await doc.save());
}
export async function uxHarness(deps:AiDependencies={}){
  const dir=testDirectory('v2.13-ux-'),seen:any[]=[];
  const env={AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'synthetic-credential',AI_MAX_OUTPUT_TOKENS:'8192',...deps.env};
  const fetcher:NonNullable<AiDependencies['fetcher']>=async(u,init)=>{const body=JSON.parse(String(init?.body));seen.push(body);if(deps.fetcher)return deps.fetcher(u,init);const explanation=body.messages[0].content.includes('针对当前单项扣分');
    const units=explanation?[]:JSON.parse(body.messages[1].content[0].text.split('JSON：')[1]).units;
    const result=explanation?{answer:'此处把矩阵行列式写成了对角元素之和，应核对相乘的规则；原稿不清楚时请人工复核。',pages:[1,2],uncertain:true}:{rows:units.map((q:any,i:number)=>({key:q.key,type:q.type,recognition:'found',verdict:i?'correct':'partial',reason:i?'':'你将行列式写成了对角元素之和；这里应相乘，因此本项按计算错误处理。',pages:[1,2],reviewReason:''})),zoomRequests:[]};
    return Response.json({model:body.model,choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:200}});
  };
  let runtime:ReturnType<typeof createApp>,server:ReturnType<ReturnType<typeof createApp>['app']['listen']>,base='';
  async function start(){runtime=createApp(dir,{...deps,env,fetcher});runtime.app.use(runtime.errorHandler);server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;}
  await start();
  async function request<T=any>(path:string,body?:unknown,status=200,method=body?'POST':'GET'):Promise<T>{const form=body instanceof FormData,r=await fetch(base+'/api'+path,{method,headers:body&&!form?{'content-type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined}),data=await r.json();if(r.status!==status)throw Error('Expected '+status+', got '+r.status+': '+JSON.stringify(data));return data as T;}
  const course=await request('/courses',{name:'Synthetic grading UX'},201);
  const config={...courseConfig([1,2,3].map(number=>({...blankQuestion(),section:'补充章',number:String(number),allGraded:true,prompt:number===1?'Compute det diag(2,3)':number===2?'Prove A is invertible':'Judge whether det A=6',answer:number===1?'2*3=6':number===2?'det A=6 is nonzero':'True'}))),confirmed:true};
  const assignment=await request<Assignment>('/assignments',{courseId:course.id,title:'Synthetic grading UX',description:'',scope:'补充章',config},201);
  async function upload(kind:string,name:string,bytes?:Buffer){const f=new FormData();f.append('kind',kind);f.append('file',new Blob([new Uint8Array(bytes??await shortPdf())]),name);return request('/assignments/'+assignment.id+'/files',f,201);}
  await upload('student','SyntheticAlpha.pdf');
  const submissions=()=>runtime.store.all<Submission>('submissions'),options={provider:'deepseek',maxOutputTokens:8192,expectedVersion:assignment.version,regrade:false,perSubmissionBudget:.5,totalBudget:2,consent:true,deidentified:true,unitsConfirmed:true};
  const path='/assignments/'+assignment.id+'/ai';
  async function check(ids=submissions().map(s=>s.id),changes={}){const first=await request<CheckResult>(path+'/check',{...options,ids,...changes});let result=first;for(let i=0;i<3000&&!result.done;i++){await new Promise(r=>setTimeout(r,10));result=await request(path+'/check/'+first.id);}if(!result.done)throw Error('Local check timed out');return result;}
  async function queue(result:CheckResult,changes={}){return request(path+'/queue',{...options,ids:result.items.map(i=>i.submissionId),checkTokens:Object.fromEntries(result.items.map(i=>[i.submissionId,i.token])),...changes});}
  async function wait(){for(let i=0;i<1000;i++){const b=runtime.store.all<AiBatch>('ai_batches').at(-1);if(b?.status==='completed')return b;await new Promise(r=>setTimeout(r,10));}throw Error('Queue timed out');}
  async function close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
  return {dir,seen,env,assignment,options,path,request,upload,check,queue,wait,submissions,get base(){return base;},get runtime(){return runtime!;},close,restart:async()=>{await close();await start();}};
}
