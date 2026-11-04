import {useEffect,useRef,useState} from 'react';
import type {Assignment,Submission,StoredFile} from '../shared/domain';
import {questionKey} from '../shared/domain';
import type {AiBatch,AiCall,ProviderId,ProviderStatus,FileCheck,CheckResult} from '../shared/ai';
import {unitConfig} from '../shared/units';
import {api} from './api';
import {Modal,Notice} from './components';
import {aiSelectionReason,hasFormalResult,type RemovedSelection} from '../shared/submission-state';
import {aiActionBlockers,gradingBlockers} from '../shared/ai-readiness';

export function AiControls({assignment,submissions,files,selectedIds,removedSelections,regradeTargetId,onCloseRegrade,onRetrySubmission,onExclude,onRefresh,onSetup}:{assignment:Assignment;submissions:Submission[];files:StoredFile[];selectedIds:string[];removedSelections:RemovedSelection[];regradeTargetId:string|null;onCloseRegrade:()=>void;onRetrySubmission:(id:string)=>void;onExclude:(ids:string[])=>void;onRefresh:()=>Promise<void>;onSetup:()=>void}){
  const [open,setOpen]=useState(false),[providers,setProviders]=useState<ProviderStatus[]>([]),[provider,setProvider]=useState<ProviderId>('deepseek');
  const [maxOutput,setMaxOutput]=useState<number|undefined>();const current=providers.find(p=>p.id===provider),outputLimit=maxOutput??current?.defaultMaxOutputTokens??16384;
  const [consent,setConsent]=useState(false),[deidentified,setDeidentified]=useState(false),[unitsConfirmed,setUnitsConfirmed]=useState(false);
  const [per,setPer]=useState(.5),[total,setTotal]=useState(2),[regrade,setRegrade]=useState(false);
  const [checks,setChecks]=useState<Record<string,FileCheck&{context:string;revision:number}>>({}),[job,setJob]=useState<{id:string;context:string;revisions:Record<string,number>}|null>(null);
  const [overview,setOverview]=useState<{batches:AiBatch[];calls:AiCall[]}>({batches:[],calls:[]});
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const ids=regradeTargetId?[regradeTargetId]:selectedIds,selected=ids.map(id=>submissions.find(s=>s.id===id)).filter((s):s is Submission=>!!s);
  const context=JSON.stringify({assignment:assignment.id,version:assignment.version,config:assignment.config,references:files.filter(f=>f.kind!=='student'),provider,outputLimit,regrade});
  const live=useRef(context);live.current=context;
  const targets=JSON.stringify([context,selected.map(s=>[s.id,s.revision,s.status,s.fileId])]);
  useEffect(()=>{setConsent(false);setDeidentified(false);setUnitsConfirmed(false);},[targets]);
  useEffect(()=>{if(regradeTargetId){setRegrade(true);setOpen(true);}},[regradeTargetId]);
  const checkFor=(s:Submission)=>{const c=checks[s.id];return c?.context===context&&c.revision===s.revision?c:undefined;};
  const results=selected.map(s=>checkFor(s)),blocked=selected.filter(s=>checkFor(s)?.state==='blocked'),passed=results.filter(c=>c?.state==='ready').length;
  const startReasons=aiActionBlockers({assignment,files,ids,submissions,provider:current,batches:overview.batches,regrade,consent,deidentified,unitsConfirmed,busy,per,total});
  if(passed!==ids.length||!ids.length)startReasons.push({code:'check',message:blocked.length?'请移出无法批改的文件后开始。':'请先完成所选文件的快速检查。'});
  const rules=gradingBlockers(assignment,files);let units:string[]=[];try{units=unitConfig(assignment.config).questions.map(questionKey);}catch{/* Shared blockers explain missing rules. */}
  const reload=async()=>setOverview(await api('/assignments/'+assignment.id+'/ai'));
  useEffect(()=>{
    if(!open)return;let active=true;void api<ProviderStatus[]>('/ai/providers').then(p=>{if(active)setProviders(p);}).catch(e=>{if(active)setError(String(e));});
    const sync=()=>Promise.all([reload(),onRefresh()]).catch(e=>{if(active)setError(String(e));});void sync();const t=window.setInterval(()=>void sync(),2000);return()=>{active=false;window.clearInterval(t);};
  },[open,assignment.id,onRefresh]);
  useEffect(()=>{
    if(!open||!job)return;let active=true;
    const poll=async()=>{try{const r=await api<CheckResult>('/assignments/'+assignment.id+'/ai/check/'+job.id);if(!active||live.current!==job.context)return;setChecks(old=>({...old,...Object.fromEntries(r.items.map(i=>[i.submissionId,{...i,context:job.context,revision:job.revisions[i.submissionId]}]))}));if(r.done)setJob(null);}catch(e){if(active){setError(String(e));setJob(null);}}};
    void poll();const t=window.setInterval(()=>void poll(),400);return()=>{active=false;window.clearInterval(t);};
  },[open,job,assignment.id]);
  async function act(action:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(e instanceof Error?e.message:'操作失败');await onRefresh().catch(()=>{});}finally{setBusy(false);}}
  async function check(){await act(async()=>{const requested=context,revisions=Object.fromEntries(selected.map(s=>[s.id,s.revision]));const result=await api<CheckResult>('/assignments/'+assignment.id+'/ai/check','POST',{ids,expectedVersion:assignment.version,provider,maxOutputTokens:outputLimit,regrade});if(live.current===requested){setChecks(old=>({...old,...Object.fromEntries(result.items.map(i=>[i.submissionId,{...i,context:requested,revision:revisions[i.submissionId]}]))}));setJob({id:result.id,context:requested,revisions});}});}
  async function control(id:string,action:'pause'|'resume'|'cancel'){if(action==='resume'&&!window.confirm('继续此已授权批次，仍受原预算限制。继续？'))return;await act(async()=>{await api('/ai/batches/'+id+'/control','POST',{action});await reload();await onRefresh();});}
  function close(){setOpen(false);setConsent(false);setDeidentified(false);setUnitsConfirmed(false);onCloseRegrade();}
  return <><button disabled={assignment.archived} onClick={()=>{setRegrade(false);setOpen(true);}}>AI 批改已选{selectedIds.length?'（'+selectedIds.length+'）':''}</button>{open&&<Modal title={regradeTargetId?'重新 AI 批改':'AI 批改'} onClose={close}>
    <details className="quiet-details" open><summary>本次已选 {ids.length} 份作业</summary><div className="selected-submissions">{selected.map(s=>{const c=checkFor(s);return <p key={s.id}><strong>{s.studentName}</strong> · {s.studentId||'未填学号'}<br/><span className="subtle">{files.find(f=>f.id===s.fileId)?.name??'文件已删除'}</span><br/><span className={c?.state==='blocked'?'danger-text':''}>{c?.state==='blocked'?'无法批改：':''}{c?.message??'待检查'}</span>{!regradeTargetId&&<button className="text-button" onClick={()=>onExclude([s.id])}>移出本次</button>}</p>;})}</div></details>
    {blocked.length>0&&!regradeTargetId&&<button onClick={()=>onExclude(blocked.map(s=>s.id))}>移出无法批改的文件（{blocked.length}）</button>}
    {results.some(Boolean)&&<p role="status">已检查 {results.filter(c=>c&&c.state!=='checking').length}/{ids.length} 份，可批改 {passed} 份</p>}
    {!regradeTargetId&&removedSelections.length>0&&<p className="subtle">已移除：{removedSelections.map(r=>r.name+'（'+r.reason+'）').join('；')}</p>}
    <div className="form-grid"><label>服务<select aria-label="AI 服务" value={provider} onChange={e=>{setProvider(e.target.value as ProviderId);setMaxOutput(undefined);}}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><div><p>{current?.model??'正在读取配置…'}</p><p className="subtle">{current?.configured?'已配置密钥':'尚未配置密钥'}</p></div></div>
    <details className="quiet-details"><summary>如何启用 AI</summary><p>按《助教本地部署与使用指南》配置密钥并开启付费调用，再重启平台。</p><button disabled={busy||!current?.configured||!current.enabled} onClick={()=>{if(window.confirm('发送一张合成图片测试连接，可能收费。继续？'))void act(async()=>{const r=await api<{message:string}>('/ai/providers/'+provider+'/test','POST',{consent:true});setMessage(r.message);});}}>测试连接</button></details>
    <details className="quiet-details"><summary>核对计分题目（{units.length}）</summary><p>{units.join('；')}</p></details>
    {rules.length>0&&<Notice tone="danger">{!assignment.config.confirmed||!assignment.config.questions.length?'需先核对题目清单':rules[0].message} <button onClick={()=>{close();onSetup();}}>前往作业设置</button></Notice>}
    <div className="form-grid"><label>每份预算上限（元）<input aria-label="每份预算" type="number" min=".01" max="20" step=".01" value={per} onChange={e=>setPer(Number(e.target.value))}/></label><label>本批总预算（元）<input aria-label="批次预算" type="number" min=".01" max="200" step=".1" value={total} onChange={e=>setTotal(Number(e.target.value))}/></label></div>
    {regradeTargetId&&<p className="subtle">重新批改可能产生新增费用，请核对本次目标与预算。</p>}
    <details className="quiet-details"><summary>批改选项 · 输出额度 {outputLimit}</summary><label>输出额度（token）<select aria-label="输出额度" value={outputLimit} onChange={e=>setMaxOutput(Number(e.target.value))}>{[...new Set([8192,16384,32768,current?.defaultMaxOutputTokens??16384])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n}</option>)}</select></label><label className="checkbox"><input type="checkbox" checked={regrade} disabled={!!regradeTargetId} onChange={e=>setRegrade(e.target.checked)}/>明确忽略已有结果缓存并重批（新增费用）</label></details>
    <label className="checkbox"><input type="checkbox" checked={unitsConfirmed} onChange={e=>setUnitsConfirmed(e.target.checked)}/>已核对本次计分题目与扣分规则</label>
    <label className="checkbox"><input type="checkbox" checked={deidentified} onChange={e=>setDeidentified(e.target.checked)}/>学生与参考 PDF 页面已去除姓名、学号等身份信息</label>
    <label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用</label>
    <p className="subtle">按所设预算逐次拦截请求，服务商最终账单可能有差异。</p>
    {error&&<Notice tone="danger">{error}</Notice>}{message&&<Notice>{message}</Notice>}
    {startReasons.length>0&&!rules.length&&startReasons[0].code!=='consent'&&<p className="action-guidance" role="status" aria-label="下一步操作指引">{startReasons[0].message}</p>}
    <div className="modal-actions"><button onClick={close}>关闭</button><button disabled={busy||!!job&&job.context===context||!ids.length||rules.length>0} onClick={()=>void check()}>快速检查</button><button className="primary" disabled={startReasons.length>0} onClick={()=>void act(async()=>{await api('/assignments/'+assignment.id+'/ai/queue','POST',{ids,provider,expectedVersion:assignment.version,maxOutputTokens:outputLimit,regrade,consent,deidentified,unitsConfirmed,perSubmissionBudget:per,totalBudget:total,checkTokens:Object.fromEntries(selected.map(s=>[s.id,checkFor(s)!.token]))});setMessage('已安排所选学生的批改');await reload();await onRefresh();})}>开始 AI 批改</button></div>
    <details className="quiet-details"><summary>批次与费用</summary>{overview.batches.slice().reverse().map(b=><div className="history-item" key={b.id}><p>{b.provider==='deepseek'?'DeepSeek':'Qwen'} · {{running:'批改中',paused:'已暂停',cancelled:'已取消',completed:'已结束'}[b.status]} · 完成 {b.items.filter(i=>i.state==='completed').length}/{b.items.length}</p>{b.items.filter(i=>i.error).map(i=><p className="danger-text" key={i.submissionId}>{submissions.find(s=>s.id===i.submissionId)?.studentName??'该提交'}：{i.error}{(()=>{const s=submissions.find(s=>s.id===i.submissionId);return s&&!hasFormalResult(s)&&!aiSelectionReason(s,true)?<button disabled={busy} onClick={()=>{setConsent(false);setDeidentified(false);setUnitsConfirmed(false);setRegrade(true);onRetrySubmission(s.id);}}>仅重试此份…</button>:null;})()}</p>)}{['running','paused'].includes(b.status)&&<div className="toolbar"><button disabled={busy} onClick={()=>void control(b.id,b.status==='running'?'pause':'resume')}>{b.status==='running'?'暂停后续调用':'继续批次'}</button><button disabled={busy} onClick={()=>void control(b.id,'cancel')}>取消批次</button></div>}</div>)}{overview.calls.map(c=><p className="subtle" key={c.id}>{c.purpose==='explanation'?'扣分追问':c.purpose==='reference_parse'?'参考答案整理':c.purpose==='connection'?'服务连接测试':submissions.find(s=>s.id===c.submissionId)?.studentName??'已删除提交'} · {c.status==='failed'?'未完成':c.status==='success'?'已完成':'处理中'} · {c.estimatedCny===null?'费用未知，预留 ¥'+c.reservedCny.toFixed(4):'用量折算 ¥'+c.estimatedCny.toFixed(4)}</p>)}</details>
  </Modal>}</>;
}
