import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApp} from '../server/app.js';import {testDirectory,syntheticPdf} from './fixtures.js';import {styledReference} from './reference-fixtures.js';
import {courseConfig,parseCourseMaterials} from '../shared/course.js';import {questionKey,type Assignment,type StoredFile,type State} from '../shared/domain.js';
import type {ReferenceTask} from '../shared/reference-task.js';import {referenceFacts,referenceBatchCandidate,checkReferenceCompleteness,personalInformation} from '../server/ai/reference-batch.js';
import {parseReferenceMaterials} from '../server/reference-parser.js';import type {AiCall} from '../shared/ai.js';

import {batchResponse} from './reference-batch-fixtures.js';
async function harness(long=false){
 const dir=testDirectory('reference-batch-');let count=0,mode='normal';let gate:Promise<void>|undefined;const bodies:any[]=[];
 const runtime=createApp(dir,{env:{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-only'},fetcher:async(_u,init)=>{count++;const body=JSON.parse(String(init?.body));bodies.push(body);if(gate)await gate;if(mode==='timeout')throw Error('Synthetic timeout');const context=JSON.parse(body.messages[1].content[0].text);const file=runtime.store.all<StoredFile>('files').find(f=>f.name.startsWith(context.sections[0]))!;const data=batchResponse(file,context.pages);if(mode==='omit')data.questions=data.questions.filter(q=>q.type!=='completion_only');if(mode==='page')data.processedPages=[];if(mode==='source')data.questions[0].sources=[{page:99,graphic:false}];if(mode==='type')data.questions[0].type=data.questions[0].type==='graded'?'completion_only':'graded';return Response.json({choices:[{message:{content:JSON.stringify(data)},finish_reason:mode==='length'?'length':'stop'}],usage:{prompt_tokens:mode==='expensive'?160000:1000,completion_tokens:100}});}});runtime.app.use(runtime.errorHandler);
 const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api';
 async function req<T>(path:string,body?:unknown,method=body?'POST':'GET',status=method==='POST'&&(['/courses','/assignments'].includes(path)||path.endsWith('/files'))?201:200):Promise<T>{const form=body instanceof FormData;const r=await fetch(base+path,{method,headers:body&&!form?{'content-type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data as T;}
 const c=await req<{id:string}>('/courses',{name:'Synthetic batch course'});const a=await req<Assignment>('/assignments',{courseId:c.id,title:'Synthetic reference batch',scope:'自由范围',description:'',config:courseConfig()});
 const files:StoredFile[]=[];for(const [name,bytes] of [['3.3 synthetic.pdf',await styledReference()],['4.1 synthetic.pdf',await syntheticPdf('习题4.1 参考答案\n注：奇数题仅检查完成，偶数题需批改。\n奇数题：\nSynthetic 习题4.1，题目1,3\n偶数题答案：\n2. Synthetic prompt\nSynthetic answer')]] as const){const form=new FormData();form.append('kind','reference');form.append('file',new Blob([new Uint8Array(bytes)]),name);files.push(await req<StoredFile>('/assignments/'+a.id+'/files',form));}
 if(long){const form=new FormData();form.append('kind','reference');form.append('file',new Blob([new Uint8Array(await syntheticPdf('习题4.2 参考答案\n2. Synthetic long prompt\n'+Array(140).fill('Synthetic continuation').join('\n')))]),'4.2 long.pdf');files.push(await req<StoredFile>('/assignments/'+a.id+'/files',form));}
 const path='/assignments/'+a.id+'/reference-ai',options={fileIds:files.map(f=>f.id),provider:'deepseek',scope:a.scope,expectedVersion:a.version,totalBudget:2};
 const wait=async()=>{for(let i=0;i<500;i++){const t=await req<ReferenceTask>(path+'/tasks/latest');if(t.status!=='running')return t;await new Promise(r=>setTimeout(r,10));}throw Error('Task not finished');};
 return {runtime,req,a,files,path,options,wait,bodies,dir,get count(){return count;},mode:(s:string)=>mode=s,gate:(p:Promise<void>)=>gate=p,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));runtime.close();}};
}
test('章节同行的奇数题列表保留；免费两模式和全部批改优先，不虚构答案',()=>{
 const material={id:'synthetic',name:'4.1.pdf',text:'习题4.1 参考答案\n注：奇数题仅检查完成，偶数题需批改。\n奇数题：\nSynthetic 习题4.1，题目1,3\n偶数题答案：\n2. Synthetic prompt\nSynthetic answer'};
 for(const strategy of ['auto','text'] as const){const q=parseReferenceMaterials([material],'中文',strategy).questions;assert.deepEqual(q.map(p=>[p.number,p.type]),[['1','completion_only'],['3','completion_only'],['2','graded']]);assert.ok(q.filter(p=>p.type==='completion_only').every(p=>!p.prompt&&!p.answer));}
 assert.equal(parseCourseMaterials([material.text],'').length,3);assert.equal(personalInformation('姓名：测试姓名'),true);assert.equal(personalInformation('习题4.1 总分10'),false);
});
test('多文件全页任务：绑定预估、累计账本、未授权拦截、完整草稿不改已有规则，重启保留',async()=>{
 const h=await harness();let task:ReferenceTask,calls:AiCall[];
 try{assert.equal(h.count,0);const before=await h.req<State>('/state');const quote=await h.req<any>(h.path+'/batch-preview',h.options);assert.equal(quote.pages,3);assert.equal(quote.files,2);assert.equal(quote.requests,2);assert.equal(h.count,0);
 await h.req(h.path+'/tasks',{...h.options,previewToken:quote.previewToken},'POST',400);await h.req(h.path+'/tasks',{...h.options,totalBudget:3,consent:true,previewToken:quote.previewToken},'POST',400);assert.equal(h.count,0);
 await h.req(h.path+'/tasks',{...h.options,consent:true,previewToken:quote.previewToken});task=await h.wait();assert.equal(task.status,'completed',task.error);assert.deepEqual(task.files.map(f=>f.processedPages),[[1,2],[1]]);assert.equal(h.count,2);assert.equal(task.config.questions.length,10);assert.equal(task.config.confirmed,false);assert.deepEqual((await h.req<State>('/state')).assignments,before.assignments);calls=h.runtime.store.all('ai_calls');assert.equal(calls.length,2);assert.equal(task.committedCny,calls.reduce((n,c)=>n+c.estimatedCny!,0));
 assert.ok(task.config.questions.find(q=>q.number==='32')!.referenceSources!.some(s=>s.graphic));assert.ok(h.bodies.every(b=>b.messages[1].content.some((c:any)=>c.type==='image_url')));
 }finally{await h.close();}
 const reopened=createApp(h.dir,{env:{}});try{assert.deepEqual(reopened.store.get('reference_tasks',task!.id),task!);assert.deepEqual(reopened.store.all('ai_calls'),calls!);}finally{reopened.close();}
});
test('遗漏完成性题、处理页缺失、错页、错误分类、截断、网络中断均拒绝成功且保留账本',async()=>{
 for(const mode of ['omit','page','source','type','length','timeout']){const h=await harness();try{h.mode(mode);const quote=await h.req<any>(h.path+'/batch-preview',h.options);await h.req(h.path+'/tasks',{...h.options,consent:true,previewToken:quote.previewToken});const t=await h.wait();assert.equal(t.status,'failed',mode);assert.ok(t.error);assert.equal((await h.req<State>('/state')).assignments[0].config.questions.length,0);assert.ok(t.committedCny>0);assert.equal(h.count,1,'失败不自动重试或继续下一文件');}finally{await h.close();}}
});
test('预算超额不发请求，重复启动互斥，取消不续发，未知用量与重启中断保留',async()=>{
 const h=await harness();let release!:()=>void;try{
 const small={...h.options,totalBudget:.001};const quote=await h.req<any>(h.path+'/batch-preview',small);assert.equal(quote.overBudget,true);await h.req(h.path+'/tasks',{...small,consent:true,previewToken:quote.previewToken},'POST',400);assert.equal(h.count,0);
 h.gate(new Promise<void>(r=>release=r));const q=await h.req<any>(h.path+'/batch-preview',h.options);const t=await h.req<ReferenceTask>(h.path+'/tasks',{...h.options,consent:true,previewToken:q.previewToken});await h.req(h.path+'/tasks',{...h.options,consent:true,previewToken:q.previewToken},'POST',400);
 await h.req(h.path+'/tasks/'+t.id+'/cancel',{});release();const end=await h.wait();assert.equal(end.status,'cancelled');await new Promise(r=>setTimeout(r,40));assert.equal(h.count,1);assert.ok(h.runtime.store.all<AiCall>('ai_calls')[0].reservedCny>0);
 h.runtime.store.putAi('reference_tasks',{...end,id:'interrupted',status:'running'});
 }finally{release?.();await h.close();}
 const reopened=createApp(h.dir,{env:{}});try{assert.equal(reopened.store.get<ReferenceTask>('reference_tasks','interrupted')!.status,'interrupted');}finally{reopened.close();}
});
test('严格结构契约拒绝跨文件章节、重复大题、小问/父题冲突且未知分类须人工确认',async()=>{
 const h=await harness();try{const file=h.files[0],raw=batchResponse(file,[1,2]);const first=raw.questions[0];assert.throws(()=>referenceBatchCandidate(JSON.stringify({...raw,questions:[first,first]}),file,[1,2]));assert.throws(()=>referenceBatchCandidate(JSON.stringify({...raw,questions:[{...first,section:'9.9'}]}),file,[1,2]));const unknown={...first,type:'uncertain' as const};assert.equal(referenceBatchCandidate(JSON.stringify({...raw,questions:[unknown]}),file,[1,2])[0].typeConfirmed,false);}finally{await h.close();}
});
test('超过四页时重叠分批覆盖全部原页，跨页题合并为同一题且不截断',async()=>{
 const h=await harness(true);try{const quote=await h.req<any>(h.path+'/batch-preview',h.options);assert.equal(quote.requests,4);assert.equal(quote.pages,9);await h.req(h.path+'/tasks',{...h.options,consent:true,previewToken:quote.previewToken});const task=await h.wait();assert.equal(task.status,'completed',task.error);assert.deepEqual(task.files.at(-1)?.processedPages,[1,2,3,4,5,6]);assert.equal(task.config.questions.filter(q=>q.section==='4.2').length,1);assert.equal(task.config.questions.find(q=>q.section==='4.2')?.referenceSources?.length,6);}finally{await h.close();}
});
test('前次真实用量高于预估后，服务端按累计费用拒绝下一请求，不为用完页面突破总预算',async()=>{
 const h=await harness();try{const initial=await h.req<any>(h.path+'/batch-preview',h.options);const options={...h.options,totalBudget:initial.estimatedCny+.00001};const quote=await h.req<any>(h.path+'/batch-preview',options);h.mode('expensive');await h.req(h.path+'/tasks',{...options,consent:true,previewToken:quote.previewToken});const task=await h.wait();assert.equal(task.status,'failed');assert.match(task.error,/预算/);assert.equal(h.count,1);assert.equal(task.files[1].processedPages.length,0);assert.ok(task.committedCny>0);}finally{await h.close();}
});
test('原文其他题组也保留独立身份；全部批改声明优先且无依据分类不冒充已确认',()=>{
 const file={id:'synthetic',name:'第7节 Synthetic.pdf',text:'补充章第7节 参考答案\n注：所有题目均需批改。\n课堂题答案：\n3. Synthetic prompt\nSynthetic answer'} as StoredFile;
 const raw={processedPages:[1],questions:[{section:'补充章第7节',group:'课堂题',number:'3',type:'graded',typeEvidence:'所有题目均需批改',excerpt:'3. Synthetic prompt',prompt:'Synthetic prompt',answer:'Synthetic answer',kind:'solution',children:[],sources:[{page:1,graphic:false}],reviewReasons:[]}]};
 const [q]=referenceBatchCandidate(JSON.stringify(raw),file,[1]);assert.equal(q.allGraded,true);assert.equal(q.type,'graded');assert.equal(q.group,'课堂题');assert.equal(parseReferenceMaterials([file],'').questions[0].group,'课堂题');
 const inherited=referenceBatchCandidate(JSON.stringify({...raw,questions:[{...raw.questions[0],children:[{label:'a',prompt:'Synthetic child',answer:'Synthetic child answer'}]}]}),file,[1])[0];assert.deepEqual(inherited.children?.[0].referenceSources,inherited.referenceSources);
 const unknown={...file,text:'补充章第7节\n课堂题答案：\n3. Synthetic prompt\nSynthetic answer'};assert.equal(referenceBatchCandidate(JSON.stringify(raw),unknown,[1])[0].typeConfirmed,false);
});
test('无题干的仅完成题允许已知题型别名，正确性题、带内容或小问仍严格拒绝',()=>{
 const file={id:'synthetic-alias',name:'4.1.pdf',text:'习题4.1 参考答案\n注：奇数题仅检查完成，偶数题需批改。\n奇数题：\n题目1'} as StoredFile;
 const item={section:'4.1',number:'1',type:'completion_only',typeEvidence:'原文仅检查完成',excerpt:'题目1',prompt:'',answer:'',kind:'completion',children:[],sources:[{page:1,graphic:false}],reviewReasons:[]};
 const raw=(q:unknown)=>JSON.stringify({processedPages:[1],questions:[q]});const [q]=referenceBatchCandidate(raw(item),file,[1]);assert.equal(q.type,'completion_only');assert.equal(q.kind,'solution');assert.equal(q.errorPenalty,0);assert.equal(q.prompt,'');assert.equal(q.answer,'');assert.match(q.parseWarning!,/题型未细分/);const {children:_children,...withoutChildren}=item;assert.equal(referenceBatchCandidate(raw(withoutChildren),file,[1])[0].children?.length,0);
 for(const bad of [{...item,type:'graded'},{...item,prompt:'Unexpected content'},{...item,children:[{label:'a',prompt:'',answer:''}]},{...item,kind:'unrecognized'}])assert.throws(()=>referenceBatchCandidate(raw(bad),file,[1]));
});
test('明确续验时保留已通过的文件草稿和费用，只处理尚未发送的计划，不自动重试',async()=>{
 const h=await harness();try{const quoted=await(h.runtime.ai as any).prepareReferenceBatch(h.a.id,h.options);const savedFile=h.runtime.store.get<StoredFile>('files',h.files[0].id)!;const savedQuestions=referenceBatchCandidate(JSON.stringify(batchResponse(savedFile,[1,2])),savedFile,[1,2]);
 const task:ReferenceTask={id:'reference-resume-fixture',assignmentId:h.a.id,version:h.a.version,provider:'deepseek',status:'running',createdAt:new Date().toISOString(),error:'',warnings:[],config:{...courseConfig(),questions:savedQuestions},estimatedCny:quoted.estimatedCny,totalBudget:2,committedCny:0,files:h.files.map((f,i)=>({id:f.id,name:f.name,pages:f.pages!,processedPages:i===0?[1,2]:[],status:i===0?'completed':'waiting'}))};
 h.runtime.store.putAi('reference_tasks',task);(h.runtime.ai as any).referenceParsing=true;(h.runtime.ai as any).referenceController=new AbortController();await(h.runtime.ai as any).runReferenceTask(task,{...quoted,plans:quoted.plans.filter((p:any)=>p.file.id!==savedFile.id)});
 const final=h.runtime.store.get<ReferenceTask>('reference_tasks',task.id)!;assert.equal(final.status,'completed',final.error);assert.equal(final.config.questions.length,10);assert.equal(h.count,1);assert.deepEqual(final.config.questions.slice(0,savedQuestions.length),savedQuestions);assert.equal(h.runtime.store.all('ai_calls').length,1);
 }finally{await h.close();}
});
test('未写空小问列表可规范化；原页明确的小问仍须通过完整性检查',async()=>{
 const h=await harness();try{const file=h.files[0],raw=batchResponse(file,[1,2]);const omitted={...raw,questions:raw.questions.map(({children,...rest})=>rest)};const questions=referenceBatchCandidate(JSON.stringify(omitted),file,[1,2]);assert.ok(questions.every(q=>q.children?.length===0));assert.throws(()=>checkReferenceCompleteness(file,questions),/小问/);
 const singleFile=h.files[1],single=batchResponse(singleFile,[1]);const noChildren={...single,questions:single.questions.map(({children,...rest})=>rest)};const simple=referenceBatchCandidate(JSON.stringify(noChildren),singleFile,[1]);assert.equal(simple.length,3);assert.doesNotThrow(()=>checkReferenceCompleteness(singleFile,simple));
 }finally{await h.close();}
});
