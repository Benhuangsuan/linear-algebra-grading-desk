import {useState} from 'react';
import type {StoredFile} from '../shared/domain';
import type {ReferenceResultSummary,ReferenceSelection} from '../shared/reference-task';
import {api} from './api';

export function ReferenceResults({file,results,phase,busy,processing,onView,onRecover,onRetry,onReparse}:{file:StoredFile;results:ReferenceResultSummary[];phase:string;busy:boolean;processing?:boolean;onView:(selection:ReferenceSelection,complete:boolean)=>void;onRecover:(selection:ReferenceSelection)=>void;onRetry:(selection:ReferenceSelection)=>void;onReparse:()=>void}){
 const [chosen,setChosen]=useState(''),[diagnostic,setDiagnostic]=useState<unknown>(null);
 const latest=results[0],complete=results.find(r=>r.status==='complete'&&r.available),current=results.find(r=>r.id===chosen)??complete??latest;
 const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
 return <div className="reference-file-results">
  <span className="reference-file-state">{processing?'正在整理，可继续查看已有完整结果':complete?`已整理 ${complete.questionCount} 道 · ${phase}`:latest?`本文件未整理完整${latest.questionCount?`，保留 ${latest.questionCount} 道部分草稿`:''}`:'尚未整理'}{latest?.status!=='complete'&&complete?'；上次尝试未完成，已有完整结果仍可使用':''}</span>
  <div className="toolbar">
   {complete&&<button type="button" onClick={()=>onView({fileId:file.id,resultId:complete.id},true)}>查看已识别结果</button>}
   {complete&&<button type="button" disabled={busy} onClick={onReparse}>重新整理</button>}
   {latest&&latest.status!=='complete'&&<><button type="button" disabled={busy} onClick={()=>onRetry({fileId:file.id,resultId:latest.id})}>重试本文件</button>{latest.hasResponse&&<button type="button" disabled={busy} onClick={()=>onRecover({fileId:file.id,resultId:latest.id})}>免费尝试恢复</button>}</>}
  </div>
  {latest&&latest.status!=='complete'&&latest.error&&<p className="reference-file-error">{latest.error}</p>}
  {results.length>0&&<details className="reference-history"><summary>历史结果（{results.length} 版）</summary><label>选择结果版本<select aria-label={'历史结果 '+file.name} value={current?.id??''} onChange={e=>{setChosen(e.target.value);setDiagnostic(null);}}>{results.map(r=><option key={r.id} value={r.id}>{date(r.createdAt)} · {r.status==='complete'?'完整':'未完整'} · {r.questionCount} 道 · ¥{r.estimatedCny.toFixed(4)}{r.usageUnknown?'（含未知用量预留）':''}</option>)}</select></label>
   {current&&<><button type="button" disabled={!current.available||!current.questionCount} onClick={()=>onView({fileId:file.id,resultId:current.id},current.status==='complete')}>{current.status==='complete'?'查看这个完整版本':'查看部分草稿（不能采用）'}</button>{!current.available&&<p>{current.unavailableReason}</p>}<details onToggle={e=>{if(e.currentTarget.open)void api(`/assignments/${file.assignmentId}/reference-ai/results/${current.id}/diagnostics`).then(setDiagnostic).catch(()=>setDiagnostic({message:'详情暂时无法读取，请刷新后查看。'}));}}><summary>技术详情</summary>{diagnostic!==null&&<pre className="reference-diagnostic">{JSON.stringify(diagnostic,null,2)}</pre>}</details></>}
  </details>}
 </div>;
}
