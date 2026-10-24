import {useEffect,useRef,useState} from 'react';
import type {Assignment,Submission,StoredFile} from '../shared/domain';
import {questionKey} from '../shared/domain';
import type {AiBatch,AiCall,ProviderId,ProviderStatus} from '../shared/ai';
import {reportedReasoningTokens} from '../shared/ai';
import {unitConfig} from '../shared/units';
import {api} from './api';
import {Modal,Notice} from './components';
import {aiSelectionReason,hasFormalResult,type RemovedSelection} from '../shared/submission-state';

type Preview={previewToken:string;configVersion:number;maxOutputTokens:number;context?:string;items:{submissionId:string;pages:number;units:number;estimatedCny:number;cached:boolean}[];estimatedCny:number;warning:boolean;warnings:string[]};
export function AiControls({assignment,submissions,files,selectedIds,removedSelections,regradeTargetId,onCloseRegrade,onRetrySubmission,onRefresh}:{assignment:Assignment;submissions:Submission[];files:StoredFile[];selectedIds:string[];removedSelections:RemovedSelection[];regradeTargetId:string|null;onCloseRegrade:()=>void;onRetrySubmission:(id:string)=>void;onRefresh:()=>Promise<void>}){
  const [open,setOpen]=useState(false);const [providers,setProviders]=useState<ProviderStatus[]>([]);const [provider,setProvider]=useState<ProviderId>('deepseek');
  const [maxOutput,setMaxOutput]=useState<number|undefined>();const current=providers.find(p=>p.id===provider);const outputLimit=maxOutput??current?.defaultMaxOutputTokens??16384;
  const [consent,setConsent]=useState(false);const [deidentified,setDeidentified]=useState(false);const [unitsConfirmed,setUnitsConfirmed]=useState(false);
  const [per,setPer]=useState(.5);const [total,setTotal]=useState(2);const [regrade,setRegrade]=useState(false);const [warning,setWarning]=useState(false);
  const [preview,setPreview]=useState<Preview|null>(null);const [overview,setOverview]=useState<{batches:AiBatch[];calls:AiCall[]}>({batches:[],calls:[]});
  const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
  const ids=regradeTargetId?[regradeTargetId]:selectedIds;
  const selected=ids.map(id=>submissions.find(s=>s.id===id)).filter((s):s is Submission=>!!s);
  const invalid=ids.some(id=>!!aiSelectionReason(submissions.find(s=>s.id===id),regrade));
  const context=JSON.stringify({assignment:assignment.id,version:assignment.version,config:assignment.config,selected:ids.map(id=>{const s=submissions.find(s=>s.id===id);return [id,s?.revision,s?.status,s?.fileId];}),references:files.filter(f=>f.kind!=='student').map(f=>f.id),provider,per,total,outputLimit,regrade,consent,deidentified,unitsConfirmed});
  const liveContext=useRef(context);liveContext.current=context;
  const validPreview=preview?.context===context?preview:null;
  useEffect(()=>{setPreview(null);setWarning(false);},[context]);
  const targets=JSON.stringify([assignment.id,assignment.version,ids.map(id=>{const s=submissions.find(s=>s.id===id);return [id,s?.revision,s?.status];}),files.filter(f=>f.kind!=='student').map(f=>f.id)]);
  useEffect(()=>{setPreview(null);setWarning(false);setConsent(false);setDeidentified(false);setUnitsConfirmed(false);setError('');},[targets]);
  useEffect(()=>{if(regradeTargetId){setRegrade(true);setOpen(true);}},[regradeTargetId]);
  useEffect(()=>{setUnitsConfirmed(false);},[assignment.version]);
  useEffect(()=>{setPreview(null);setWarning(false);setConsent(false);setDeidentified(false);setUnitsConfirmed(false);},[outputLimit]);
  let units:string[]=[];let unitError='';try{units=unitConfig(assignment.config).questions.map(questionKey);}catch(e){unitError=e instanceof Error?e.message:'请核对规则';}
  const reload=async()=>{const data=await api<{batches:AiBatch[];calls:AiCall[]}>('/assignments/'+assignment.id+'/ai');setOverview(data);};
  useEffect(()=>{
    if(!open)return;let live=true;
    void api<ProviderStatus[]>('/ai/providers').then(p=>{if(live)setProviders(p);}).catch(e=>{if(live)setError(String(e));});
    const sync=()=>Promise.all([reload(),onRefresh()]).catch(e=>{if(live)setError(String(e));});
    void sync();const timer=window.setInterval(()=>void sync(),2000);
    return()=>{live=false;window.clearInterval(timer);};
  },[open,assignment.id,onRefresh]);
  const options=()=>({ids,expectedVersion:assignment.version,provider,consent,deidentified,unitsConfirmed,perSubmissionBudget:per,totalBudget:total,maxOutputTokens:outputLimit,regrade,warningAcknowledged:warning});
  async function act(action:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await action();}catch(e){setPreview(null);setError(e instanceof Error?e.message:'操作失败');await onRefresh().catch(()=>{});}finally{setBusy(false);}}
  async function testConnection(){
    if(!window.confirm('此测试会向所选服务发送一张合成图片，可能产生少量费用。继续？'))return;
    await act(async()=>{const result=await api<{message:string}>('/ai/providers/'+provider+'/test','POST',{consent:true});setMessage(result.message);setProviders(await api('/ai/providers'));});
  }
  async function control(id:string,action:'pause'|'resume'|'cancel'){
    if(action==='resume'&&!window.confirm('继续此已授权批次，仍受原预算限制。继续？'))return;
    await act(async()=>{await api('/ai/batches/'+id+'/control','POST',{action});await reload();await onRefresh();});
  }
  function close(){setOpen(false);setPreview(null);setWarning(false);setConsent(false);setDeidentified(false);setRegrade(false);setMaxOutput(undefined);onCloseRegrade();}
  return <><button disabled={assignment.archived} onClick={()=>{setPreview(null);setWarning(false);setRegrade(false);setOpen(true);}}>AI 批改已选{selectedIds.length?'（'+selectedIds.length+'）':''}</button>{open&&<Modal title={regradeTargetId?'重新 AI 批改':'AI 批改'} onClose={close}>
    <details className="quiet-details" open><summary>本次已选 {ids.length} 份作业</summary><div className="selected-submissions">{selected.map(s=><p key={s.id}><strong>{s.studentName}</strong> · {s.studentId||'未填学号'}<br/><span className="subtle">{files.find(f=>f.id===s.fileId)?.name??'文件已删除'}</span></p>)}</div></details>
    {!ids.length&&<Notice>请关闭弹窗，在学生列表勾选需要批改的作业。</Notice>}
    {!regradeTargetId&&removedSelections.length>0&&<Notice>已移除：{removedSelections.map(r=>r.name+'（'+r.reason+'）').join('；')}。请重新核对本次名单并勾选确认、预估费用。</Notice>}
    {invalid&&<Notice tone="danger">{ids.map(id=>{const s=submissions.find(s=>s.id===id);const reason=aiSelectionReason(s,regrade);return reason?(s?.studentName??'已删除的提交')+'：'+reason:'';}).filter(Boolean).join('；')}。<button onClick={close}>移除无效项并返回列表</button></Notice>}
    <div className="form-grid"><label>服务<select aria-label="AI 服务" value={provider} onChange={e=>{setProvider(e.target.value as ProviderId);setMaxOutput(undefined);setPreview(null);}}><option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option></select></label><div><p>{current?.model??'正在读取配置…'}</p><p className="subtle">{current?.configured?'已检测到配置':'未检测到 Key'} · {current?.connection??'未测试'}</p></div></div>
    <button disabled={busy||!current?.configured||!current.enabled} onClick={()=>void testConnection()}>测试连接</button>
    {current&&!current.enabled&&<p className="subtle">真实调用未启用。按 README 配置后端环境变量并重启；Mock 和人工评分可照常使用。</p>}
    <details className="quiet-details"><summary>核对扣分单元（{units.length}）</summary>{unitError?<p>{unitError}</p>:<p>{units.join('；')}</p>}<p>判断题按命题计分；解答题默认整题。独立小题请先在作业设置中明确调整。</p></details>
    <div className="form-grid"><label>每份预算上限（元）<input aria-label="每份预算" type="number" min=".01" max="20" step=".01" value={per} onChange={e=>{setPer(Number(e.target.value));setPreview(null);}}/></label><label>本批总预算（元）<input aria-label="批次预算" type="number" min=".01" max="200" step=".1" value={total} onChange={e=>{setTotal(Number(e.target.value));setPreview(null);}}/></label></div>
    <details className="quiet-details"><summary>批改选项 · 输出额度 {outputLimit}</summary><label>输出额度（token）<select aria-label="输出额度" value={outputLimit} onChange={e=>setMaxOutput(Number(e.target.value))}>{[...new Set([8192,16384,32768,current?.defaultMaxOutputTokens??16384])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n}{n===16384?'（建议）':''}</option>)}</select></label><p className="subtle">包含模型思考与评分。较大额度会提高费用预估；不会自动扩大额度或重试。</p></details>
    {selected.some(s=>s.error)&&<Notice tone="danger">此前批改未完成：{selected.filter(s=>s.error).map(s=>s.studentName+'：'+s.error).join('；')}</Notice>}
    <label className="checkbox"><input type="checkbox" checked={unitsConfirmed} onChange={e=>setUnitsConfirmed(e.target.checked)}/>已核对本次扣分单元与规则</label>
    <label className="checkbox"><input type="checkbox" checked={deidentified} onChange={e=>setDeidentified(e.target.checked)}/>学生与参考 PDF 页面已去除姓名、学号等身份信息</label>
    <label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意将本次页面图像、参考材料及规则发送给所选服务，可能产生费用</label>
    {regradeTargetId&&<Notice>本次为明确重新批改，可能产生新增费用；原记录保留在修订历史中。请重新核对目标、授权与预算。</Notice>}
    <details className="quiet-details" open={regradeTargetId?true:undefined}><summary>重新批改</summary><label className="checkbox"><input type="checkbox" checked={regrade} disabled={!!regradeTargetId} onChange={e=>{setRegrade(e.target.checked);setPreview(null);}}/>明确忽略已有结果缓存并重批（新增费用）</label></details>
    <p className="subtle">本次 {ids.length} 份。目标每份低于 ¥0.10；预算是本机请求门禁，不能保证服务商最终账单绝对不超。</p>
    {validPreview&&<Notice>已预估 {validPreview.items.length} 份 · 规则版本 {validPreview.configVersion} · 输出额度 {validPreview.maxOutputTokens}。保守估算合计 ¥{validPreview.estimatedCny.toFixed(4)}，其中 {validPreview.items.filter(i=>i.cached).length} 份可复用。估算含最大输出且不假设缓存命中。</Notice>}
    {validPreview?.warnings.map(w=><Notice key={w}>{w}</Notice>)}
    {validPreview?.warning&&<label className="checkbox"><input type="checkbox" checked={warning} onChange={e=>setWarning(e.target.checked)}/>估算达到 ¥0.30，我已查看预算并确认继续</label>}
    {error&&<Notice tone="danger">{error}</Notice>}{message&&<Notice>{message}</Notice>}
    <div className="modal-actions"><button onClick={close}>关闭</button><button disabled={busy||invalid||!ids.length||!consent||!deidentified||!unitsConfirmed||!!unitError||!current?.configured||!current.enabled} onClick={()=>void act(async()=>{const requested=context;const result=await api<Preview>('/assignments/'+assignment.id+'/ai/preview','POST',options());if(liveContext.current===requested){setPreview({...result,context:requested});setWarning(false);}})}>预估费用</button><button className="primary" disabled={busy||invalid||!validPreview||!consent||!deidentified||!unitsConfirmed||validPreview.warning&&!warning} onClick={()=>void act(async()=>{if(!validPreview)return;await api('/assignments/'+assignment.id+'/ai/queue','POST',{...options(),ids:validPreview.items.map(i=>i.submissionId),expectedVersion:validPreview.configVersion,previewToken:validPreview.previewToken});setPreview(null);setMessage('已加入所选服务批次');await reload();await onRefresh();})}>开始真实批改</button></div>
    <details className="quiet-details"><summary>批次与费用</summary>{overview.batches.slice().reverse().map(b=><div className="history-item" key={b.id}><p>{b.provider==='deepseek'?'DeepSeek':'Qwen'} · {b.status} · 完成 {b.items.filter(i=>i.state==='completed').length}/{b.items.length}</p>{b.items.filter(i=>i.error).map(i=><p className="danger-text" key={i.submissionId}>{submissions.find(s=>s.id===i.submissionId)?.studentName??'该提交'}：{i.error}{i.failure?'（'+i.failure.stage+' / '+i.failure.code+'）':''}{(()=>{const s=submissions.find(s=>s.id===i.submissionId);return s&&!hasFormalResult(s)&&!aiSelectionReason(s,true)?<button disabled={busy} onClick={()=>{setPreview(null);setConsent(false);setDeidentified(false);setUnitsConfirmed(false);setWarning(false);setRegrade(true);onRetrySubmission(s.id);}}>仅重试此份…</button>:null;})()}</p>)}{['running','paused'].includes(b.status)&&<div className="toolbar"><button disabled={busy} onClick={()=>void control(b.id,b.status==='running'?'pause':'resume')}>{b.status==='running'?'暂停后续调用':'继续批次'}</button><button disabled={busy} onClick={()=>void control(b.id,'cancel')}>取消批次</button></div>}</div>)}{overview.calls.map(c=><p className="subtle" key={c.id}>{submissions.find(s=>s.id===c.submissionId)?.studentName??'已删除提交'} · {reportedReasoningTokens(c.usage)!==undefined?'思考 token '+reportedReasoningTokens(c.usage)+' · ':''}{c.status==='failed'?'失败 · '+c.error+' · ':''}{c.diagnostic?'阶段 '+c.diagnostic.stage+' · HTTP '+(c.diagnostic.httpStatus??'未取得')+' · 结束 '+(c.diagnostic.finishReason??'未取得')+' · 输出上限 '+(c.diagnostic.maxOutputTokens??'未知')+' · 尝试 '+c.attempt+' · ':'历史记录未保存详细诊断 · '}{c.diagnostic?.responseCharacters!==undefined?'评分文本 '+c.diagnostic.responseCharacters+' 字符 · 思考 '+(c.diagnostic.reasoningCharacters??'未记录')+' 字符 · 图像 '+(c.diagnostic.inputImages??'未记录')+' · ':''}{c.model} · {c.pages} 页 · 输入 {c.inputTokens??'未知'} / 输出 {c.outputTokens??'未知'} · 缓存 {c.cacheHitTokens??'未知'} · {c.estimatedCny===null?'费用未知，预留 ¥'+c.reservedCny.toFixed(4):'估算 ¥'+c.estimatedCny.toFixed(4)}</p>)}</details>
  </Modal>}</>;
}
