import {useEffect,useState} from 'react';
import type {Submission} from '../shared/domain';
import type {ProviderStatus,ProviderId} from '../shared/ai';
import {api,contentUrl} from './api';
import {Modal,Notice} from './components';

type Explanation={archived:{version:string;turns:{id:string;question:string;answer:string;error?:string}[]}[];contextToken:string;version:string;key:string;reason:string;rule:{prompt:string;answer:string;missingPenalty:number|null;errorPenalty:number|null};pages:number[];studentPages:number;referencePages:{fileId:string;pages:number}[];turns:{id:string;question:string;answer:string;pages:number[];state:string;error?:string;uncertain?:boolean}[]};
export function DeductionExplanation({s,itemKey,onClose,onEdit}:{s:Submission;itemKey:string;onClose:()=>void;onEdit:()=>void}){
  const [data,setData]=useState<Explanation|null>(null),[providers,setProviders]=useState<ProviderStatus[]>([]),[provider,setProvider]=useState<ProviderId>(s.grade?.provider==='qwen'?'qwen':'deepseek');
  const [asking,setAsking]=useState(false),[question,setQuestion]=useState(''),[budget,setBudget]=useState(.1),[consent,setConsent]=useState(false),[deidentified,setDeidentified]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const url='/submissions/'+s.id+'/explanation';const query='?key='+encodeURIComponent(itemKey);
  useEffect(()=>{let active=true;void Promise.all([api<Explanation>(url+query),api<ProviderStatus[]>('/ai/providers')]).then(([d,p])=>{if(active){setData(d);setProviders(p);}}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[url,query]);
  const current=providers.find(p=>p.id===provider);
  async function ask(){if(!data)return;setBusy(true);setError('');try{setData(await api<Explanation>(url,'POST',{key:itemKey,contextToken:data.contextToken,requestId:crypto.randomUUID(),question,provider,budget,consent,deidentified}));setQuestion('');}catch(e){setError(e instanceof Error?e.message:'追问未完成');setData(await api<Explanation>(url+query).catch(()=>data));}finally{setBusy(false);setConsent(false);setDeidentified(false);}}
  return <Modal title={'解释这项扣分 · '+s.studentName} onClose={busy?()=>{}:onClose}>
    <strong>{itemKey}</strong><p>{data?.reason??(s.review??s.grade?.rows)?.find(r=>r.key===itemKey)?.reason}</p>
    {data&&<><details className="quiet-details"><summary>题目与扣分规则</summary><p>{data.rule.prompt}</p><p>参考解：{data.rule.answer||'请对照参考原页'}</p><p>错误扣 {data.rule.errorPenalty??'待核对'} 分；漏做扣 {data.rule.missingPenalty??'待核对'} 分</p>{data.referencePages.map(f=><a key={f.fileId} href={contentUrl(f.fileId)} target="_blank" rel="noreferrer">参考原稿（{f.pages} 页） </a>)}</details>
      <div className="toolbar">{data.pages.map(p=><a key={p} href={contentUrl(s.fileId)+'#page='+p} target="_blank" rel="noreferrer">第 {p} 页</a>)}<a href={contentUrl(s.fileId)} target="_blank" rel="noreferrer">完整原稿</a></div>
      {data.turns.length>0&&<section><p className="subtle">AI 解释，供人工复核</p>{data.turns.map(t=><div className="history-item" key={t.id}><p>追问：{t.question}</p><p>{t.answer||t.error||'上次追问未完成，请检查费用；不会自动重发。'}</p>{t.pages.map(p=><a key={p} href={contentUrl(s.fileId)+'#page='+p} target="_blank" rel="noreferrer">第 {p} 页 </a>)}</div>)}<button className="text-button" disabled={busy} onClick={()=>{if(window.confirm('删除本评分版本下这项扣分的追问记录？费用记录仍保留。'))void api(url+query,'DELETE').then(()=>api<Explanation>(url+query)).then(setData).catch(e=>setError(String(e)));}}>删除追问记录</button></section>}
      {data.archived.length>0&&<details className="quiet-details"><summary>此前评分版本的问答</summary>{data.archived.map(v=><div className="history-item" key={v.version}>{v.turns.map(t=><div key={t.id}><p>{t.question}</p><p>{t.answer||t.error||'未完成'}</p></div>)}<button disabled={busy} onClick={()=>{if(window.confirm('删除这份历史问答？费用记录保留。'))void api(url+query+'&version='+v.version,'DELETE').then(()=>api<Explanation>(url+query)).then(setData).catch(e=>setError(String(e)));}}>删除这份历史问答</button></div>)}</details>}
      {!asking?<button disabled={data.turns.length>=3} onClick={()=>setAsking(true)}>向 AI 追问（可能收费）</button>:<><label>追问内容<textarea aria-label="追问内容" maxLength={1000} rows={3} value={question} onChange={e=>setQuestion(e.target.value)}/></label><div className="form-grid"><label>服务<select value={provider} onChange={e=>{setProvider(e.target.value as ProviderId);setConsent(false);setDeidentified(false);}}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><label>本次追问上限（元）<input aria-label="追问预算" type="number" min=".01" max="1" step=".01" value={budget} onChange={e=>{setBudget(Number(e.target.value));setConsent(false);}}/></label></div>
        <p>本次将发送学生全部 {data.studentPages} 页、参考 {data.referencePages.reduce((n,f)=>n+f.pages,0)} 页，以及本题规则、理由和本项历史问答。</p>
        <label className="checkbox"><input type="checkbox" checked={deidentified} onChange={e=>setDeidentified(e.target.checked)}/>确认上述页面与追问已去除身份信息</label>
        <label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>授权本次云端追问，费用上限 ¥{budget.toFixed(2)}；解释不自动改分</label>
        {!current?.configured||!current.enabled?<p className="subtle">所选 AI 尚未启用，可继续查看理由或人工修改评分。</p>:null}
        <button disabled={busy||!question.trim()||!consent||!deidentified||!current?.configured||!current.enabled||budget<=0||budget>1||data.turns.length>=3} onClick={()=>void ask()}>{busy?'正在追问…':'发送本次追问'}</button></>}
    </>}
    {error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy} onClick={onEdit}>修改评分</button></div>
  </Modal>;
}
