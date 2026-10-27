import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Pencil, Check, Play, ExternalLink, Plus, Download } from 'lucide-react';
import { type Assignment, type Submission, type StoredFile, type Judgment, type History, summarize, reportFor, questionKey, validateRows, deductionRows } from '../shared/domain';
import { suggestedDeduction } from '../shared/course';
import { api, contentUrl } from './api';
import { Modal, Notice, ActionMenu, useBeforeUnload, formatDate, statusNames } from './components';
import { UploadBox } from './FilesPanel';
import {AiControls} from './AiControls';
import {aiSelectionReason,isUngraded,reconcileSelection,type RemovedSelection} from '../shared/submission-state';

type Props={assignment:Assignment;submissions:Submission[];files:StoredFile[];onRefresh:()=>Promise<void>;onDirty:(v:boolean)=>void;onSetup:()=>void;mockEnabled:boolean};
export function ReviewWorkspace({assignment,submissions,files,onRefresh,onDirty,onSetup,mockEnabled}:Props) {
  const [search,setSearch]=useState('');const [filter,setFilter]=useState('all');const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [removed,setRemoved]=useState<RemovedSelection[]>([]);const [regradeId,setRegradeId]=useState<string|null>(null);
  const selectionNames=useRef(new Map<string,string>());
  for(const s of submissions)if(selected.has(s.id))selectionNames.current.set(s.id,s.studentName||files.find(f=>f.id===s.fileId)?.name||'未命名提交');
  const selection=reconcileSelection(selected,submissions);selection.removed=selection.removed.map(r=>({...r,name:selectionNames.current.get(r.id)??r.name}));const validSelected=new Set(selection.valid);
  const selectionKey=JSON.stringify(selection);
  useEffect(()=>{if(selection.removed.length){setSelected(current=>new Set(reconcileSelection(current,submissions).valid));setRemoved(selection.removed);}},[selectionKey]);
  const canSelect=(s:Submission)=>!aiSelectionReason(s);
  const removedInfo=removed.map(r=>({...r,reason:aiSelectionReason(submissions.find(s=>s.id===r.id))||'已恢复可批改，可重新选择'}));
  function select(id:string,checked:boolean){setSelected(old=>{const next=new Set(old);checked?next.add(id):next.delete(id);return next;});}
  const [error,setError]=useState('');const [busy,setBusy]=useState('');const [batch,setBatch]=useState<Submission[]|null>(null);
  const [editing,setEditing]=useState<{s:Submission;key?:string}|null>(null);const [identity,setIdentity]=useState<Submission|null>(null);
  const [report,setReport]=useState<Submission|null>(null);const [history,setHistory]=useState<History[]|null>(null);
  const fileFor=(s:Submission)=>files.find(f=>f.id===s.fileId);
  const visible=submissions.filter(s=>(filter==='all'||filter==='ungraded'&&isUngraded(s)||s.status===filter||filter==='missing'&&!!s.grade&&(s.review??s.grade.rows).some(r=>r.deduction===.2)||filter==='needs'&&!!s.grade&&(s.review??s.grade.rows).some(r=>r.needsReview||r.recognition==='uncertain'))&&`${s.studentName} ${s.studentId} ${fileFor(s)?.name}`.toLowerCase().includes(search.toLowerCase()));
  const ready=assignment.config.confirmed&&assignment.config.questions.length>0;
  function toggle(id:string){setExpanded(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  async function run(list:Submission[]) {
    if(!list.length)return;setBusy('batch');setError('');
    try{await api(`/assignments/${assignment.id}/queue`,'POST',{ids:list.map(s=>s.id),acknowledged:true,replaceDraft:true});setBatch(null);await onRefresh();}
    catch(e){setError(e instanceof Error?e.message:'批改失败');}finally{setBusy('');}
  }
  async function edit(s:Submission,key?:string) {
    setBusy(s.id);setError('');
    try{let current=s;if(s.status==='confirmed'){if(!window.confirm('重新打开审核后，成绩将变为待确认。继续？'))return;current=await api(`/submissions/${s.id}/reopen`,'POST',{});}if(!current.grade)current=await api(`/submissions/${s.id}/manual`,'POST',{});await onRefresh();setEditing({s:current,key});}
    catch(e){setError(e instanceof Error?e.message:'无法编辑评分');}finally{setBusy('');}
  }
  async function confirm(s:Submission) {
    if(!s.grade)return;const grade=s.grade;
    const rows=(s.review??s.grade.rows).map(r=>({...r,reviewed:true,needsReview:grade.config.policy==='linear-algebra-2'?r.needsReview:false}));
    const errors=validateRows(s.grade.config,rows,fileFor(s)?.pages??1,true);
    if(errors.length){setError('仍有题目需要核对，请展开扣分点或选择「修改评分」。');setExpanded(old=>new Set([...old,s.id]));return;}
    const score=summarize(s.grade.config,rows).score;
    if(!window.confirm(`确认 ${s.studentName} 的成绩为 ${score} 分？${s.grade.provider==='mock'?'\n当前是模拟评分，请确认你已核对结果。':''}`))return;
    setBusy(s.id);setError('');
    try{await api(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows,manualReport:s.manualReport,reportBase:s.reportBase,confirm:true});await onRefresh();}
    catch(e){setError(e instanceof Error?e.message:'确认失败');}finally{setBusy('');}
  }
  async function remove(s:Submission){if(!window.confirm(`删除 ${s.studentName} 的作业和评分记录？`))return;try{await api(`/files/${s.fileId}`,'DELETE');await onRefresh();}catch(e){setError(e instanceof Error?e.message:'删除失败');}}
  return <div className="review-workspace">
    <div className="workspace-toolbar"><div className="search-field"><Search size={16}/><input aria-label="搜索学生" placeholder="搜索姓名或学号" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="toolbar"><select className="inline-select" aria-label="筛选状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部作业</option><option value="ungraded">未批改</option><option value="review">待确认</option><option value="confirmed">已确认</option><option value="failed">失败</option><option value="missing">漏做 −0.2</option><option value="needs">待核对项目</option></select>{mockEnabled&&<button disabled={!ready||assignment.archived||!submissions.some(s=>!['confirmed','queued','processing'].includes(s.status))} onClick={()=>setBatch(submissions.filter(s=>!['confirmed','queued','processing'].includes(s.status)))}><Play size={15}/>模拟批改</button>}<AiControls assignment={assignment} submissions={submissions} files={files} selectedIds={selection.valid} removedSelections={removedInfo} regradeTargetId={regradeId} onCloseRegrade={()=>setRegradeId(null)} onRetrySubmission={setRegradeId} onRefresh={onRefresh} onSetup={onSetup}/><UploadBox assignmentId={assignment.id} kind="student" onDone={onRefresh} disabled={assignment.archived}/><ActionMenu label="作业列表操作"><a href={`/api/assignments/${assignment.id}/export`}><Download size={15}/>导出成绩</a></ActionMenu></div></div>
    {error&&<Notice tone="danger">{error}</Notice>}
    {removedInfo.length>0&&<p className="selection-update" role="status">已移除：{removedInfo.map(r=>r.name+'（'+r.reason+'）').join('；')}。其他选择保留，请重新核对并预估。 <button className="text-button" onClick={()=>setRemoved([])}>知道了</button></p>}
    {submissions.length>0&&<div className="selection-toolbar"><span>已选 {validSelected.size} 份</span><button className="text-button" onClick={()=>setSelected(old=>new Set([...old,...visible.filter(canSelect).map(s=>s.id)]))}>选择当前可批改项</button><button className="text-button" disabled={!validSelected.size} onClick={()=>setSelected(new Set())}>清空选择</button><small>选择会随批改进度更新；搜索或筛选不会清空选择。</small></div>}
    {!ready&&<div className="setup-reminder">人工评分和 AI 批改前，请先到作业设置核对并保存题目。<button className="text-button" onClick={onSetup}>前往作业设置</button></div>}
    <div className="submission-list"><div className="list-heading"><span>姓名 <small>{submissions.length}</small></span><span>总分</span><span>扣分点</span><span/></div>
      {visible.map(s=>{
        const rows=s.grade?(s.review??s.grade.rows):[];
        const affected=s.grade?deductionRows(s.grade.config,rows).filter(r=>(r.deduction??0)>0||r.deduction===null||r.recognition==='uncertain'):[];
        const sum=s.grade?summarize(s.grade.config,rows):null;
        const locked=['queued','processing'].includes(s.status)||busy===s.id;
        return <article className={`submission ${s.status==='confirmed'?'confirmed':''}`} key={s.id} data-testid="submission-row">
          <div className="submission-row">
            <div className="submission-name" title={`${s.studentId}\n${fileFor(s)?.name??''}`}><input className="submission-select" type="checkbox" aria-label={'选择作业 '+s.studentName+' '+(fileFor(s)?.name??s.id)} checked={validSelected.has(s.id)} title={aiSelectionReason(s)||'选择用于 AI 批改'} disabled={!canSelect(s)||assignment.archived} onChange={e=>select(s.id,e.target.checked)}/><div className="student-identity"><strong>{s.studentName||'未命名学生'}</strong><button className="student-id text-button" disabled={locked} onClick={()=>setIdentity(s)} aria-label={'修改学号 '+s.studentName}>{s.studentId?'学号：'+s.studentId:'补填学号'}</button></div>{s.grade?.provider==='mock'&&<span className="row-state mock-result">模拟结果</span>}{s.grade&&['deepseek','qwen'].includes(s.grade.provider)&&<span className="row-state">{s.grade.provider==='deepseek'?'DeepSeek':'Qwen'}</span>}{s.status==='confirmed'&&<Check size={14} className="confirmed-mark"/>}{['queued','processing','failed'].includes(s.status)&&<span className={`row-state ${s.status}`}>{statusNames[s.status]}</span>}</div>
            <div className="submission-score"><strong>{sum?sum.score??'待核对':'—'}</strong>{sum&&s.status!=='confirmed'&&<span>待确认</span>}</div>
            <div>{affected.length?<button className={`deduction-toggle ${expanded.has(s.id)?'open':''}`} aria-expanded={expanded.has(s.id)} onClick={()=>toggle(s.id)}>扣分点 {affected.length}<ChevronDown size={15}/></button>:<span className="subtle">{s.grade?'无扣分':'未批改'}</span>}</div>
            <div className="row-actions">{s.status==='review'&&<button className="confirm-button" disabled={locked} onClick={()=>void confirm(s)}>确认成绩</button>}{mockEnabled&&s.status==='uploaded'&&<button className="text-button" disabled={!ready||locked} onClick={()=>setBatch([s])}>模拟批改</button>}{s.status==='failed'&&<button className="text-button" disabled={locked} onClick={()=>setRegradeId(s.id)}>AI 重试</button>}<ActionMenu label={`更多操作 ${s.studentName}`}><a href={contentUrl(s.fileId)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>查看原稿</a><button disabled={locked||!ready} onClick={()=>void edit(s)}><Pencil size={15}/>{s.grade?'修改评分':'人工评分'}</button>{(s.grade||s.status==='failed')&&s.status!=='confirmed'&&<button disabled={locked||assignment.archived} onClick={()=>setRegradeId(s.id)}>重新 AI 批改…</button>}{mockEnabled&&s.status==='failed'&&!s.grade&&<button disabled={locked||assignment.archived} onClick={()=>setBatch([s])}>模拟重试</button>}<button disabled={locked} onClick={()=>setIdentity(s)}>修改姓名与学号</button>{s.grade&&<><button onClick={()=>setReport(s)}>报告</button><button onClick={()=>void api<History[]>(`/submissions/${s.id}/history`).then(setHistory).catch(e=>setError(String(e)))}>修订记录</button>{mockEnabled&&s.status!=='confirmed'&&<button disabled={locked||assignment.archived} onClick={()=>setBatch([s])}>重新模拟批改</button>}</>}<button className="danger-text" disabled={locked} onClick={()=>void remove(s)}>删除作业</button></ActionMenu></div>
          </div>
          {expanded.has(s.id)&&<div className="deduction-details">{s.error&&<p className="danger-text">{s.error}</p>}{affected.map(r=><div className="deduction-item" key={r.key}><strong>{r.key}</strong><span className="deduction-amount">{r.deduction===null?'待核对':`−${r.deduction}`}</span><p>{r.reason||'请补充扣分原因。'}</p>{r.reviewReason&&<p className="subtle">待核对：{r.reviewReason}</p>}<div className="deduction-tools">{r.pages.map(p=><a key={p} className="text-button" href={`${contentUrl(s.fileId)}#page=${p}`} target="_blank" rel="noreferrer">第 {p} 页<ExternalLink size={12}/></a>)}<button className="text-button" disabled={locked} onClick={()=>void edit(s,r.key)}>修改</button></div></div>)}<button className="text-button" disabled={locked} onClick={()=>void edit(s)}><Plus size={14}/>补充或调整扣分</button></div>}
        </article>;
      })}
      {!visible.length&&<div className="list-empty">{submissions.length?'没有匹配的学生作业。':'尚未上传学生作业。'}</div>}
    </div>
    {batch&&<Modal title={`模拟批改 ${batch.length} 份作业`} onClose={()=>setBatch(null)}><p>将生成用于演示的评分结果。{batch.some(s=>s.grade)?'当前未确认结果会保留在修订记录中。':''}</p><div className="modal-actions"><button onClick={()=>setBatch(null)}>取消</button><button className="primary" disabled={!batch.length||busy==='batch'} onClick={()=>void run(batch)}>开始模拟</button></div></Modal>}
    {editing&&<ScoreEditor s={editing.s} file={fileFor(editing.s)!} initialKey={editing.key} onDirty={onDirty} onClose={()=>{setEditing(null);onDirty(false);}} onSaved={async()=>{setEditing(null);onDirty(false);await onRefresh();}}/>}
    {identity&&<IdentityModal s={identity} onClose={()=>setIdentity(null)} onSaved={async()=>{setIdentity(null);await onRefresh();}}/>}
    {report&&<ReportModal s={report} file={fileFor(report)!} onClose={()=>setReport(null)} onSaved={async()=>{setReport(null);await onRefresh();}}/>}
    {history&&<Modal title="修订记录" onClose={()=>setHistory(null)}>{history.length?history.map(h=><details className="history-item" key={h.id}><summary>{formatDate(h.at)} · {h.action}</summary><pre>{reportFor(h.snapshot)}</pre>{h.snapshot.manualReport&&<pre>{h.snapshot.manualReport}</pre>}</details>):<p>暂无修订记录。</p>}</Modal>}
  </div>;
}

function ScoreEditor({s,file,initialKey,onSaved,onClose,onDirty}:{s:Submission;file:StoredFile;initialKey?:string;onSaved:()=>Promise<void>;onClose:()=>void;onDirty:(v:boolean)=>void}) {
  const grade=s.grade!;const config=grade.config;
  const [rows,setRows]=useState(structuredClone(s.review??grade.rows));
  const [key,setKey]=useState(initialKey&&config.questions.some(q=>questionKey(q)===initialKey)?initialKey:rows.find(r=>r.deduction===null)?.key??rows[0]?.key??'');
  const [dirty,setDirty]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useBeforeUnload(dirty);
  const index=rows.findIndex(r=>r.key===key);const row=rows[index];const q=config.questions.find(q=>questionKey(q)===key)!;
  function change(next:Judgment[]){setRows(next);setDirty(true);onDirty(true);}
  function patch(p:Partial<Judgment>){change(rows.map((r,i)=>i===index?{...r,...p,reviewed:p.recognition==='uncertain'?false:true,needsReview:p.recognition==='uncertain'}:r));}
  function state(value:string){
    const recognition:Judgment['recognition']=value==='correct'||value==='error'?'found':value as Judgment['recognition'];
    const verdict:Judgment['verdict']=value==='correct'?(q.type==='completion_only'?'completed':'correct'):value==='error'?'partial':value==='uncertain'?'uncertain':'missing';
    patch({recognition,verdict,reviewReason:value==='uncertain'?'需人工核对。':'',errorCount:value==='error'?1:undefined,deduction:suggestedDeduction(config,q,recognition,verdict),reason:value==='correct'?'':value==='missing'?'未做。':value==='not_found'?'未检索到作答，暂按漏做处理。':value==='uncertain'?'需人工核对。':row.reason});
  }
  function close(){if(!dirty||window.confirm('放弃尚未保存的评分修改？'))onClose();}
  async function save(){const errors=validateRows(config,rows,file.pages??1);if(errors.length){setError(errors.join('；'));return;}setBusy(true);try{await api(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows,manualReport:s.manualReport,reportBase:s.reportBase,confirm:false});setDirty(false);await onSaved();}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
  const selected=row.recognition==='found'?(row.verdict==='correct'||row.verdict==='completed'?'correct':'error'):row.recognition;
  const countLimit=q.part?1:Math.max(1,q.subparts?.length??0);
  return <Modal title={`修改评分 · ${s.studentName}`} onClose={close}>
    <div className="form-grid"><label className="wide">题目<select aria-label="选择题目" value={key} onChange={e=>setKey(e.target.value)}>{rows.map(r=><option value={r.key} key={r.key}>{r.key}{r.deduction?`（扣 ${r.deduction}）`:r.deduction===null?'（待核对）':''}</option>)}</select></label>
      <label>判定<select aria-label="评分判定" value={selected} onChange={e=>state(e.target.value)}><option value="correct">{q.type==='completion_only'?'已完成':'正确 / 等价解'}</option>{q.type==='graded'&&<option value="error">有错误</option>}<option value="missing">未做</option><option value="not_found">未检索到，暂按漏做</option><option value="uncertain">需核对</option></select></label>
      {config.policy==='linear-algebra-1.1'&&selected==='error'?<label>错误处数<input aria-label="错误处数" type="number" min={1} max={countLimit} value={row.errorCount??1} onChange={e=>{const count=Math.max(1,Math.min(countLimit,Number(e.target.value)||1));patch({errorCount:count,deduction:suggestedDeduction(config,q,row.recognition,row.verdict,count)});}}/></label>:<label>扣分<input aria-label="扣分" type="number" min={0} max={config.total} step="0.1" disabled={!!config.policy||selected!=='error'} value={row.deduction??''} onChange={e=>patch({deduction:e.target.value===''?null:Number(e.target.value)})}/></label>}
      <label className="wide">扣分原因<textarea aria-label="扣分原因" rows={3} value={row.reason} onChange={e=>patch({reason:e.target.value})}/></label>
      <label>证据页码（可选）<PagesInput key={key} value={row.pages} max={file.pages??1} onChange={pages=>patch({pages})}/></label><div className="current-deduction">本题扣分 <strong>{row.deduction??'待核对'}</strong></div>
    </div>
    <div className="editor-secondary">{config.policy==='linear-algebra-2'&&<button onClick={()=>patch({reviewed:true,needsReview:false,reviewReason:''})}>已核对当前项</button>}<a className="text-button" href={`${contentUrl(s.fileId)}#page=${row.pages[0]??1}`} target="_blank" rel="noreferrer">查看原稿<ExternalLink size={13}/></a><button className="text-button" onClick={()=>change(rows.map(r=>r.recognition==='uncertain'?{...r,recognition:'found',verdict:r.type==='completion_only'?'completed':'correct',deduction:0,reason:'',reviewed:true,needsReview:false}:r))}>其余待核对题目均无扣分</button></div>
    {error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button onClick={close}>取消</button><button className="primary" disabled={busy} onClick={()=>void save()}>保存评分</button></div>
  </Modal>;
}

function PagesInput({value,max,onChange}:{value:number[];max:number;onChange:(v:number[])=>void}) {
  const [text,setText]=useState(value.join(', '));
  return <input aria-label="证据页码" value={text} placeholder="例如 2,3" onChange={e=>setText(e.target.value)} onBlur={()=>{const pages=text.split(/[,，、\s]+/).filter(Boolean).map(Number);if(pages.some(p=>!Number.isInteger(p)||p<1||p>max)){window.alert(`请填写 1～${max} 的页码`);setText(value.join(', '));return;}const result=[...new Set(pages)];if(result.join(',')!==value.join(','))onChange(result);}}/>;
}
function IdentityModal({s,onClose,onSaved}:{s:Submission;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(s.studentName);const [id,setId]=useState(s.studentId);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const dirty=name!==s.studentName||id!==s.studentId;useBeforeUnload(dirty);
  function close(){if(!dirty||window.confirm('放弃尚未保存的姓名或学号修改？'))onClose();}
  return <Modal title="修改姓名与学号" onClose={close}><form noValidate onSubmit={e=>{e.preventDefault();if(!name.trim()){setError('请填写姓名。');return;}if(id.trim()!==s.studentId&&id.trim()!==''&&!/^\d{10}$/.test(id.trim())){setError('学号须为恰好 10 位数字，也可以留空；前导零会保留。');return;}setBusy(true);setError('');void api(`/submissions/${s.id}/identity`,'PATCH',{studentName:name,studentId:id,revision:s.revision}).then(onSaved).catch(e=>setError(e instanceof Error?e.message:'学生信息保存失败，请重试。')).finally(()=>setBusy(false));}}><label>姓名<input required value={name} maxLength={200} onChange={e=>setName(e.target.value)}/></label><label>学号<input aria-describedby="identity-id-help" type="text" inputMode="numeric" maxLength={10} value={id} onChange={e=>setId(e.target.value)}/></label><p id="identity-id-help" className="subtle">填写 10 位数字或留空，开头的 0 会保留。修改仅用于本机管理，不会额外发送给 AI。{s.studentId&&!/^\d{10}$/.test(s.studentId)?'原有非十位学号暂时保留；如要修改，请填写十位数字或清空。':''}</p>{error&&<div role="alert"><Notice tone="danger">{error}</Notice></div>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy}>{busy?'保存中…':'保存'}</button></div></form></Modal>;
}
function ReportModal({s,onClose,onSaved}:{s:Submission;file:StoredFile;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const auto=reportFor(s);const [text,setText]=useState(s.manualReport);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [dirty,setDirty]=useState(false);useBeforeUnload(dirty);
  function close(){if(!dirty||window.confirm('放弃未保存的报告修改？'))onClose();}
  async function save(){setBusy(true);try{await api(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows:s.review??s.grade!.rows,manualReport:text,reportBase:auto,confirm:false});await onSaved();}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
  return <Modal title={`报告 · ${s.studentName}`} onClose={close}><pre className="report-text">{auto}</pre><label>补充报告<textarea aria-label="补充报告" rows={5} value={text} disabled={s.status==='confirmed'} onChange={e=>{setText(e.target.value);setDirty(true);}}/></label>{s.status==='confirmed'&&<p className="subtle">修改评分、重开审核后可编辑报告。</p>}{s.manualReport&&s.reportBase!==auto&&<Notice>评分已变化，请核对补充报告。</Notice>}{error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button onClick={close}>关闭</button>{s.status!=='confirmed'&&<button className="primary" disabled={busy} onClick={()=>void save()}>保存报告</button>}</div></Modal>;
}
