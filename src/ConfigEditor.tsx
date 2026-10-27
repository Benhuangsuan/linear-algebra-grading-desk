import {Fragment,useEffect,useState} from 'react';
import {ZodError} from 'zod';
import {ChevronDown,Plus,Pencil,Trash2,Save} from 'lucide-react';
import {blankQuestion,configSchema,questionKey,type Assignment,type Config,type Question,type StoredFile} from '../shared/domain';
import {courseQuestion} from '../shared/course';
import {childrenOf,withChildren,reconcileQuestions,splitUnits} from '../shared/questions';
import {api} from './api';
import {FilesPanel} from './FilesPanel';
import {Modal,Notice,useBeforeUnload} from './components';
import {ReferenceAssistant,ReferenceSources} from './ReferenceTools';
import {ReferenceReview,type ImportResult} from './ReferenceReview';

export function ConfigEditor({assignment,files,onSaved,onDirty}:{assignment:Assignment;files:StoredFile[];onSaved:()=>Promise<void>;onDirty:(v:boolean)=>void}){
  const [draft,setDraft]=useState(structuredClone(assignment)),[dirty,setDirty]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [warnings,setWarnings]=useState<string[]>([]),[editing,setEditing]=useState<{index:number;q:Question}|null>(null);
  const [review,setReview]=useState<ImportResult|null>(null),[replaceContent,setReplaceContent]=useState<Set<string>>(new Set());
  const [method,setMethod]=useState<'auto'|'text'|'ai'>('auto'),[helperBusy,setHelperBusy]=useState(false),[modalDirty,setModalDirty]=useState(false);
  const [expanded,setExpanded]=useState<Set<string>>(new Set()),[prepared,setPrepared]=useState({scope:assignment.scope,text:assignment.config.sourceText??''});
  useBeforeUnload(dirty||modalDirty||helperBusy||!!review);
  useEffect(()=>onDirty(dirty||modalDirty||helperBusy||!!review),[dirty,modalDirty,helperBusy,review,onDirty]);
  function change(next:Assignment){setDraft(next);setDirty(true);onDirty(true);setMessage('');}
  function closeEditing(){setEditing(null);setModalDirty(false);}
  async function generate(uploaded?:StoredFile[]){
    setBusy(true);setError('');
    try{const result=await api<ImportResult>(`/assignments/${assignment.id}/prepare`,'POST',{scope:draft.scope,sourceText:draft.config.sourceText??'',strategy:method==='ai'?'auto':method});setWarnings(result.warnings);setReplaceContent(new Set());
      if(!result.config.questions.length){setMessage('没有识别出题目，请补充题目文字或手动添加。');return;}
      setReview({...result,uploadedIds:uploaded?.map(f=>f.id)});
    }catch(e){setError(e instanceof Error?e.message:'整理失败，请重试。');}finally{setBusy(false);}
  }
  function keep(){setReview(null);setPrepared({scope:draft.scope,text:draft.config.sourceText??''});setMessage('保持现有题目不变，已上传的 PDF 仍然保留。');}
  async function save(){
    if(!draft.title.trim()){setError('请填写作业名称。');return;}setBusy(true);setError('');
    try{if(prepared.scope!==draft.scope||prepared.text!==(draft.config.sourceText??'')){await generate();return;}
      const config={...draft.config,confirmed:draft.config.questions.length>0};configSchema.parse(config);
      await api(`/assignments/${assignment.id}`,'PUT',{title:draft.title,description:draft.description,scope:draft.scope,config,version:assignment.version,regradeUnconfirmed:false});setDirty(false);onDirty(false);await onSaved();setMessage('已保存到本机。');
    }catch(e){setError(e instanceof ZodError?[...new Set(e.issues.map(i=>/[\u4e00-\u9fff]/.test(i.message)?i.message:'请检查题目与分值配置。'))].join('；'):e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
  }
  return <div className="setup-page">
    {error&&<Notice tone="danger">{error}</Notice>}
    <div className="settings-section"><div className="section-heading"><h2>作业信息</h2><button className="primary" aria-describedby="settings-save-help" disabled={busy||helperBusy} onClick={()=>void save()}><Save size={15}/>{busy?'处理中…':'保存设置'}{dirty?' *':''}</button></div>
      <p id="settings-save-help" className={'settings-save-state'+(dirty?' unsaved':'')} role="status">{busy||helperBusy?'正在整理或保存，请等待完成后再保存设置。':dirty?'存在尚未保存的更改，请点击“保存设置”。':'当前题目和规则已保存到本机。'}</p>
      <div className="form-grid"><label>作业名称<input disabled={busy||helperBusy} value={draft.title} maxLength={200} onChange={e=>change({...draft,title:e.target.value})}/></label><label>作业范围<input disabled={busy||helperBusy} placeholder="例如 1.1-1.3 或 2.2-2.4,2.8" value={draft.scope} onChange={e=>change({...draft,scope:e.target.value,config:{...draft.config,confirmed:false}})}/></label></div>
      <details className="quiet-details"><summary>补充说明</summary><textarea aria-label="作业说明" rows={3} value={draft.description} onChange={e=>change({...draft,description:e.target.value})}/></details>
    </div>
    <FilesPanel assignmentId={assignment.id} files={files} onRefresh={onSaved} onUploaded={async uploaded=>{await onSaved();if(method==='ai'){setMessage('文件已上传。请选择要交给 AI 整理的页面，再预估费用并决定是否开始。');return;}await generate(uploaded);}} disabled={assignment.archived||busy||helperBusy}/>
    <section className="settings-section"><div className="section-heading"><h2>评分规则</h2></div><div className="rule-summary"><div><strong>10</strong><span>满分</span></div><div><strong>−0.2</strong><span>每题漏做</span></div><div><strong>−0.1</strong><span>每处错误</span></div></div><p className="rule-description">按题目配置检查完成或批改正确性；未检索到作答暂按漏做处理。</p><details className="quiet-details"><summary>判分原则</summary><p>判断题逐命题计分；解答题默认整题，接受正确的不同方法。仅明确独立的小题分别计分；同一单元不重复扣分，已有成绩保留原规则。</p></details></section>
    <section className="settings-section"><div className="section-heading"><h2>题目清单 <span className="count">{draft.config.questions.length}</span></h2></div>
      {message&&<p className="save-message">{message}</p>}
      <details className="reference-step reference-workflow" open><summary>整理参考答案</summary><label>要怎样从参考答案整理出题目？<select disabled={busy||helperBusy} value={method} onChange={e=>setMethod(e.target.value as typeof method)}><option value="auto">自动整理（推荐，免费）</option><option value="text">只按文字整理（免费）</option><option value="ai">AI 辅助整理（可能收费）</option></select></label>
        {method!=='ai'&&<><p className="subtle">{method==='auto'?'先检查黑色题干、红色答案的格式；能使用颜色时按颜色分开，否则只按文字整理。':'只整理可提取的题号和文字，不根据颜色区分题干与答案。'}仅在本机处理，不发送给 AI；整理后请检查。</p><button disabled={busy||helperBusy} onClick={()=>void generate()}>整理题目清单</button></>}
        <div hidden={method!=='ai'}><ReferenceAssistant active={method==='ai'} assignment={assignment} files={files} scope={draft.scope} onBusyChange={setHelperBusy} onCandidate={(config,w)=>{setWarnings(w);setReplaceContent(new Set());setReview({config,warnings:w});}}/></div>
      </details>
      <details className="reference-step"><summary>检查需要确认的题目{warnings.length>0?`（${warnings.length} 条提醒）`:''}</summary>{warnings.length?warnings.map((w,i)=><p key={i}>{w}</p>):<p className="subtle">暂无整理提醒。整理完成后仍需核对题号、题干、参考答案与图片。</p>}</details>
      <details className="question-disclosure reference-step"><summary>题目清单与扣分规则</summary>
        {draft.config.questions.length>0&&<div className="question-table-scroll"><table className="question-table"><thead><tr><th>题目</th><th>检查方式</th><th>漏做扣分</th><th>错误扣分</th><th/></tr></thead><tbody>{draft.config.questions.map((q,i)=>{const key=questionKey(q);const children=childrenOf(q);return <Fragment key={key}><tr><td>{key}{children.length>0&&<button className="text-button child-disclosure" aria-label={`展开小问 ${key}`} aria-expanded={expanded.has(key)} onClick={()=>setExpanded(old=>{const next=new Set(old);next.has(key)?next.delete(key):next.add(key);return next;})}>{children.length} 小问 · {splitUnits(q)?children.length:1} 单元 <ChevronDown size={13}/></button>}</td><td>{q.type==='completion_only'?'仅检查完成':'批改正确性'}</td><td>{q.missingPenalty??'未设'}</td><td>{q.type==='completion_only'?'—':q.errorPenalty??'未设'}</td><td><div className="toolbar"><button className="icon-button" title={`调整 ${key}`} onClick={()=>setEditing({index:i,q:structuredClone(q)})}><Pencil size={14}/></button><button className="icon-button danger-text" title={`删除题目 ${key}`} onClick={()=>{if(window.confirm('删除大题及其小问？保存设置后生效，已有成绩不变。'))change({...draft,config:{...draft.config,confirmed:false,questions:draft.config.questions.filter((_,j)=>j!==i)}});}}><Trash2 size={14}/></button></div></td></tr>{expanded.has(key)&&children.map(child=><tr className="child-question-row" key={child.id}><td>↳ {child.label}</td><td colSpan={3}>{child.confirmed===false?'待核对':splitUnits(q)?'独立扣分单元':'随整题批改'}{splitUnits(q)&&child.missingPenalty!==undefined?' · 漏做 '+child.missingPenalty:''}{splitUnits(q)&&child.errorPenalty!==undefined?' · 错误 '+child.errorPenalty:''}</td><td><button className="text-button" onClick={()=>setEditing({index:i,q:structuredClone(q)})}>管理小问</button></td></tr>)}</Fragment>;})}</tbody></table></div>}
        <button className="text-button add-question" onClick={()=>setEditing({index:-1,q:courseQuestion({...blankQuestion(),number:'1'})})}><Plus size={14}/>添加题目</button>
        <label>补充题目或参考文字<textarea disabled={busy||helperBusy} rows={4} placeholder={'例如：\n1.1: 7,11,19,34,36'} value={draft.config.sourceText??''} onChange={e=>change({...draft,config:{...draft.config,sourceText:e.target.value,confirmed:false}})}/></label>
      </details>
    </section>
    {editing&&<QuestionModal q={editing.q} files={files} onDirty={setModalDirty} onClose={closeEditing} onSave={q=>{const questions=[...draft.config.questions];if(editing.index<0)questions.push(q);else questions[editing.index]=q;change({...draft,config:{...draft.config,questions,confirmed:false}});closeEditing();setMessage('题目已更新到当前清单，尚未保存。请点击“保存设置”。');}}/>}
    {review&&<ReferenceReview files={files} previous={draft.config} result={review} selected={replaceContent} onSelected={setReplaceContent} onKeep={keep} onApply={()=>{change({...draft,config:reconcileQuestions(draft.config,review.config,replaceContent)});setPrepared({scope:draft.scope,text:draft.config.sourceText??''});setReview(null);setMessage('整理结果已加入当前题目清单，尚未保存。请检查后点击“保存设置”。');}}/>}
  </div>;
}

function QuestionModal({q:original,files,onSave,onClose,onDirty}:{q:Question;files:StoredFile[];onDirty:(v:boolean)=>void;onSave:(q:Question)=>void;onClose:()=>void}) {
  const [q,setQ]=useState(original);const [error,setError]=useState('');
  const [pendingSource,setPendingSource]=useState(false);const changed=JSON.stringify(q)!==JSON.stringify(original);
  useBeforeUnload(changed||pendingSource);useEffect(()=>onDirty(changed||pendingSource),[changed,pendingSource,onDirty]);
  useEffect(()=>{if(!pendingSource)setError('');},[pendingSource]);
  function close(){if((changed||pendingSource)&&!window.confirm('本窗口的修改还没有应用。确定放弃这些修改并关闭？'))return;onClose();}
  const [parts,setParts]=useState(childrenOf(original).map(c=>c.label).join(', '));
  const children=childrenOf(q);const num=(v:string)=>v===''?null:Number(v);
  function updateChildren(next:ReturnType<typeof childrenOf>){setQ(withChildren(q,next));setParts(next.map(c=>c.label).join(', '));}
  function editContent(id:string,field:'prompt'|'answer',value:string){updateChildren(children.map(c=>{if(c.id!==id)return c;const next={...c,[field]:value,confirmed:false};return {...next,parseWarning:next.prompt?.trim()&&next.answer?.trim()?undefined:next.parseWarning};}));}
  function batchParts(value:string){
    setParts(value);const labels=value.split(/[,，、\s]+/).filter(Boolean);
    setQ(withChildren(q,labels.map(label=>children.find(c=>c.label===label)??{id:crypto.randomUUID(),label,confirmed:false})));
  }
  function move(index:number,offset:number){const next=[...children];[next[index],next[index+offset]]=[next[index+offset],next[index]];updateChildren(next);}
  return <Modal title="调整题目" onClose={close}><form onSubmit={e=>{
    e.preventDefault();if(pendingSource){setError('参考页选择还没有加入本题。请先点击添加或更换按钮，或取消本次选择。');return;}if(!q.section.trim()||!q.number.trim()){setError('请填写小节和题目标识（如 32、补充题1）。');return;}
    const result=configSchema.safeParse({total:10,mode:'deduction',principles:'',questions:[q],confirmed:false});
    if(!result.success){setError(result.error.issues.map(i=>i.message).join('；'));return;}onSave(q);
  }}>
    <div className="form-grid">
      <label>小节<input required value={q.section} onChange={e=>setQ({...q,section:e.target.value})}/></label>
      <label>题号<input required value={q.number} onChange={e=>setQ({...q,number:e.target.value})}/></label>
      <label>检查方式<select aria-label="检查方式" value={q.type} onChange={e=>setQ({...q,type:e.target.value as Question['type'],errorPenalty:e.target.value==='completion_only'?0:.1})}><option value="completion_only">仅检查完成</option><option value="graded">批改正确性</option></select></label>
      <label>题型<select value={q.kind??'solution'} onChange={e=>setQ({...q,kind:e.target.value as Question['kind']})}><option value="solution">解答题</option><option value="true_false">判断题</option></select></label>
      {q.kind!=='true_false'&&<label>解答题扣分单元<select value={q.unitMode??'whole'} onChange={e=>setQ({...q,unitMode:e.target.value as Question['unitMode']})}><option value="whole">整题一个单元</option><option value="independent">小问互相独立，逐项计分</option></select></label>}
      <label>漏做扣分<input type="number" step="0.1" min={0} max={10} value={q.missingPenalty??''} onChange={e=>setQ({...q,missingPenalty:num(e.target.value)})}/></label>
      <label>每处错误扣分<input type="number" step="0.1" min={0} max={10} disabled={q.type==='completion_only'} value={q.errorPenalty??''} onChange={e=>setQ({...q,errorPenalty:num(e.target.value)})}/></label>
    </div>
    {!q.part&&<section className="child-editor"><div className="section-heading"><h3>小问 <span className="count">{children.length}</span></h3><button type="button" onClick={()=>updateChildren([...children,{id:crypto.randomUUID(),label:String.fromCharCode(97+children.length),confirmed:false}])}>添加小问</button></div>
      <p className="subtle">{splitUnits(q)?'每个小问分别扣分，默认继承大题规则。':'小问仅表示题目结构，随整题批改。'}</p>
      <details className="quiet-details"><summary>批量编辑小问编号</summary><label>命题 / 独立小问列表（可选）<input value={parts} placeholder="例如 a,b,c" onChange={e=>batchParts(e.target.value)}/></label></details>
      {children.map((child,i)=><div className="child-editor-item" key={child.id}>
        <div className="child-editor-head"><label>编号<input aria-label={'小问编号 '+(i+1)} value={child.label} onChange={e=>updateChildren(children.map(c=>c.id===child.id?{...c,label:e.target.value,confirmed:false}:c))}/></label>
          <label className="checkbox"><input type="checkbox" checked={child.confirmed!==false} onChange={e=>updateChildren(children.map(c=>c.id===child.id?{...c,confirmed:e.target.checked}:c))}/>已核对</label>
          <button type="button" aria-label={'上移小问 '+child.label} disabled={i===0} onClick={()=>move(i,-1)}>↑</button><button type="button" aria-label={'下移小问 '+child.label} disabled={i===children.length-1} onClick={()=>move(i,1)}>↓</button>
          <button type="button" className="text-button danger-text" onClick={()=>updateChildren(children.filter(c=>c.id!==child.id))}>删除小问 {child.label}</button></div>
        <details className="quiet-details"><summary>小问内容{splitUnits(q)?'与个别扣分':''}</summary>
          {child.parseWarning&&<Notice>{child.parseWarning}</Notice>}
          {child.sourceText&&<details className="quiet-details"><summary>原始提取片段</summary><pre>{child.sourceText}</pre></details>}
          <label>小问题干（可选）<textarea aria-label="小问题干（可选）" rows={2} value={child.prompt??''} onChange={e=>editContent(child.id,'prompt',e.target.value)}/></label>
          <label>小问参考解（可选）<textarea aria-label="小问参考解（可选）" rows={3} value={child.answer??''} onChange={e=>editContent(child.id,'answer',e.target.value)}/></label>
          {splitUnits(q)&&<div className="form-grid">{(['missingPenalty','errorPenalty'] as const).map(field=><label key={field}>{field==='missingPenalty'?'小问漏做扣分':'小问错误扣分'}<input type="number" min="0" max="10" step=".1" placeholder={'继承 '+q[field]} value={child[field]??''} onChange={e=>updateChildren(children.map(c=>c.id===child.id?{...c,[field]:e.target.value===''?undefined:Number(e.target.value),confirmed:false}:c))}/></label>)}</div>}
        </details>
      </div>)}
      {children.length>0&&<label className="checkbox"><input type="checkbox" checked={children.every(c=>c.confirmed!==false)} onChange={e=>updateChildren(children.map(c=>({...c,confirmed:e.target.checked})))}/>已核对全部小问</label>}
    </section>}
    {q.part&&<p className="subtle">保留原有小问记录：{q.part}。新增小问请在所属大题下管理。</p>}
    {q.parseWarning&&<Notice>{q.parseWarning}</Notice>}
    {q.referenceExcerpt&&<details className="quiet-details"><summary>未分类提取片段</summary><pre>{q.referenceExcerpt}</pre></details>}
    <ReferenceSources value={q.referenceSources} files={files} section={q.section} onPendingChange={setPendingSource} onChange={referenceSources=>setQ({...q,referenceSources})}/>
    <label>特殊说明<textarea aria-label="特殊说明" rows={2} value={q.notes} onChange={e=>setQ({...q,notes:e.target.value})}/></label><details className="quiet-details"><summary>题干与参考解</summary><label>题干<textarea aria-label="题干" rows={3} value={q.prompt} onChange={e=>setQ({...q,prompt:e.target.value})}/></label><label>参考解<textarea aria-label="参考解" rows={4} value={q.answer} onChange={e=>setQ({...q,answer:e.target.value})}/></label></details>
    <p className="subtle">“应用调整”只更新当前题目清单；最后还需在页面上点击“保存设置”。</p>{error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary">应用调整</button></div>
  </form></Modal>;
}
