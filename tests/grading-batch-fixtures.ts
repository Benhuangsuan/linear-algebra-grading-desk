import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createCanvas} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {courseConfig} from '../shared/course.js';
import {blankQuestion,type Assignment,type State,type Submission} from '../shared/domain.js';
import type {AiBatch} from '../shared/ai.js';
import type {AiDependencies} from '../server/ai/service.js';
import {testDirectory} from './fixtures.js';

let scan:Promise<Buffer>|undefined;
/** Invented noisy raster scans, never read a course attachment or a real credential. */
export function noisyScan(){return scan??=makeScan();}
async function makeScan(){
  const pdf=await PDFDocument.create(),canvas=createCanvas(1200,1680),ctx=canvas.getContext('2d');let seed=71431;
  const pixels=ctx.createImageData(1200,1680);
  for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const v=seed>>>24;pixels.data[i]=v;pixels.data[i+1]=v;pixels.data[i+2]=v;pixels.data[i+3]=255;}
  ctx.putImageData(pixels,0,0);ctx.fillStyle='white';ctx.fillRect(20,30,1150,150);ctx.fillStyle='black';ctx.font='32px sans-serif';ctx.fillText('Synthetic matrix [1 2; 0 1] x = b',45,90);
  const image=await pdf.embedJpg(await canvas.encode('jpeg',84));
  for(let i=0;i<6;i++){const p=pdf.addPage([400,560]);p.drawImage(image,{x:0,y:0,width:400,height:560});p.drawText('Invented continuation page '+(i+1),{x:20,y:530,size:12});}
  return Buffer.from(await pdf.save());
}
export type Seen={stage:string;pages:number[];ids:string[];bytes:number;imageHashes:string[];body:any};
export function mockPageResponse(body:any,{unclear=false,omit=false}:{unclear?:boolean;omit?:boolean}={}){
  const meta=JSON.parse(body.messages[1].content[0].text);
  const views=meta.views.map((v:any)=>({id:v.id,text:v.kind==='reference'?'Verified synthetic matrix reference.':v.page===1?'Question 2, first half: row reduction gives x=2.':v.page===6?'Question 2, continuation: substitute x=2, equation satisfied.':'',keys:v.kind==='reference'||v.page===1||v.page===6?[meta.units[0].key]:[],unclear:unclear&&v.kind==='student'&&v.page===3,blank:v.kind==='student'&&v.page!==1&&v.page!==6}));
  if(unclear)for(const row of views)if(row.unclear){row.blank=false;row.text='Unclear final answer.';}
  return {views:omit?views.slice(1):views};
}
export function mockGradeResponse(body:any){
  const rules=JSON.parse(body.messages[1].content[0].text.slice(body.messages[1].content[0].text.indexOf('{')));
  return {rows:rules.units.map((q:any)=>({key:q.key,type:q.type,recognition:q.key.includes(' / 2')?'found':'not_found',verdict:q.key.includes(' / 2')?'correct':'missing',reason:'',pages:q.key.includes(' / 2')?[1,6]:[],reviewReason:''})),zoomRequests:[]};
}
export async function batchHarness(options:{limit?:number;timeout?:number;respond?:(body:any,index:number,stage:string,signal?:AbortSignal)=>Response|Promise<Response>}={}){
  const dir=testDirectory('v2.12-batches-'),seen:Seen[]=[];let runtime:ReturnType<typeof createApp>,server:ReturnType<typeof runtime.app.listen>,base='';
  const deps:AiDependencies={env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential',AI_MAX_OUTPUT_TOKENS:'8192',...(options.timeout?{AI_TIMEOUT_MS:String(options.timeout)}:{})},requestLimitBytes:options.limit??3*1024*1024,fetcher:async(_u,init)=>{
    const body=JSON.parse(String(init?.body));let meta:any;try{meta=JSON.parse(body.messages[1].content[0].text);}catch{meta={};}
    const stage=meta.stage==='extract'?'extract':'grade',imageHashes=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='image_url').map((p:any)=>createHash('sha256').update(Buffer.from(p.image_url.url.split(',')[1],'base64')).digest('hex')):[]);
    seen.push({stage,pages:meta.views?.map((v:any)=>v.page)??[],ids:meta.views?.map((v:any)=>v.id)??[],bytes:Buffer.byteLength(String(init?.body)),imageHashes,body});
    if(options.respond)return options.respond(body,seen.length,stage,init?.signal??undefined);
    return response(body,stage==='extract'?mockPageResponse(body):mockGradeResponse(body));
  }};
  async function start(){runtime=createApp(dir,deps);runtime.app.use(runtime.errorHandler);server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;}
  await start();
  async function request<T=any>(path:string,body?:unknown,status=200,method=body?'POST':'GET'):Promise<T>{const form=body instanceof FormData,r=await fetch(base+'/api'+path,{method,headers:body&&!form?{'Content-Type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined}),data=await r.json();if(r.status!==status)throw Error('Expected '+status+', got '+r.status+': '+JSON.stringify(data));return data as T;}
  const course=await request('/courses',{name:'Synthetic batch course'},201),config={...courseConfig([{...blankQuestion(),section:'1.1',number:'2',prompt:'Solve the synthetic matrix equation',answer:'x=2'},{...blankQuestion(),section:'1.1',number:'4',prompt:'A separate synthetic exercise',answer:'x=3'}]),confirmed:true};
  const assignment=await request<Assignment>('/assignments',{courseId:course.id,title:'Synthetic whole-work grading',scope:'1.1',description:'',config},201);
  const ref=await PDFDocument.create();ref.addPage([250,350]).drawText('Verified synthetic reference',{x:15,y:300,size:14});
  async function upload(kind:string,bytes:Uint8Array,name:string){const form=new FormData();form.append('kind',kind);form.append('file',new Blob([new Uint8Array(bytes)]),name);return request('/assignments/'+assignment.id+'/files',form,201);}
  await upload('reference',await ref.save(),'SyntheticReference.pdf');await upload('student',await noisyScan(),'SyntheticWork-0000000042.pdf');
  const student=(await request<State>('/state')).submissions[0],batchOptions={ids:[student.id],provider:'deepseek',consent:true,deidentified:true,unitsConfirmed:true,perSubmissionBudget:20,totalBudget:100,warningAcknowledged:true,maxOutputTokens:8192,regrade:false};
  async function quote(changes={}){return request('/assignments/'+assignment.id+'/ai/preview',{...batchOptions,...changes});}
  async function queue(changes={}){const q=await quote(changes);return request('/assignments/'+assignment.id+'/ai/queue',{...batchOptions,...changes,previewToken:q.previewToken});}
  async function wait(){for(let i=0;i<1000;i++){const b=runtime.store.all<AiBatch>('ai_batches').at(-1);if(b?.status==='completed')return b;await new Promise(r=>setTimeout(r,20));}throw Error('Synthetic queue did not finish');}
  async function stop(){await new Promise<void>(r=>server.close(()=>r()));runtime.close();}
  return {dir,seen,request,assignment,student,batchOptions,quote,queue,wait,upload,get runtime(){return runtime;},get base(){return base;},close:stop,restart:async()=>{await stop();await start();},submission:()=>runtime.store.get<Submission>('submissions',student.id)!};
}
export function response(body:any,content:unknown,finish='stop'){return Response.json({model:body.model,choices:[{message:{content:JSON.stringify(content)},finish_reason:finish}],usage:{prompt_tokens:2000,completion_tokens:finish==='length'?8192:300}});}
