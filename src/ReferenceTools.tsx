import {useEffect,useRef,useState} from 'react';
import type {Assignment,Config,StoredFile} from '../shared/domain';
import type {ReferenceSource} from '../shared/reference';
import type {ProviderId,ProviderStatus} from '../shared/ai';
import {api} from './api';
import {Modal,Notice} from './components';

export function ReferenceSources({value=[],files,onChange}:{value?:ReferenceSource[];files:StoredFile[];onChange:(s:ReferenceSource[])=>void}){
  const materials=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf');
  const [fileId,setFileId]=useState(materials[0]?.id??''),[page,setPage]=useState('1'),[error,setError]=useState('');
  return <details className="quiet-details"><summary>来源页与图形（{value.length}）</summary>
    {value.map((s,i)=>{const file=materials.find(f=>f.id===s.fileId);return <div key={s.fileId+':'+s.page} className="reference-source">
      <p>{file?.name??'来源文件已缺失'} · 第 {s.page} 页 <button type="button" className="text-button" onClick={()=>onChange(value.filter((_,j)=>j!==i))}>移除关联</button></p>
      <label className="checkbox"><input type="checkbox" checked={s.graphic} onChange={e=>onChange(value.map((v,j)=>j===i?{...v,graphic:e.target.checked}:v))}/>本页包含本题所需图形（小问继承）</label>
      {file?<details className="quiet-details"><summary>查看关联来源页</summary><img className="reference-page" src={`/api/files/${s.fileId}/pages/${s.page}`} alt={`关联参考页 ${s.page}`} onError={()=>setError('来源页图像无法读取，请检查原文件和页码；不能忽略图形继续批改。')}/></details>:<Notice>请重新关联当前作业的参考页后再批改。</Notice>}
    </div>;})}
    {materials.length>0&&<div className="form-grid"><label>关联参考文件<select value={fileId} onChange={e=>setFileId(e.target.value)}><option value="">选择文件</option>{materials.map(f=><option value={f.id} key={f.id}>{f.name}</option>)}</select></label><label>来源页码<input type="number" min="1" max={materials.find(f=>f.id===fileId)?.pages??100} value={page} onChange={e=>setPage(e.target.value)}/></label><button type="button" onClick={()=>{const n=Number(page),file=materials.find(f=>f.id===fileId);if(!file||!Number.isInteger(n)||n<1||n>(file.pages??0)){setError('请选择有效参考文件和页码。');return;}if(!value.some(s=>s.fileId===fileId&&s.page===n))onChange([...value,{fileId,page:n,graphic:true}]);setError('');}}>关联来源页</button></div>}
    {error&&<Notice tone="danger">{error}</Notice>}
  </details>;
}

type Quote={previewToken:string;estimatedCny:number;imageCount:number;warning:boolean;maxOutputTokens:number;context?:string};
export function ReferenceAssistant({assignment,files,scope,onClose,onCandidate}:{assignment:Assignment;files:StoredFile[];scope:string;onClose:()=>void;onCandidate:(config:Config,warnings:string[])=>void}){
  const materials=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf');
  const [fileId,setFileId]=useState(materials[0]?.id??''),[pages,setPages]=useState('1'),[provider,setProvider]=useState<ProviderId>('deepseek');
  const [per,setPer]=useState('.5'),[total,setTotal]=useState('2'),[consent,setConsent]=useState(false),[deidentified,setDeidentified]=useState(false),[warning,setWarning]=useState(false);
  const [providers,setProviders]=useState<ProviderStatus[]>([]),[quote,setQuote]=useState<Quote|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const context=JSON.stringify([assignment.id,assignment.version,files.map(f=>f.id),scope,fileId,pages,provider,per,total,consent,deidentified]);const live=useRef(context);live.current=context;
  useEffect(()=>{void api<ProviderStatus[]>('/ai/providers').then(setProviders).catch(e=>setError(String(e)));},[]);
  useEffect(()=>{setQuote(null);setWarning(false);},[context]);
  const current=providers.find(p=>p.id===provider),valid=quote?.context===context?quote:null;
  const options=()=>({fileId,pages:pages.split(/[,，、\s]+/).filter(Boolean).map(Number),provider,scope,expectedVersion:assignment.version,consent,deidentified,perSubmissionBudget:Number(per),totalBudget:Number(total)});
  async function run(parse:boolean){
    setBusy(true);setError('');const started=live.current;
    try{
      if(parse){const result=await api<{config:Config;warnings:string[]}>(`/assignments/${assignment.id}/reference-ai/parse`,'POST',{...options(),previewToken:valid?.previewToken,warningAcknowledged:warning});if(live.current!==started)throw new Error('页面选项已变化，未采用旧候选；请查看费用记录后人工检查。');onCandidate(result.config,result.warnings);}
      else {const q=await api<Quote>(`/assignments/${assignment.id}/reference-ai/preview`,'POST',options());if(live.current===started)setQuote({...q,context:started});}
    }catch(e){setError(e instanceof Error?e.message:'辅助整理失败');}finally{setBusy(false);}
  }
  return <Modal title="参考页面辅助整理" onClose={()=>{if(!busy)onClose();}}><p>仅对所选复杂页面生成可编辑候选，不改评分规则或已保存题目。真实调用会将所选参考页发送给服务商，可能收费；解析仍须人工校对，跨页内容须完整选择。上传文件不会自动调用。</p>
    <fieldset disabled={busy} className="reference-options"><div className="form-grid"><label>参考 PDF<select value={fileId} onChange={e=>setFileId(e.target.value)}><option value="">选择文件</option>{materials.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label>原页码（每次最多4页）<input value={pages} placeholder="例如 1,2" onChange={e=>setPages(e.target.value)}/></label><label>辅助整理服务<select value={provider} onChange={e=>setProvider(e.target.value as ProviderId)}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><label>单次预算（元）<input type="number" min=".01" step=".1" value={per} onChange={e=>setPer(e.target.value)}/></label><label>本次总预算（元）<input type="number" min=".01" step=".1" value={total} onChange={e=>setTotal(e.target.value)}/></label></div>
    <p className="subtle">{current?.model??'读取配置中'} · {current?.configured?'已检测到 Key':'未检测到 Key'} · {current?.enabled?'真实调用已启用':'真实调用未启用'}。仅支持现有视觉模型白名单；不支持图片时请人工整理。</p>
    <label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意将所选参考页发送给所选服务商，并承担本次调用费用</label><label className="checkbox"><input type="checkbox" checked={deidentified} onChange={e=>setDeidentified(e.target.checked)}/>已确认材料有权使用并完成必要去标识</label>
    {valid&&<p role="status">预估 ¥{valid.estimatedCny.toFixed(4)} · {valid.imageCount} 幅图像 · 输出上限 {valid.maxOutputTokens}。估算不代替实际账单；重复整理可能再次收费。</p>}
    {valid?.warning&&<label className="checkbox"><input type="checkbox" checked={warning} onChange={e=>setWarning(e.target.checked)}/>预估达到 ¥0.30，确认继续本次调用</label>}
    </fieldset>{error&&<Notice tone="danger">{error}</Notice>}{busy&&<p>处理中，请等待；不会自动重复调用。</p>}<div className="modal-actions"><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy||!consent||!deidentified||!current?.configured||!current.enabled||!fileId} onClick={()=>void run(false)}>预估辅助整理费用</button><button className="primary" disabled={busy||!valid||valid.warning&&!warning} onClick={()=>void run(true)}>确认调用并生成候选</button></div>
  </Modal>;
}
