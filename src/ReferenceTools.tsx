import {useEffect,useRef,useState} from 'react';
import type {Assignment,Config,StoredFile} from '../shared/domain';
import type {ProviderId,ProviderStatus} from '../shared/ai';
import {api} from './api';
import {Notice} from './components';

export {ReferenceSources} from './ReferencePageEditor';

type Quote={previewToken:string;estimatedCny:number;imageCount:number;warning:boolean;maxOutputTokens:number;context?:string};
export function ReferenceAssistant({assignment,files,scope,onCandidate,onBusyChange,active}:{assignment:Assignment;files:StoredFile[];scope:string;onBusyChange:(v:boolean)=>void;active:boolean;onCandidate:(config:Config,warnings:string[])=>void}){
  const materials=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf');
  const [fileId,setFileId]=useState(''),[pages,setPages]=useState('1'),[provider,setProvider]=useState<ProviderId>('deepseek');
  const [per,setPer]=useState('.5'),[total,setTotal]=useState('2'),[consent,setConsent]=useState(false),[deidentified,setDeidentified]=useState(false),[warning,setWarning]=useState(false);
  const [providers,setProviders]=useState<ProviderStatus[]>([]),[quote,setQuote]=useState<Quote|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const context=JSON.stringify([assignment.id,assignment.version,files.map(f=>f.id),scope,fileId,pages,provider,per,total,consent,deidentified]);const live=useRef(context);live.current=context;
  useEffect(()=>{void api<ProviderStatus[]>('/ai/providers').then(setProviders).catch(e=>setError(String(e)));},[]);
  useEffect(()=>{setQuote(null);setWarning(false);},[context]);
  useEffect(()=>onBusyChange(busy),[busy,onBusyChange]);
  function cancel(){setQuote(null);setConsent(false);setDeidentified(false);setWarning(false);}
  useEffect(()=>{if(!active)cancel();},[active]);
  const current=providers.find(p=>p.id===provider),valid=quote?.context===context?quote:null;
  const options=()=>({fileId,pages:pages.split(/[,，、\s]+/).filter(Boolean).map(Number),provider,scope,expectedVersion:assignment.version,consent,deidentified,perSubmissionBudget:Number(per),totalBudget:Number(total)});
  async function run(parse:boolean){
    setBusy(true);setError('');const started=live.current;
    try{
      if(parse){const result=await api<{config:Config;warnings:string[]}>(`/assignments/${assignment.id}/reference-ai/parse`,'POST',{...options(),previewToken:valid?.previewToken,warningAcknowledged:warning});if(live.current!==started)throw new Error('页面选项已变化，这次整理结果未加入题目。请查看费用记录后重新检查。');onCandidate(result.config,result.warnings);}
      else {const q=await api<Quote>(`/assignments/${assignment.id}/reference-ai/preview`,'POST',options());if(live.current===started)setQuote({...q,context:started});}
    }catch(e){setError(e instanceof Error?e.message:'辅助整理失败');}finally{if(parse)cancel();setBusy(false);}
  }
  return <div className="reference-assistant" role="region" aria-label="AI 辅助整理"><p>仅把你选中的 PDF 页面发送给 AI，可能收费。先预估费用，再决定是否开始；结果要经你检查后才能加入题目清单。</p>
    <fieldset disabled={busy} className="reference-options"><div className="form-grid"><label>参考 PDF<select value={fileId} onChange={e=>setFileId(e.target.value)}><option value="">选择文件</option>{materials.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label>原页码（每次最多4页）<input value={pages} placeholder="例如 1,2" onChange={e=>setPages(e.target.value)}/></label><label>辅助整理服务<select value={provider} onChange={e=>setProvider(e.target.value as ProviderId)}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><label>单次预算（元）<input type="number" min=".01" step=".1" value={per} onChange={e=>setPer(e.target.value)}/></label><label>本次总预算（元）<input type="number" min=".01" step=".1" value={total} onChange={e=>setTotal(e.target.value)}/></label></div>
    <p className="subtle">{current?.model??'读取配置中'} · {current?.configured?'已配置服务密钥':'尚未配置服务密钥'} · {current?.enabled?'真实调用已启用':'真实调用未启用'}。跨页题目请选全相关页面。</p>
    <label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意将所选参考页发送给所选服务商，并承担本次调用费用</label><label className="checkbox"><input type="checkbox" checked={deidentified} onChange={e=>setDeidentified(e.target.checked)}/>已确认材料有权使用，并已移除姓名、学号等个人信息</label>
    {valid&&<p role="status">预估 ¥{valid.estimatedCny.toFixed(4)} · {valid.imageCount} 幅图像。估算不代替实际账单；重复整理可能再次收费。</p>}
    {valid?.warning&&<label className="checkbox"><input type="checkbox" checked={warning} onChange={e=>setWarning(e.target.checked)}/>预估达到 ¥0.30，确认继续本次调用</label>}
    </fieldset>{error&&<Notice tone="danger">{error}</Notice>}{busy&&<p>处理中，请等待；不会自动重复调用。</p>}<div className="modal-actions"><button disabled={busy} onClick={()=>{cancel();setError('');}}>取消本次准备</button><button disabled={busy||!consent||!deidentified||!current?.configured||!current.enabled||!fileId} onClick={()=>void run(false)}>预估辅助整理费用</button><button className="primary" disabled={busy||!valid||valid.warning&&!warning} onClick={()=>void run(true)}>开始 AI 辅助整理</button></div>
  </div>;
}
