import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configSchema,questionKey,type Assignment,type Config,type Question,type StoredFile} from '../../shared/domain.js';
import {referenceSections} from '../../shared/reference.js';
import {courseConfig} from '../../shared/course.js';
import {REFERENCE_PROMPT_VERSION,REFERENCE_RESULT_VERSION,type ReferenceResult,type ReferenceResultSummary,type ReferenceResponse,type ReferenceSelection,type ReferenceResultPreview,type ReferenceTask} from '../../shared/reference-task.js';
import type {Store} from '../store.js';import type {AiCall} from '../../shared/ai.js';
import {AiError} from './config.js';import {hash} from './pdf.js';import {committed} from './budget.js';
import {referenceBatchCandidate,checkReferenceCompleteness,mergeReferenceQuestions} from './reference-batch.js';

export const resultConfig=(questions:Question[]):Config=>({...courseConfig(),principles:'按逐题已确认的检查方式评分；漏做默认扣0.2，错误默认扣0.1，同一单元不重复扣分。',questions,confirmed:false});
const resultId=(taskId:string,fileId:string)=>'reference-result:'+hash(taskId+':'+fileId);
export class ReferenceLibrary {
 constructor(private store:Store){}
 assignment(id:string){const a=this.store.get<Assignment>('assignments',id);if(!a)throw new AiError('reference','当前作业不存在。');return a;}
 async binding(assignmentId:string,fileId:string){
  this.assignment(assignmentId);const file=this.store.get<StoredFile>('files',fileId);
  if(!file||file.assignmentId!==assignmentId||file.kind==='student'||file.mime!=='application/pdf'||!file.pages||!/^[a-f0-9-]+\.pdf$/.test(file.diskName))throw new AiError('reference','参考文件已删除或不属于当前作业。');
  const bytes=await readFile(join(this.store.uploads,file.diskName));return {file,fileHash:hash(bytes),sections:referenceSections(file)};
 }
 private validate(result:ReferenceResult,file:StoredFile){
  configSchema.parse(resultConfig(result.questions));const sections=referenceSections(file);
  for(const q of result.questions){if(sections.length&&!sections.includes(q.section))throw new AiError('reference','草稿小节与当前文件不符。');for(const s of [...(q.referenceSources??[]),...(q.children??[]).flatMap(c=>c.referenceSources??[])])if(s.fileId!==file.id||s.page<1||s.page>(file.pages??0))throw new AiError('reference','草稿来源页与当前文件不符。');}
  checkReferenceCompleteness(file,result.questions);
 }
 async importLegacy(assignmentId:string){
  this.assignment(assignmentId);const tasks=this.store.all<ReferenceTask>('reference_tasks').filter(t=>t.assignmentId===assignmentId&&!t.referenceVersion),calls=this.store.all<AiCall>('ai_calls');
  for(const task of tasks){const taskCalls=calls.filter(c=>c.batchId===task.id&&c.purpose==='reference_parse');let offset=0;
   for(const progress of task.files){const id=resultId(task.id,progress.id),plans=Math.max(1,Math.ceil((progress.pages-1)/3)),callIds=taskCalls.slice(offset,offset+plans).map(c=>c.id);offset+=plans;if(this.store.get('reference_results',id))continue;
    let binding:Awaited<ReturnType<ReferenceLibrary['binding']>>;try{binding=await this.binding(assignmentId,progress.id);}catch{continue;}
    const questions=structuredClone(task.config.questions.filter(q=>q.referenceSources?.some(s=>s.fileId===progress.id))).map(q=>({...q,referenceSources:q.referenceSources?.filter(s=>s.fileId===progress.id),children:q.children?.map(c=>({...c,referenceSources:c.referenceSources?.filter(s=>s.fileId===progress.id)}))}));
    const result:ReferenceResult={id,taskId:task.id,assignmentId,fileId:progress.id,fileHash:binding.fileHash,sections:binding.sections,pages:progress.pages,processedPages:progress.processedPages,status:questions.length?'partial':'failed',questions,responseIds:[],callIds,model:taskCalls.find(c=>callIds.includes(c.id))?.model??task.provider,promptVersion:'legacy-2.10',resultVersion:REFERENCE_RESULT_VERSION,createdAt:task.createdAt,legacy:true,error:progress.status==='waiting'?'此前任务在其他文件中断，本文件尚未完成。':task.error};
    if(progress.status==='completed'&&new Set(progress.processedPages).size===progress.pages){try{this.validate(result,binding.file);result.status='complete';result.error='';result.completedAt=task.createdAt;}catch{result.error='旧记录未通过当前完整性检查，请对照原页或重新整理；旧任务和费用保留。';}}
    this.store.putAi('reference_results',result);
   }
  }
 }
 begin(task:ReferenceTask,file:StoredFile,fileHash:string,initial?:ReferenceResult){
  const result:ReferenceResult={id:resultId(task.id,file.id),assignmentId:task.assignmentId,taskId:task.id,fileId:file.id,fileHash,sections:referenceSections(file),pages:file.pages!,processedPages:initial?.processedPages??[],status:'partial',questions:structuredClone(initial?.questions??[]),responseIds:[...(initial?.responseIds??[])],callIds:[],model:task.provider,promptVersion:REFERENCE_PROMPT_VERSION,resultVersion:REFERENCE_RESULT_VERSION,createdAt:task.createdAt,error:''};this.store.putAi('reference_results',result);return result;
 }
 retain(response:ReferenceResponse){this.store.putAi('reference_responses',response);}
 diagnostics(assignmentId:string,id:string){
  this.assignment(assignmentId);const result=this.store.get<ReferenceResult>('reference_results',id);if(!result||result.assignmentId!==assignmentId)throw new AiError('reference','当前作业中没有这份结果。');
  return {fileId:result.fileId,fileHash:result.fileHash,pages:result.pages,processedPages:result.processedPages,promptVersion:result.promptVersion,errorCode:result.errorCode,legacy:!!result.legacy,hasResponse:result.responseIds.length>0,responses:result.responseIds.flatMap(id=>{const r=this.store.get<ReferenceResponse>('reference_responses',id);return r?[{pages:r.pages,finish:r.finish,model:r.model,validation:r.validation}]:[];}),calls:this.store.all<AiCall>('ai_calls').filter(c=>result.callIds.includes(c.id)).map(c=>({status:c.status,error:c.error,model:c.model,inputTokens:c.inputTokens,outputTokens:c.outputTokens,estimatedCny:c.estimatedCny,reservedCny:c.reservedCny,diagnostic:c.diagnostic}))};
 }
 update(result:ReferenceResult){this.store.putAi('reference_results',result);}
 async summaries(assignmentId:string):Promise<ReferenceResultSummary[]>{
  await this.importLegacy(assignmentId);const calls=this.store.all<AiCall>('ai_calls'),results=this.store.all<ReferenceResult>('reference_results').filter(r=>r.assignmentId===assignmentId),bindings=new Map<string,Awaited<ReturnType<ReferenceLibrary['binding']>>|null>();
  for(const file of this.store.all<StoredFile>('files').filter(f=>f.assignmentId===assignmentId&&f.kind!=='student'&&f.mime==='application/pdf'))if(!bindings.has(file.id)){try{bindings.set(file.id,await this.binding(assignmentId,file.id));}catch{bindings.set(file.id,null);}}
  return results.map(({questions,...result})=>{const matchingFileIds=[...bindings].filter(([,b])=>!!b&&b.fileHash===result.fileHash&&JSON.stringify(b.sections)===JSON.stringify(result.sections)).map(([id])=>id),matching=matchingFileIds.length>0,items=calls.filter(c=>result.callIds.includes(c.id));return {...result,questionCount:questions.length,available:matching,matchingFileIds,unavailableReason:matching?'':'参考文件已删除、改变或小节不符；旧结果只保留为历史。',estimatedCny:items.reduce((n,c)=>n+committed(c),0),usageUnknown:items.some(c=>c.estimatedCny===null),hasResponse:result.responseIds.length>0};}).reverse();
 }
 async selected(assignmentId:string,selection:ReferenceSelection,complete=true){
  const {file,fileHash,sections}=await this.binding(assignmentId,selection.fileId),result=this.store.get<ReferenceResult>('reference_results',selection.resultId);
  if(!result||result.assignmentId!==assignmentId||result.fileHash!==fileHash||JSON.stringify(result.sections)!==JSON.stringify(sections))throw new AiError('reference','草稿不属于当前作业或文件内容已变化，请重新选择。');
  if(complete&&result.status!=='complete')throw new AiError('reference_incomplete','这份文件尚未完整整理，不能冒充完整成果采用。');
  const mapped=structuredClone(result);mapped.fileId=file.id;for(const q of mapped.questions){for(const s of q.referenceSources??[])s.fileId=file.id;for(const child of q.children??[]){child.id='ai:'+hash(file.id+':'+questionKey(q)+':'+child.label);for(const s of child.referenceSources??[])s.fileId=file.id;}}
  if(complete)this.validate(mapped,file);return {result:mapped,file};
 }
 async preview(assignmentId:string,selections:ReferenceSelection[],resolutions:Record<string,string>={}):Promise<ReferenceResultPreview>{
  this.assignment(assignmentId);if(!selections.length||selections.length>50||new Set(selections.map(s=>s.fileId)).size!==selections.length)throw new AiError('reference','每份文件请选择一个结果版本，再合并查看。');
  const grouped=new Map<string,{resultId:string;fileId:string;question:Question}[]>();let legacy=false;
  for(const selection of selections){const {result}=await this.selected(assignmentId,selection);legacy ||= !!result.legacy;for(const q of result.questions){const key=questionKey(q),items=grouped.get(key)??[];items.push({resultId:selection.resultId,fileId:selection.fileId,question:q});grouped.set(key,items);}}
  const conflicts:ReferenceResultPreview['conflicts']=[],questions:Question[]=[];
  for(const [key,items] of grouped){const same=items.every(i=>i.question.prompt===items[0].question.prompt&&i.question.answer===items[0].question.answer&&i.question.type===items[0].question.type&&JSON.stringify((i.question.children??[]).map(c=>[c.label,c.prompt,c.answer]))===JSON.stringify((items[0].question.children??[]).map(c=>[c.label,c.prompt,c.answer])));if(same){let merged:Question[]=[];for(const item of items)merged=mergeReferenceQuestions(merged,[item.question],false);questions.push(...merged);continue;}const picked=items.find(i=>i.resultId===resolutions[key]);if(picked)questions.push(picked.question);else conflicts.push({key,choices:items.map(i=>({resultId:i.resultId,fileId:i.fileId,prompt:i.question.prompt,answer:i.question.answer}))});}
  const warnings=['仅加入当前待保存清单，仍需点击“保存设置”；已有人工规则及历史成绩保留。',...(legacy?['含旧版任务恢复的草稿：旧版没有记录原PDF内容指纹，请对照当前原件校对；本次未收费。']:[])];if(conflicts.length)return {conflicts,warnings};const config=resultConfig(questions);configSchema.parse(config);return {config,conflicts:[],warnings};
 }
 async recover(assignmentId:string,selection:ReferenceSelection){
  const {result,file}=await this.selected(assignmentId,selection,false);const origin=this.store.get<ReferenceResult>('reference_results',selection.resultId)!;if(origin.fileId!==selection.fileId){result.id='reference-result:'+hash(origin.id+':recovered-for:'+selection.fileId);result.createdAt=new Date().toISOString();}const responses=result.responseIds.map(id=>this.store.get<ReferenceResponse>('reference_responses',id)).filter((r):r is ReferenceResponse=>!!r);if(!responses.length)throw new AiError('reference_response_missing','旧任务没有保存原响应，无法无损离线恢复。已有完整草稿仍可使用；如需重试本文件，请重新预估费用。');
  let questions:Question[]=[],pages:number[]=[];let lastError='';for(const response of responses){if(response.fileHash!==result.fileHash||response.finish!=='stop'){lastError='旧响应未正常结束或来源不匹配，不能作为完整结果；请重新预估后单独重试。';continue;}try{const candidate=referenceBatchCandidate(response.content,file,response.pages);questions=mergeReferenceQuestions(questions,candidate,true);pages=[...new Set([...pages,...response.pages])].sort((a,b)=>a-b);this.retain({...response,validation:'accepted',error:''});}catch(e){lastError=e instanceof Error?e.message:'响应结构校验未通过';this.retain({...response,validation:'rejected',error:lastError});}}
  result.questions=questions;result.processedPages=pages;result.status=questions.length?'partial':'failed';result.error=lastError;
  if(pages.length===result.pages){try{this.validate(result,file);result.status='complete';result.completedAt=new Date().toISOString();result.error='';}catch(e){result.error=e instanceof Error?e.message:'文件完整性校验未通过';}}
  this.update(result);return result;
 }
}
