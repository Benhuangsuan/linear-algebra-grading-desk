import {randomUUID} from 'node:crypto';
import type {AiCall} from '../../shared/ai.js';
import {questionKey,type Config,type Grade} from '../../shared/domain.js';
import type {Store} from '../store.js';
import {AiError,priceFor,type ProviderConfig} from './config.js';
import {committed,cost,estimateInput} from './budget.js';
import {hash} from './pdf.js';
import {EVIDENCE_VERSION,MAX_EVIDENCE_BYTES,finalGroups,validateEvidence,type GradingPlan,type Evidence,type References} from './grading-plan.js';
import {validateVision} from './validate.js';
import {requestBytes,type Message,type TransportResult} from './transport.js';

type Part=TransportResult&{callId:string};
export type GradingRun={id:string;key:string;submissionId:string;assignmentId:string;status:'partial'|'complete';parts:Record<string,Part>;createdAt:string};
export function recoveryKey(key:string,plan:GradingPlan){return hash(JSON.stringify({key,limit:plan.limit,evidence:EVIDENCE_VERSION}));}
export function findRun(store:Store,key:string){return store.all<GradingRun>('grading_runs').filter(r=>r.key===key&&r.status==='partial').at(-1);}
function validPart(store:Store,run:GradingRun|undefined,id:string){const part=run?.parts[id];return part?.finish==='stop'&&store.get<AiCall>('ai_calls',part.callId)?.status==='success'?part:undefined;}
export function runCosts(store:Store,run:GradingRun|undefined){return run?store.all<AiCall>('ai_calls').filter(c=>c.runId===run.id):[];}
export function estimatePlan(store:Store,c:ProviderConfig,config:Config,plan:GradingPlan,run?:GradingRun){
  if(plan.direct)return {estimatedCny:cost(priceFor(c,0),estimateInput(c,plan.direct),c.maxOutput),priorCny:0,reused:0};
  let reused=0;const extraction=plan.chunks.reduce((n,ch)=>{const part=validPart(store,run,ch.id);if(part){try{validateEvidence(part.content,ch.views,config);reused++;return n;}catch{/* The explicit next start only retries invalid parts. */}}return n+cost(priceFor(c,0),estimateInput(c,ch.messages),c.maxOutput);},0);
  // Before OCR, matching and the final number of grading groups are unknown. Reserve
  // the worst case: one complete-evidence request per configured unit, not one score per page.
  const textBound=plan.views.length*(2*MAX_EVIDENCE_BYTES+Buffer.byteLength(JSON.stringify(config.questions.map(questionKey)))+500)+Buffer.byteLength(JSON.stringify(config))+12000;
  const input=Math.ceil(textBound*1.15)+plan.views.length*(c.id==='deepseek'?1024:16384)+512;
  if(input+c.maxOutput>980000||textBound>plan.limit*.8)throw new AiError('evidence_limit','整份作业的完整识别证据预计超过安全范围；未发送请求，不会视为漏做，请人工评分或调整作业材料',false,{stage:'prepare'});
  const priorCny=runCosts(store,run).reduce((n,x)=>n+committed(x),0);
  return {estimatedCny:priorCny+extraction+config.questions.length*cost(priceFor(c,0),input,c.maxOutput),priorCny,reused};
}
type Invoke=(messages:Message[],partId:string,purpose:'page_extract'|'grade',pages:number,retain:(result:Part)=>void)=>Promise<Part>;
export async function gradeBatches(store:Store,c:ProviderConfig,config:Config,references:References,plan:GradingPlan,run:GradingRun,submissionId:string,studentPages:number,invoke:Invoke):Promise<Grade>{
  const evidence:Evidence[]=[];
  const take=async(messages:Message[],id:string,purpose:'page_extract'|'grade',pages:number)=>{
    const existing=validPart(store,run,id);if(existing)return existing;
    return invoke(messages,id,purpose,pages,result=>{run.parts[id]=result;store.putAi('grading_runs',run);});
  };
  const reject=(part:Part,error:unknown)=>{const call=store.get<AiCall>('ai_calls',part.callId);if(call)store.putAi('ai_calls',{...call,status:'failed',error:error instanceof AiError?error.code:'format',diagnostic:{...call.diagnostic,stage:'validation',validation:'rejected',retryable:false}});};
  const accept=(part:Part)=>{const call=store.get<AiCall>('ai_calls',part.callId);if(call&&call.diagnostic?.validation!=='accepted')store.putAi('ai_calls',{...call,diagnostic:{...call.diagnostic,validation:'accepted'}});};
  for(const [index,chunk] of plan.chunks.entries()){
    let result:Part|undefined;
    try{result=await take(chunk.messages,chunk.id,'page_extract',new Set(chunk.views.map(v=>v.kind+':'+v.referenceId+':'+v.image.page)).size);evidence.push(...validateEvidence(result.content,chunk.views,config));accept(result);}
    catch(e){if(result)reject(result,e);if(e instanceof AiError&&e.code==='paused')throw e;throw new AiError(e instanceof AiError?e.code:'evidence_format','第 '+(index+1)+'/'+plan.chunks.length+' 批页面尚未完整识别：'+(e instanceof Error?e.message:'识别失败')+'。已成功批次已保留；未生成本次成绩，未处理页面不会视为漏做。重新预估并开始可续跑未完成部分。',false,e instanceof AiError?e.diagnostic:{stage:'validation'});}
  }
  if(evidence.length!==plan.views.length||new Set(evidence.map(e=>e.id)).size!==plan.views.length)throw new AiError('evidence_coverage','全部原页尚未覆盖，不能评分或判漏做');
  const groups=finalGroups(c,config,references,plan,evidence,submissionId),rows:Grade['rows']=[];let model=c.model;
  for(const group of groups){let result:Part|undefined;
    try{result=await take(group.messages,group.id,'grade',studentPages);model=result.model;const parsed=validateVision(result.content,group.config,studentPages);if(parsed.zoomRequests.length)throw new AiError('evidence_format','汇总评分仍需查看原稿，请人工核对；没有追加付费放大');rows.push(...parsed.rows);accept(result);}
    catch(e){if(result)reject(result,e);throw e;}
  }
  const unclear=evidence.some(e=>e.unclear);
  // No incomplete/unreadable region can justify a missing-answer penalty.
  for(const r of rows){
    const located=evidence.filter(e=>!e.blank&&e.keys.includes(r.key)&&plan.views.find(v=>v.id===e.id)?.kind==='student');
    if((unclear||located.length)&&(r.recognition==='missing'||r.recognition==='not_found')){r.recognition='uncertain';r.verdict='uncertain';r.deduction=null;r.reason='';r.pages=[...new Set(located.map(e=>plan.views.find(v=>v.id===e.id)!.image.page))].sort((a,b)=>a-b);r.reviewReason=located.length?'已找到关联作答，汇总判定与原页证据不一致，请人工核对':'部分原页不清晰，不能判定漏做，请人工核对';}
    r.needsReview=true;r.reviewed=false;r.reviewReason=r.reviewReason||(unclear?'部分原页不清晰，请对照全部原稿复核':'分批识别后已结合全部页面评分，请核对跨页作答与转录内容');
  }
  return {provider:c.id,model,at:new Date().toISOString(),version:0,config,rows,raw:{evidenceRunId:run.id,requestBytes:groups.map(g=>requestBytes(c,g.messages)),allViews:evidence.length,allStudentPages:studentPages}};
}
export function createRun(key:string,submissionId:string,assignmentId:string):GradingRun{return {id:randomUUID(),key,submissionId,assignmentId,status:'partial',parts:{},createdAt:new Date().toISOString()};}
