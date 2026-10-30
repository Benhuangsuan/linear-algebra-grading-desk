import {useEffect,useRef,useState} from 'react';
import type {Assignment,Config,StoredFile} from '../shared/domain';
import type {ProviderId,ProviderStatus} from '../shared/ai';
import type {ReferenceTask} from '../shared/reference-task';
import {api,contentUrl} from './api';import {Notice} from './components';
export {ReferenceSources} from './ReferencePageEditor';
type Quote={previewToken:string;estimatedCny:number;totalBudget:number;remainingBudget:number;requests:number;pages:number;files:number;overBudget:boolean;context?:string};
export function ReferenceAssistant({assignment,files,scope,onCandidate,onBusyChange,active}:{assignment:Assignment;files:StoredFile[];scope:string;onBusyChange:(v:boolean)=>void;active:boolean;onCandidate:(config:Config,warnings:string[])=>void}){
 const materials=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf');
 const [selected,setSelected]=useState<string[]>([]),[provider,setProvider]=useState<ProviderId>('deepseek'),[total,setTotal]=useState('2');
 const [providers,setProviders]=useState<ProviderStatus[]>([]),[quote,setQuote]=useState<Quote|null>(null),[task,setTask]=useState<ReferenceTask|null>(null),[preparing,setPreparing]=useState(false),[error,setError]=useState('');
 const seen=useRef(new Set<string>());const context=JSON.stringify([assignment.id,assignment.version,materials.map(f=>[f.id,f.pages]),selected,scope,provider,total]);const live=useRef(context);live.current=context;
 const running=task?.status==='running',busy=preparing||running,base=`/assignments/${assignment.id}/reference-ai`,current=providers.find(p=>p.id===provider);
 useEffect(()=>{void api<ProviderStatus[]>('/ai/providers').then(setProviders).catch(e=>setError(String(e)));},[]);
 useEffect(()=>{const ids=materials.map(f=>f.id),used=new Set(assignment.config.questions.flatMap(q=>q.referenceSources?.map(s=>s.fileId)??[])),added=ids.filter(id=>!seen.current.has(id)&&!used.has(id));ids.forEach(id=>seen.current.add(id));setSelected(old=>[...old.filter(id=>ids.includes(id)),...added]);},[JSON.stringify(materials.map(f=>f.id))]);
 useEffect(()=>{setQuote(null);},[context,active]);useEffect(()=>onBusyChange(!!busy),[busy,onBusyChange]);
 useEffect(()=>{let stopped=false;async function refresh(){try{const t=await api<ReferenceTask|null>(base+'/tasks/latest');if(!stopped)setTask(t);}catch(e){if(!stopped)setError(String(e));}}void refresh();const timer=setInterval(()=>void refresh(),700);return()=>{stopped=true;clearInterval(timer);};},[base]);
 const valid=quote?.context===context?quote:null;
 const pages=materials.filter(f=>selected.includes(f.id)).reduce((n,f)=>n+(f.pages??0),0);
 const reason=!materials.length?'请先上传参考PDF，再选择要识别的文件。':!selected.length?'请至少选择一份参考PDF。':!current?'正在读取服务配置。':!current.configured?'尚未配置所选AI服务的密钥，可按使用指南配置，或切换免费整理。':!current.enabled?'尚未启用付费调用，可按使用指南开启，或切换免费整理。':!Number.isFinite(Number(total))||Number(total)<=0||Number(total)>200?'本次总预算须大于0且不超过200元。':valid?.overBudget?'预计费用超过本次预算，可以调整预算或减少所选文件。':'';
 const options=()=>({fileIds:selected,provider,scope,expectedVersion:assignment.version,totalBudget:Number(total)});
 async function run(start:boolean){setPreparing(true);setError('');const before=live.current;try{if(start){const t=await api<ReferenceTask>(base+'/tasks','POST',{...options(),consent:true,previewToken:valid?.previewToken});setTask(t);setQuote(null);}else{const q=await api<Quote>(base+'/batch-preview','POST',options());if(before===live.current)setQuote({...q,context:before});}}catch(e){setError(e instanceof Error?e.message:'识别未完成，请检查文件及费用。');}finally{setPreparing(false);}}
 return <div className="reference-assistant" role="region" aria-label="AI 辅助整理">
  <fieldset disabled={!!busy} className="reference-options"><legend>参考 PDF</legend><div className="toolbar"><button type="button" onClick={()=>setSelected(materials.map(f=>f.id))}>全选参考文件</button><button type="button" onClick={()=>setSelected([])}>取消全选参考文件</button></div>
   {materials.map(f=><label className="checkbox" key={f.id}><input type="checkbox" aria-label={'识别 '+f.name} checked={selected.includes(f.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,f.id]:old.filter(id=>id!==f.id))}/>{f.name} · {f.pages??'?'}页</label>)}
   <p role="status">已选择{selected.length}份文件，共{pages}页（全部原页）</p>
   <div className="form-grid"><label>识别服务<select value={provider} onChange={e=>setProvider(e.target.value as ProviderId)}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><label>本次识别总预算（元）<input type="number" min="0.01" max="200" step="0.1" value={total} onChange={e=>setTotal(e.target.value)}/></label></div>
  </fieldset>
  {reason&&<Notice>{reason}</Notice>}{error&&<Notice tone="danger">{error}</Notice>}
  {valid&&<p role="status">预计费用 ¥{valid.estimatedCny.toFixed(4)} · 预算余额 ¥{valid.remainingBudget.toFixed(2)} · {valid.files}份/{valid.pages}页，计划{valid.requests}次请求。估算不代替实际账单；分批累计计费，超预算不追加调用。</p>}
  <div className="modal-actions"><button disabled={!!busy} onClick={()=>{setQuote(null);setError('');}}>取消本次准备</button><button disabled={!!busy||!!reason&& !valid?.overBudget} onClick={()=>void run(false)}>预估费用</button><button className="primary" disabled={!!busy||!!reason||!valid} onClick={()=>void run(true)}>开始 AI 整理</button></div>
  {!busy&&!valid&&!reason&&<p className="control-hint">请先预估费用，再开始识别。</p>}
  {task&&<section aria-label="参考识别进度"><h3>{running?'正在识别参考答案':task.status==='completed'?'待核对的识别结果':'识别未全部完成'}</h3><p>已发生或预留 ¥{task.committedCny.toFixed(4)}，预算余额 ¥{Math.max(0,task.totalBudget-task.committedCny).toFixed(4)}</p>
   {task.files.map(f=><p key={f.id}><a href={contentUrl(f.id)} target="_blank" rel="noreferrer">{f.name}</a> · 已处理{f.processedPages.length}/{f.pages}页 · {f.status==='completed'?'完成':f.status==='processing'?'处理中':f.status==='failed'?'失败':'未处理'}</p>)}
   {task.error&&<Notice tone="danger">{task.error} 已上传文件、原题目和费用记录保留。{task.config.questions.length>0?`已有${task.config.questions.length}道部分草稿；请先解决缺失范围，再重新预估。`:''}</Notice>}
   {task.status!=='completed'&&task.config.questions.length>0&&<details><summary>查看已完成的部分草稿（尚不可采用）</summary>{task.config.questions.map(q=><p key={q.section+(q.group??'')+q.number}>{q.section} / {q.group} {q.number} · {q.type==='completion_only'?'仅检查完成':'批改正确性'}</p>)}</details>}
   {running&&<button onClick={()=>void api<ReferenceTask>(base+'/tasks/'+task.id+'/cancel','POST',{}).then(setTask).catch(e=>setError(String(e)))}>取消后续识别</button>}
   {task.status==='completed'&&<button className="primary" disabled={task.version!==assignment.version||!!busy} onClick={()=>onCandidate(task.config,task.warnings)}>查看结果并保存</button>}
   {task.status==='completed'&&task.version!==assignment.version&&<p className="control-hint">作业设置已变化，这份草稿仅作历史参考；若要再次识别，请重新预估。</p>}
  </section>}
 </div>;
}
