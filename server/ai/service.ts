import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {batchOptions,reportedReasoningTokens,type AiBatch,type AiCall,type BatchOptions,type ProviderId,type Crop} from '../../shared/ai.js';
import {unitConfig} from '../../shared/units.js';
import {type Assignment,type Submission,type StoredFile,type Grade,type Config} from '../../shared/domain.js';
import type {Store} from '../store.js';
import {providerConfig,safeStatus,priceFor,AiError,type Env,type ProviderConfig} from './config.js';
import {renderPdf,hash,RENDER_VERSION,type PageImage} from './pdf.js';
import {messagesFor,PROMPT_VERSION} from './prompt.js';
import {complete,assertRequestLimits,type Fetch,type Message,type TransportResult} from './transport.js';
import {estimateInput,cost,accounting,committed} from './budget.js';
import {validateVision} from './validate.js';
import {hasFormalResult} from '../../shared/submission-state.js';
import {referenceParseOptions,referenceMessages,referenceCandidate} from './reference.js';
import {gradingBlockers} from '../../shared/ai-readiness.js';

type Cache={id:string;grade:Grade;at:string};
type Prepared={assignment:Assignment;config:Config;student:PageImage[];references:{id:string;sourceFileId?:string;images:PageImage[]}[];key:string;bytes:Buffer;studentPages:number};
export type AiDependencies={fetcher?:Fetch;env?:Env};
type Save=(s:Submission,action:string)=>Submission;
export class AiService {
  private closed=false;
  private running=false;
  private controller:AbortController|undefined;
  private activeBatch:string|undefined;
  private connections=new Map<ProviderId,string>();
  private connecting=new Set<ProviderId>();
  private referenceParsing=false;
  constructor(private store:Store,private save:Save,private deps:AiDependencies={}){
    for(const b of store.all<AiBatch>('ai_batches').filter(b=>b.status==='running')){
      b.status='paused';b.updatedAt=new Date().toISOString();
      b.items=b.items.map(i=>i.state==='processing'?{...i,state:'queued',error:'服务退出中断；未重发未知用量请求'}:i);
      store.putAi('ai_batches',b);
    }
  }
  private config(id:ProviderId){return providerConfig(id,this.deps.env??process.env);}
  statuses(){return (['deepseek','qwen'] as const).map(id=>safeStatus(this.config(id),this.connections.get(id)));}
  private requireConfig(id:ProviderId){
    const c=this.config(id);
    if(!c.key)throw new AiError('missing_key','未检测到 '+(id==='deepseek'?'DEEPSEEK_API_KEY':'DASHSCOPE_API_KEY'));
    if(!c.enabled)throw new AiError('disabled','真实调用未启用，请先按说明设置 AI_ALLOW_PAID=true；Mock 和人工评分仍可用');
    return c;
  }
  private async prepare(s:Submission,id:ProviderId,maxOutput?:number):Promise<Prepared>{
    const c=this.config(id);if(maxOutput!==undefined)c.maxOutput=maxOutput;const renderOptions={maxEdge:id==='deepseek'?4096:8192};
    const assignment=this.store.get<Assignment>('assignments',s.assignmentId);if(!assignment)throw new AiError('missing','作业不存在');
    const allFiles=this.store.all<StoredFile>('files').filter(f=>f.assignmentId===assignment.id);
    const blocker=gradingBlockers(assignment,allFiles)[0];if(blocker)throw new AiError(blocker.code,blocker.message);
    const config=unitConfig(assignment.config);
    const file=allFiles.find(f=>f.id===s.fileId);if(!file||!/^[a-f0-9-]+\.pdf$/.test(file.diskName))throw new AiError('file','学生 PDF 不存在');
    const references:Prepared['references']=[];const refHashes:string[]=[];const cacheRoot=join(this.store.dir,'ai-cache');
    for(const q of config.questions){
      if(/下图|如图|见图|图示|示意图/.test(q.prompt+'\n'+q.answer)&&!q.referenceSources?.some(s=>s.graphic))throw new AiError('reference_graphic',q.section+' / '+q.number+' 需要参考答案中的图片。请在作业设置中添加并核对参考页，再开始批改；未发送请求');
      for(const source of q.referenceSources??[]){const f=allFiles.find(f=>f.id===source.fileId&&f.kind!=='student'&&f.mime==='application/pdf');if(!f||source.page>(f.pages??0))throw new AiError('reference_graphic','题目关联的参考页缺失或不属于当前作业，请重新整理并人工核对；未发送请求');}
    }
    for(const f of allFiles.filter(f=>f.kind!=='student')){
      if(f.mime!=='application/pdf')continue; // original DOCX remains available in the existing UI.
      if(!/^[a-f0-9-]+\.pdf$/.test(f.diskName))throw new AiError('file','参考材料路径无效');
      const bytes=await readFile(join(this.store.uploads,f.diskName));refHashes.push(hash(bytes));
      references.push({id:'reference-'+String(references.length+1),sourceFileId:f.id,images:await renderPdf(bytes,cacheRoot,undefined,renderOptions)});
    }
    if(!references.length&&allFiles.some(f=>f.kind!=='student'&&f.mime!=='application/pdf'))throw new AiError('file','请补充 PDF 版参考材料，DOCX 原件已保留；真实批改不使用可能丢失公式的文本预览');
    if(!references.length&&config.questions.some(q=>q.type==='graded'&&!q.answer.trim()))throw new AiError('reference','需要 PDF 参考答案或已确认的完整参考解');
    const bytes=await readFile(join(this.store.uploads,file.diskName));
    const student=await renderPdf(bytes,cacheRoot,undefined,renderOptions);const studentPages=Math.max(...student.map(p=>p.page));
    const key=hash(JSON.stringify({student:hash(bytes),submission:s.id,version:assignment.version,config,refHashes,provider:id,model:c.model,prompt:PROMPT_VERSION,renderer:RENDER_VERSION,scale:3,maxOutput:c.maxOutput}));
    return {assignment,config,student,references,key,bytes,studentPages};
  }
  private outstanding(id:string){return this.store.all<AiCall>('ai_calls').filter(c=>c.batchId===id);}
  private async call(c:ProviderConfig,messages:Message[],info:{batchId:string;submissionId:string;assignmentId:string;version:number;pages:number;purpose:AiCall['purpose'];attempt:number},per:number,total:number,signal?:AbortSignal){
    if(this.closed||signal?.aborted)throw new AiError('cancelled','任务已停止');
    assertRequestLimits(c,messages);const input=estimateInput(c,messages);
    if(input+c.maxOutput>980000)throw new AiError('input_limit','输入超过模型安全上下文限制；未省略页面');
    const price=priceFor(c,input);const reserve=cost(price,input,c.maxOutput);
    const prior=this.outstanding(info.batchId);
    if(prior.filter(x=>x.submissionId===info.submissionId).reduce((a,b)=>a+committed(b),0)+reserve>per+1e-8||prior.reduce((a,b)=>a+committed(b),0)+reserve>total+1e-8)throw new AiError('budget','下一次调用可能超出预算，已停止；现有结果与未知用量预留均保留');
    const record:AiCall={id:randomUUID(),...info,provider:c.id,model:c.model,at:new Date().toISOString(),status:'reserved',reservedCny:reserve,estimatedCny:null,inputTokens:null,outputTokens:null,cacheHitTokens:null,usage:null,price,error:'',diagnostic:{maxOutputTokens:c.maxOutput,stage:'request',inputImages:messages.reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').length:0),0)}};
    this.store.putAi('ai_calls',record);
    try{
      const result=await complete(c,messages,this.deps.fetcher,signal);
      if(this.closed)throw new AiError('cancelled','服务已停止；未重复请求');
      const finishReason=['stop','length','content_filter','tool_calls','function_call'].includes(result.finish)?result.finish:result.finish?'other':'missing';
      const settled={...record,...accounting(result.usage,price),model:result.model,status:'success' as const,diagnostic:{...record.diagnostic,httpStatus:result.httpStatus,finishReason,stage:'completion' as const,responseCharacters:result.content.length,reasoningCharacters:result.reasoningCharacters,reasoningTokens:reportedReasoningTokens(result.usage)}};
      this.store.putAi('ai_calls',settled);
      if(result.finish!=='stop')throw new AiError(result.finish==='length'?'output_limit':'incomplete_response',result.finish==='length'?'模型耗尽本次 '+c.maxOutput+' token 输出额度（含思考与评分）。请在批改选项提高额度后重新预估，或人工处理；原样重试仍可能失败，未自动重试。已有用量保留。':'模型未正常结束，未保存不完整评分；请查看批次诊断后明确重试或人工处理。',false,{stage:'completion'});
      return {...result,callId:record.id};
    }catch(e){
      if(this.closed)throw new AiError('cancelled','服务已停止；未知用量预留保留');
      const current=this.store.get<AiCall>('ai_calls',record.id)??record;
      const error=e instanceof AiError?e:new AiError('internal','模型请求失败');
      this.store.putAi('ai_calls',{...current,status:'failed',error:error.code,diagnostic:{...current.diagnostic,...error.diagnostic,retryable:error.retryable}});
      throw error;
    }
  }
  async connection(id:ProviderId){
    if(this.referenceParsing)throw new AiError('busy','参考页面辅助整理正在进行，请等待后再操作');
    if(this.connecting.has(id))throw new AiError('duplicate','连接测试正在进行，请勿重复点击');
    const c=this.requireConfig(id);const image=createCanvas(64,64);const ctx=image.getContext('2d');ctx.fillStyle='#2459af';ctx.fillRect(0,0,64,64);
    this.connecting.add(id);
    const messages:Message[]=[{role:'system',content:'检查合成图片是否为蓝色，只返回 JSON {"ok":true}。'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+image.toBuffer('image/png').toString('base64'),detail:'high'}}]}];
    try{
      const result=await this.call({...c,maxOutput:512},messages,{batchId:'connection-'+randomUUID(),submissionId:'connection',assignmentId:'connection',version:0,pages:1,purpose:'connection',attempt:1},.05,.05);
      const data:unknown=JSON.parse(result.content);if(typeof data!=='object'||data===null||!('ok'in data)||data.ok!==true)throw new AiError('format','连接成功但图片/JSON 校验失败');
      this.connections.set(id,'图片连接通过');return {ok:true,message:'合成图片与 JSON 连接测试通过'};
    }catch(e){this.connections.set(id,e instanceof AiError?e.code:'format');throw e;}
    finally{this.connecting.delete(id);}
  }
  private async referenceInput(assignmentId:string,body:unknown){
    const options=referenceParseOptions.parse(body);const c=this.requireConfig(options.provider);if(options.maxOutputTokens!==undefined)c.maxOutput=options.maxOutputTokens;
    if(new Set(options.pages).size!==options.pages.length)throw new AiError('reference','PDF 页码有重复，请检查。');
    const assignment=this.store.get<Assignment>('assignments',assignmentId);
    if(!assignment||assignment.archived||assignment.version!==options.expectedVersion)throw new AiError('version','作业不存在、已归档或规则已变化，请刷新后重新预估');
    const f=this.store.get<StoredFile>('files',options.fileId);
    if(!f||f.assignmentId!==assignmentId||f.kind==='student'||f.mime!=='application/pdf'||!/^[a-f0-9-]+\.pdf$/.test(f.diskName)||options.pages.some(p=>p>(f.pages??0)))throw new AiError('reference','请选择本作业中的 PDF 参考答案，并填写有效页码。');
    const bytes=await readFile(join(this.store.uploads,f.diskName));
    const images=(await renderPdf(bytes,join(this.store.dir,'ai-cache'),undefined,{maxEdge:c.id==='deepseek'?4096:8192})).filter(p=>options.pages.includes(p.page));
    if(options.pages.some(n=>!images.some(p=>p.page===n)))throw new AiError('reference_graphic','所选 PDF 页面无法读取，未发送给 AI。请检查原文件。');
    const messages=referenceMessages(images,options.scope);assertRequestLimits(c,messages);
    const estimatedCny=cost(priceFor(c,0),estimateInput(c,messages),c.maxOutput);
    const previewToken=hash(JSON.stringify({assignmentId,version:assignment.version,file:hash(bytes),pages:options.pages,scope:options.scope,provider:c.id,model:c.model,price:priceFor(c,0),output:c.maxOutput,per:options.perSubmissionBudget,total:options.totalBudget,prompt:'reference-parser-v1',renderer:RENDER_VERSION}));
    return {options,c,messages,assignment,estimatedCny,previewToken,imageCount:images.length};
  }
  async referencePreview(assignmentId:string,body:unknown){
    const p=await this.referenceInput(assignmentId,body);
    return {previewToken:p.previewToken,estimatedCny:p.estimatedCny,imageCount:p.imageCount,pages:p.options.pages,maxOutputTokens:p.c.maxOutput,warning:p.estimatedCny>=.3};
  }
  async referenceParse(assignmentId:string,body:unknown){
    if(this.referenceParsing||this.running||this.connecting.size)throw new AiError('busy','已有 AI 操作正在进行，请等待结束后再整理参考页');
    this.referenceParsing=true;
    try{
      const p=await this.referenceInput(assignmentId,body);
      if(p.options.previewToken!==p.previewToken)throw new AiError('version','参考页或选项已变化，请重新预估并确认');
      if(p.estimatedCny>=.3&&!p.options.warningAcknowledged)throw new AiError('budget','本次预估达到 ¥0.30，请额外确认费用后再调用');
      const result=await this.call(p.c,p.messages,{batchId:'reference-'+randomUUID(),submissionId:'reference',assignmentId,version:p.assignment.version,pages:p.options.pages.length,purpose:'reference_parse',attempt:1},p.options.perSubmissionBudget,p.options.totalBudget);
      let config:Config;
      try{config=referenceCandidate(result.content,p.options.fileId,p.options.pages,p.options.scope,this.store.get<StoredFile>('files',p.options.fileId));}
      catch(e){const call=this.store.get<AiCall>('ai_calls',result.callId)!;this.store.putAi('ai_calls',{...call,status:'failed',error:'reference_format',diagnostic:{...call.diagnostic,stage:'validation',validation:'rejected'}});throw e;}
      if(this.store.get<Assignment>('assignments',assignmentId)?.version!==p.assignment.version||!this.store.get<StoredFile>('files',p.options.fileId))throw new AiError('version','辅助整理期间规则或参考文件已变化；调用费用已保留，未覆盖任何配置，请刷新后人工检查');
      return {config,callId:result.callId,warnings:['整理结果尚未加入题目清单，已保存的题目和成绩没有改变。请对照所选 PDF 页面检查，再决定添加或更新哪些内容，最后保存设置。']};
    }finally{this.referenceParsing=false;}
  }
  async preview(assignmentId:string,body:unknown){
    const options=batchOptions.parse(body);const c=this.requireConfig(options.provider);if(options.maxOutputTokens!==undefined)c.maxOutput=options.maxOutputTokens;
    if(new Set(options.ids).size!==options.ids.length)throw new AiError('duplicate','提交列表重复');
    const assignment=this.store.get<Assignment>('assignments',assignmentId);
    if(!assignment||assignment.archived)throw new AiError('protected','作业不存在或已归档');
    if(options.expectedVersion!==undefined&&options.expectedVersion!==assignment.version)throw new AiError('version','规则已变化，请刷新后重新预估');
    const selected=options.ids.map(id=>this.store.get<Submission>('submissions',id));
    if(selected.some(s=>!s||s.assignmentId!==assignmentId))throw new AiError('missing','提交不属于当前作业');
    const prepared=[];const bindings:unknown[]=[];let total=0;
    for(const s of selected){
      if(!s)continue;if(s.status==='confirmed'||['queued','processing'].includes(s.status))throw new AiError('protected','已确认或正在处理的作业不能重批');
      const p=await this.prepare(s,options.provider,c.maxOutput);const messages=messagesFor(p.config,p.references,p.student,s.id);assertRequestLimits(c,messages);
      if(p.assignment.version!==assignment.version)throw new AiError('version','规则已变化，请重新预估');
      bindings.push({id:s.id,revision:s.revision,status:s.status,key:p.key,model:c.model,price:priceFor(c,0),maxOutput:c.maxOutput});
      const reuseExisting=!options.regrade&&s.grade?.provider===options.provider&&typeof s.grade.raw==='object'&&s.grade.raw!==null&&'cacheKey'in s.grade.raw&&s.grade.raw.cacheKey===p.key;
      if(hasFormalResult(s)&&!options.regrade&&!reuseExisting)throw new AiError('protected','已有正式批改结果；如需再次调用，请明确选择重新批改');
      const cached=!!reuseExisting||!options.regrade&&!!this.validCache(p.key);
      const estimate=cached?0:cost(priceFor(c,0),estimateInput(c,messages),c.maxOutput);
      total+=estimate;prepared.push({submissionId:s.id,pages:p.studentPages,imageCount:p.student.length,units:p.config.questions.length,estimatedCny:estimate,cached,reuseExisting:!!reuseExisting});
    }
    const ignored=this.store.all<StoredFile>('files').filter(f=>f.assignmentId===assignmentId&&f.kind!=='student'&&f.mime!=='application/pdf').length;
    if(this.store.get<Assignment>('assignments',assignmentId)?.version!==assignment.version||selected.some(s=>s&&JSON.stringify(this.store.get<Submission>('submissions',s.id))!==JSON.stringify(s)))throw new AiError('version','预估期间记录已变化，请重新预估');
    const previewToken=hash(JSON.stringify({assignmentId,version:assignment.version,bindings,prepared,provider:options.provider,regrade:options.regrade,per:options.perSubmissionBudget,total:options.totalBudget}));
    return {previewToken,configVersion:assignment.version,maxOutputTokens:c.maxOutput,items:prepared,estimatedCny:total,warning:total>=.3||prepared.some(p=>p.estimatedCny>=.3),targetCny:.1,perSubmissionBudget:options.perSubmissionBudget,totalBudget:options.totalBudget,warnings:[...(ignored?[String(ignored)+' 份 DOCX 不发送云端；请确认其对应 PDF 已完整提供']:[]),...prepared.flatMap((p,i)=>p.imageCount>p.pages?['所选第 '+(i+1)+' 份含长页或大页：'+p.pages+' 个原页已本地整理为 '+p.imageCount+' 幅全景/分区，原页码保留；费用预估已含全部图像。']:[])]};
  }
  private validCache(key:string){
    const cached=this.store.get<Cache>('ai_cache',key);
    if(cached&&Date.now()-Date.parse(cached.at)<7*86400000)return cached;
    return null;
  }
  private validate(result:TransportResult&{callId:string},config:Config,pages:number){
    const call=this.store.get<AiCall>('ai_calls',result.callId)!;
    try{const parsed=validateVision(result.content,config,pages);this.store.putAi('ai_calls',{...call,diagnostic:{...call.diagnostic,validation:'accepted'}});return parsed;}
    catch(e){const error=e instanceof AiError?e:new AiError('format','评分结构校验失败');this.store.putAi('ai_calls',{...call,status:'failed',error:error.code,diagnostic:{...call.diagnostic,stage:'validation',validation:'rejected',retryable:false}});throw new AiError(error.code,error.message,false,{...error.diagnostic,stage:'validation'});}
  }
  async enqueue(assignmentId:string,body:unknown){
    if(this.referenceParsing)throw new AiError('busy','参考页面辅助整理正在进行，请等待结束后再批改');
    const options=batchOptions.parse(body);
    if(new Set(options.ids).size!==options.ids.length)throw new AiError('duplicate','提交列表重复');
    if(this.store.all<AiBatch>('ai_batches').some(b=>['running','paused'].includes(b.status)&&b.items.some(i=>options.ids.includes(i.submissionId)&&['queued','processing'].includes(i.state))))throw new AiError('duplicate','这些作业已有任务，请续跑或取消原任务');
    const preview=await this.preview(assignmentId,options);
    if(this.referenceParsing)throw new AiError('busy','参考页面辅助整理正在进行，请等待后重新预估');
    if(!options.previewToken||options.previewToken!==preview.previewToken)throw new AiError('version','所选学生、规则、材料或预估已变化，请重新预估后再批改');
    if(preview.warning&&!options.warningAcknowledged)throw new AiError('warning','预计费用达到 ¥0.30，请查看估算并明确确认');
    if(preview.estimatedCny>options.totalBudget||preview.items.some(i=>i.estimatedCny>options.perSubmissionBudget))throw new AiError('budget','保守估算超过本次预算，未发起调用');
    const a=this.store.get<Assignment>('assignments',assignmentId)!;
    if(a.version!==preview.configVersion)throw new AiError('version','规则已变化，请重新预估');
    if(a.archived)throw new AiError('protected','请先取消归档');
    // Recheck after rendering/awaits, so concurrent duplicate HTTP requests cannot both queue.
    if(this.store.all<AiBatch>('ai_batches').some(b=>['running','paused'].includes(b.status)&&b.items.some(i=>options.ids.includes(i.submissionId)&&['queued','processing'].includes(i.state))))throw new AiError('duplicate','这些作业已有任务');
    const at=new Date().toISOString();const batch:AiBatch={id:randomUUID(),assignmentId,provider:options.provider,options:{...options,maxOutputTokens:preview.maxOutputTokens},configVersion:a.version,status:preview.items.every(i=>i.reuseExisting)?'completed':'running',items:preview.items.map(i=>({submissionId:i.submissionId,state:i.reuseExisting?'completed':'queued',error:''})),createdAt:at,updatedAt:at};
    this.store.transaction(()=>{this.store.putAi('ai_batches',batch);for(const item of batch.items.filter(i=>i.state==='queued')){const s=this.store.get<Submission>('submissions',item.submissionId)!;if(s.status==='confirmed'||['queued','processing'].includes(s.status))throw new AiError('protected','记录已更新，不能覆盖');this.save({...s,status:'queued',error:''},'明确授权视觉批改排队');}});
    void this.drain();return {batchId:batch.id,...preview};
  }
  private async grade(p:Prepared,s:Submission,b:AiBatch,signal:AbortSignal):Promise<Grade>{
    const cached=!b.options.regrade&&this.validCache(p.key);if(cached)return cached.grade;
    const c={...this.requireConfig(b.provider),maxOutput:b.options.maxOutputTokens??8192};let result;let attempt=0;
    for(;;){
      try{attempt++;result=await this.call(c,messagesFor(p.config,p.references,p.student,s.id),{batchId:b.id,submissionId:s.id,assignmentId:p.assignment.id,version:p.assignment.version,pages:p.studentPages,purpose:'grade',attempt},b.options.perSubmissionBudget,b.options.totalBudget,signal);break;}
      catch(e){if(!(e instanceof AiError)||!e.retryable||attempt>c.retries||signal.aborted)throw e;await new Promise(r=>setTimeout(r,250*attempt));}
    }
    let parsed=this.validate(result,p.config,p.studentPages);
    let grade:Grade={provider:b.provider,model:result.model,at:new Date().toISOString(),version:p.assignment.version,config:p.config,rows:parsed.rows,raw:{content:result.content,usage:result.usage,prompt:PROMPT_VERSION,cacheKey:p.key}};
    if(parsed.zoomRequests.length){
      const current=this.store.get<Submission>('submissions',s.id);
      if(current&&!this.closed)this.save({...current,grade,review:structuredClone(grade.rows)},'保存放大前建议（待复核）');
      const zoom:PageImage[]=[];
      try{
        for(const crop of parsed.zoomRequests)zoom.push(...await renderPdf(p.bytes,join(this.store.dir,'ai-cache'),crop,{maxEdge:b.provider==='deepseek'?4096:8192}));
        result=await this.call(c,messagesFor(p.config,p.references,p.student,s.id,zoom),{batchId:b.id,submissionId:s.id,assignmentId:p.assignment.id,version:p.assignment.version,pages:p.studentPages,purpose:'zoom',attempt:1},b.options.perSubmissionBudget,b.options.totalBudget,signal);
        parsed=this.validate(result,p.config,p.studentPages);
        grade={...grade,model:result.model,rows:parsed.rows,raw:{initial:grade.raw,content:result.content,usage:result.usage,prompt:PROMPT_VERSION,cacheKey:p.key}};
        if(parsed.zoomRequests.length)grade.rows=grade.rows.map(r=>({...r,needsReview:true,reviewReason:'已达到本轮放大次数上限，请人工复查'}));
      }catch(e){if(!(e instanceof AiError))throw e;grade.rows=grade.rows.map(r=>({...r,needsReview:true,reviewReason:'放大未完成：'+e.message}));}
    }
    if(!grade.rows.some(r=>r.recognition==='uncertain'||r.reviewReason))this.store.putAi('ai_cache',{id:p.key,grade,at:new Date().toISOString()} satisfies Cache);
    return grade;
  }
  private async drain(){
    if(this.running||this.closed)return;this.running=true;
    try{
      while(!this.closed){
        const b=this.store.all<AiBatch>('ai_batches').find(b=>b.status==='running'&&b.items.some(i=>i.state==='queued'));if(!b)break;
        const index=b.items.findIndex(i=>i.state==='queued');const item=b.items[index];const s=this.store.get<Submission>('submissions',item.submissionId);
        if(!s||s.status==='confirmed'){item.state='failed';item.error='提交不存在或成绩已确认';this.store.putAi('ai_batches',b);continue;}
        item.state='processing';this.store.putAi('ai_batches',b);this.save({...s,status:'processing',error:''},'开始视觉批改');
        this.controller=new AbortController();this.activeBatch=b.id;
        let stage:'prepare'|'request'|'save'='prepare';
        try{
          const p=await this.prepare(s,b.provider,b.options.maxOutputTokens??8192);if(this.closed)break;if(p.assignment.version!==b.configVersion)throw new AiError('version','规则已变化，请明确发起新批改');
          stage='request';
          const grade=await this.grade(p,s,b,this.controller.signal);if(this.closed)break;
          if(this.controller.signal.aborted)throw new AiError('cancelled','批次已取消，未覆盖既有结果');
          const current=this.store.get<Submission>('submissions',s.id);
          stage='save';
          if(current&&current.status!=='confirmed')this.save({...current,status:'review',grade,review:structuredClone(grade.rows),error:''},'保存真实视觉建议（仍需人工确认）');
          item.state='completed';
        }catch(e){
          if(this.closed)break;item.state='failed';item.error=e instanceof AiError?e.message:'处理失败，请检查 PDF 和规则后重试';
          item.failure=e instanceof AiError?{stage,...e.diagnostic,code:e.code,retryable:e.retryable}:{stage,code:'internal',retryable:false};
          const current=this.store.get<Submission>('submissions',s.id);if(current&&current.status!=='confirmed')this.save({...current,status:current.grade?'review':'failed',error:item.error},'视觉处理失败，保留已有结果');
        }
        if(this.closed)break;
        const fresh=this.store.get<AiBatch>('ai_batches',b.id)!;fresh.items[index]=item;
        if(!fresh.items.some(i=>['queued','processing'].includes(i.state))&&fresh.status==='running')fresh.status='completed';
        fresh.updatedAt=new Date().toISOString();this.store.putAi('ai_batches',fresh);
      }
    }finally{this.running=false;this.controller=undefined;this.activeBatch=undefined;}
  }
  control(id:string,action:'pause'|'resume'|'cancel'){
    if(action==='resume'&&this.referenceParsing)throw new AiError('busy','参考页面辅助整理正在进行，请等待结束后再继续批次');
    const b=this.store.get<AiBatch>('ai_batches',id);if(!b)throw new AiError('missing','批次不存在');
    if(b.status==='completed'||b.status==='cancelled')throw new AiError('protected','此批次已结束');
    if(action==='resume'){this.requireConfig(b.provider);if(!b.items.some(i=>['queued','processing'].includes(i.state)))throw new AiError('protected','没有待续跑任务，失败项请明确重新发起');b.status='running';}else b.status=action==='pause'?'paused':'cancelled';
    if(action==='cancel'){
      if(this.activeBatch===b.id)this.controller?.abort();
      for(const item of b.items.filter(i=>i.state==='queued')){
        item.state='cancelled';const s=this.store.get<Submission>('submissions',item.submissionId);if(s&&s.status==='queued')this.save({...s,status:s.grade?'review':'uploaded'},'取消未调用任务');
      }
    }
    b.updatedAt=new Date().toISOString();this.store.putAi('ai_batches',b);if(action==='resume')void this.drain();return b;
  }
  overview(assignmentId:string){
    return {batches:this.store.all<AiBatch>('ai_batches').filter(b=>b.assignmentId===assignmentId),calls:this.store.all<AiCall>('ai_calls').filter(c=>c.assignmentId===assignmentId)};
  }
  close(){this.closed=true;this.controller?.abort();}
}
