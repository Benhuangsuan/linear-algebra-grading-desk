import { Fragment, useState } from 'react';
import { ZodError } from 'zod';
import { ChevronDown, Plus, Pencil, Trash2, Save } from 'lucide-react';
import { blankQuestion, configSchema, questionKey, type Assignment, type Config, type Question, type StoredFile } from '../shared/domain';
import { courseQuestion } from '../shared/course';
import {childrenOf,withChildren,reconcileQuestions,splitUnits,childContentKey} from '../shared/questions';
import { api } from './api';
import { FilesPanel } from './FilesPanel';
import { Modal, Notice, useBeforeUnload } from './components';

export function ConfigEditor({assignment,files,onSaved,onDirty}:{assignment:Assignment;files:StoredFile[];onSaved:()=>Promise<void>;onDirty:(v:boolean)=>void}) {
  const [draft,setDraft]=useState(structuredClone(assignment));const [dirty,setDirty]=useState(false);
  const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
  const [warnings,setWarnings]=useState<string[]>([]);
  const [editing,setEditing]=useState<{index:number;q:Question}|null>(null);
  const [candidate,setCandidate]=useState<Config|null>(null);
  const [replaceContent,setReplaceContent]=useState<Set<string>>(new Set());
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const [prepared,setPrepared]=useState({scope:assignment.scope,text:assignment.config.sourceText??''});
  useBeforeUnload(dirty);
  function change(next:Assignment){setDraft(next);setDirty(true);onDirty(true);setMessage('');}
  async function prepare():Promise<Config>{
    const result=await api<{config:Config;warnings:string[]}>(`/assignments/${assignment.id}/prepare`,'POST',{scope:draft.scope,sourceText:draft.config.sourceText??''});
    setWarnings(result.warnings);
    return result.config;
  }
  async function generate(){
    setBusy(true);setError('');
    try {
      const config=await prepare();
      if(draft.config.questions.length){setReplaceContent(new Set());setCandidate(config);return;}
      change({...draft,config});setPrepared({scope:draft.scope,text:draft.config.sourceText??''});
      if(!config.questions.length)setError('没有识别到题号，请在下方补充题目清单。');
      else setMessage(`已整理 ${config.questions.length} 题，保存后生效。`);
    }catch(e){setError(e instanceof Error?e.message:'题目整理失败');}finally{setBusy(false);}
  }
  async function save(){
    if(!draft.title.trim()){setError('请填写作业名称。');return;}
    setBusy(true);setError('');
    try {
      if(prepared.scope!==draft.scope||prepared.text!==(draft.config.sourceText??'')){await generate();setMessage('请核对整理结果，再保存设置。');return;}
      const source=draft.config;
      const config={...source,confirmed:source.questions.length>0};configSchema.parse(config);
      await api(`/assignments/${assignment.id}`,'PUT',{title:draft.title,description:draft.description,scope:draft.scope,config,version:assignment.version,regradeUnconfirmed:false});
      setDirty(false);onDirty(false);await onSaved();setMessage('已保存');
    }catch(e){setError(e instanceof ZodError?[...new Set(e.issues.map(i=>/[\u4e00-\u9fff]/.test(i.message)?i.message:'请检查题目与分值配置。'))].join('；'):e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
  }
  return <div className="setup-page">
    {error&&<Notice tone="danger">{error}</Notice>}
    <div className="settings-section"><div className="section-heading"><h2>作业信息</h2><button className="primary" disabled={busy} onClick={()=>void save()}><Save size={15}/>{busy?'处理中…':'保存设置'}{dirty?' *':''}</button></div>
      <div className="form-grid"><label>作业名称<input value={draft.title} maxLength={200} onChange={e=>change({...draft,title:e.target.value})}/></label><label>作业范围<input placeholder="例如 1.1-1.3 或 2.2-2.4,2.8" value={draft.scope} onChange={e=>change({...draft,scope:e.target.value,config:{...draft.config,confirmed:false}})}/></label></div>
      <details className="quiet-details"><summary>补充说明</summary><textarea aria-label="作业说明" rows={3} value={draft.description} onChange={e=>change({...draft,description:e.target.value})}/></details>
    </div>
    <FilesPanel assignmentId={assignment.id} files={files} onRefresh={onSaved} onUploaded={async()=>{await onSaved();await generate();}} disabled={assignment.archived||busy}/>
    <section className="settings-section"><div className="section-heading"><h2>评分规则</h2></div><div className="rule-summary"><div><strong>10</strong><span>满分</span></div><div><strong>−0.2</strong><span>每题漏做</span></div><div><strong>−0.1</strong><span>每处错误</span></div></div>
      <p className="rule-description">按题目配置检查完成或批改正确性；未检索到作答暂按漏做处理。</p>
      <details className="quiet-details"><summary>判分原则</summary><p>判断题逐命题计分；解答题默认整题，接受正确的不同方法。仅明确独立的小题分别计分；同一单元不重复扣分，已有成绩保留原规则。</p></details>
      {!draft.config.policy&&<Notice>当前保留旧版规则。点击「整理题目清单」可使用以上课程规则；旧成绩会保留原规则。</Notice>}
    </section>
    <section className="settings-section"><div className="section-heading"><h2>题目清单 <span className="count">{draft.config.questions.length}</span></h2><button disabled={busy} onClick={()=>void generate()}>整理题目清单</button></div>
      {message&&<p className="save-message" role="status">{message}</p>}
      {warnings.length>0&&<details className="quiet-details"><summary>{warnings.length} 份材料需要补充题号</summary>{warnings.map(w=><p key={w}>{w}</p>)}</details>}
      <details className="question-disclosure"><summary><ChevronDown size={15}/>{draft.config.questions.length?'查看题目与调整个别规则':'补充题目清单'}</summary>
        {draft.config.questions.length>0&&<div className="question-table-scroll"><table className="question-table"><thead><tr><th>题目</th><th>检查方式</th><th>漏做扣分</th><th>错误扣分</th><th/></tr></thead><tbody>{draft.config.questions.map((q,i)=>{const key=questionKey(q);const children=childrenOf(q);return <Fragment key={key}><tr><td>{key}{children.length>0&&<button className="text-button child-disclosure" aria-label={`展开小问 ${key}`} aria-expanded={expanded.has(key)} onClick={()=>setExpanded(old=>{const next=new Set(old);next.has(key)?next.delete(key):next.add(key);return next;})}>{children.length} 小问 · {splitUnits(q)?children.length:1} 单元 <ChevronDown size={13}/></button>}</td><td>{q.type==='completion_only'?'仅检查完成':'批改正确性'}</td><td>{q.missingPenalty??'未设'}</td><td>{q.type==='completion_only'?'—':q.errorPenalty??'未设'}</td><td><div className="toolbar"><button className="icon-button" title={`调整 ${key}`} onClick={()=>setEditing({index:i,q:structuredClone(q)})}><Pencil size={14}/></button><button className="icon-button danger-text" title={`删除题目 ${key}`} onClick={()=>{if(window.confirm('删除大题及其小问？保存设置后生效，已有成绩不变。'))change({...draft,config:{...draft.config,confirmed:false,questions:draft.config.questions.filter((_,j)=>j!==i)}});}}><Trash2 size={14}/></button></div></td></tr>{expanded.has(key)&&children.map(child=><tr className="child-question-row" key={child.id}><td>↳ {child.label}</td><td colSpan={3}>{child.confirmed===false?'待核对':splitUnits(q)?'独立扣分单元':'随整题批改'}{splitUnits(q)&&child.missingPenalty!==undefined?' · 漏做 '+child.missingPenalty:''}{splitUnits(q)&&child.errorPenalty!==undefined?' · 错误 '+child.errorPenalty:''}</td><td><button className="text-button" onClick={()=>setEditing({index:i,q:structuredClone(q)})}>管理小问</button></td></tr>)}</Fragment>;})}</tbody></table></div>}
        <button className="text-button add-question" onClick={()=>setEditing({index:-1,q:courseQuestion({...blankQuestion(),number:'1'})})}><Plus size={14}/>添加题目</button>
        <label>补充题目或参考文字<textarea rows={4} placeholder={'例如：\n1.1: 7,11,19,34,36\n1.2: 13,26,35,36'} value={draft.config.sourceText??''} onChange={e=>change({...draft,config:{...draft.config,sourceText:e.target.value,confirmed:false}})}/></label>
      </details>
    </section>
    {editing&&<QuestionModal q={editing.q} onClose={()=>setEditing(null)} onSave={q=>{const questions=[...draft.config.questions];if(editing.index<0)questions.push(q);else questions[editing.index]=q;change({...draft,config:{...draft.config,questions,confirmed:false}});setEditing(null);}}/>}
    {candidate&&<Modal title="核对题目整理差异" onClose={()=>setCandidate(null)}><p>识别到 {candidate.questions.length} 道大题。默认仅补充新题与新小问，保留教师已有设置。同编号的小问内容可展开差异，单独选择替换到草稿；仍需核对并保存。</p><div className="candidate-list">{candidate.questions.map(q=>{const old=draft.config.questions.find(o=>questionKey(o)===questionKey(q));return <p key={questionKey(q)}><strong>{questionKey(q)}</strong>：{old?(childrenOf(old).map(c=>c.label).join('、')||'无小问'):'新增大题'} → {childrenOf(q).map(c=>c.label).join('、')||'整题'}{old&&childrenOf(old).some(c=>!childrenOf(q).some(p=>p.label===c.label))?'（已有小问保留）':''}</p>;})}{candidate.questions.flatMap(q=>childrenOf(q).map(child=>{const old=draft.config.questions.find(o=>questionKey(o)===questionKey(q));const prior=old&&childrenOf(old).find(c=>c.label===child.label);if(!prior||prior.prompt===child.prompt&&prior.answer===child.answer)return null;const key=childContentKey(q,child.label);return <details className="quiet-details" key={key}><summary>{questionKey(q)} / {child.label} 内容差异</summary><p>现有题干：{prior.prompt||'（空）'}</p><p>现有参考解：{prior.answer||'（空）'}</p><p>候选题干：{child.prompt||'（待人工补录）'}</p><p>候选参考解：{child.answer||'（待人工补录）'}</p>{child.parseWarning&&<p>{child.parseWarning}</p>}<label className="checkbox"><input type="checkbox" aria-label={'采用小问内容 '+questionKey(q)+' / '+child.label} checked={replaceContent.has(key)} onChange={e=>setReplaceContent(current=>{const next=new Set(current);e.target.checked?next.add(key):next.delete(key);return next;})}/>采用该小问候选内容（覆盖此项旧文字，扣分规则保留）</label></details>;}))}</div><div className="modal-actions"><button onClick={()=>{setPrepared({scope:draft.scope,text:draft.config.sourceText??''});setCandidate(null);setMessage('保留教师配置；保存设置后生效。');}}>保留教师配置</button><button className="primary" onClick={()=>{const merged=reconcileQuestions(draft.config,candidate,replaceContent);change({...draft,config:merged});setPrepared({scope:draft.scope,text:draft.config.sourceText??''});setCandidate(null);setMessage('候选已补入草稿，请展开小问核对并保存。');}}>补充候选到草稿</button></div></Modal>}
  </div>;
}

function QuestionModal({q:original,onSave,onClose}:{q:Question;onSave:(q:Question)=>void;onClose:()=>void}) {
  const [q,setQ]=useState(original);const [error,setError]=useState('');
  const [parts,setParts]=useState(childrenOf(original).map(c=>c.label).join(', '));
  const children=childrenOf(q);const num=(v:string)=>v===''?null:Number(v);
  function updateChildren(next:ReturnType<typeof childrenOf>){setQ(withChildren(q,next));setParts(next.map(c=>c.label).join(', '));}
  function editContent(id:string,field:'prompt'|'answer',value:string){updateChildren(children.map(c=>{if(c.id!==id)return c;const next={...c,[field]:value,confirmed:false};return {...next,parseWarning:next.prompt?.trim()&&next.answer?.trim()?undefined:next.parseWarning};}));}
  function batchParts(value:string){
    setParts(value);const labels=value.split(/[,，、\s]+/).filter(Boolean);
    setQ(withChildren(q,labels.map(label=>children.find(c=>c.label===label)??{id:crypto.randomUUID(),label,confirmed:false})));
  }
  function move(index:number,offset:number){const next=[...children];[next[index],next[index+offset]]=[next[index+offset],next[index]];updateChildren(next);}
  return <Modal title="调整题目" onClose={onClose}><form onSubmit={e=>{
    e.preventDefault();if(!q.section.trim()||!/^\d+$/.test(q.number)){setError('请填写小节和数字题号。');return;}
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
          <label>小问题干（可选）<textarea rows={2} value={child.prompt??''} onChange={e=>editContent(child.id,'prompt',e.target.value)}/></label>
          <label>小问参考解（可选）<textarea rows={3} value={child.answer??''} onChange={e=>editContent(child.id,'answer',e.target.value)}/></label>
          {splitUnits(q)&&<div className="form-grid">{(['missingPenalty','errorPenalty'] as const).map(field=><label key={field}>{field==='missingPenalty'?'小问漏做扣分':'小问错误扣分'}<input type="number" min="0" max="10" step=".1" placeholder={'继承 '+q[field]} value={child[field]??''} onChange={e=>updateChildren(children.map(c=>c.id===child.id?{...c,[field]:e.target.value===''?undefined:Number(e.target.value),confirmed:false}:c))}/></label>)}</div>}
        </details>
      </div>)}
      {children.length>0&&<label className="checkbox"><input type="checkbox" checked={children.every(c=>c.confirmed!==false)} onChange={e=>updateChildren(children.map(c=>({...c,confirmed:e.target.checked})))}/>已核对全部小问</label>}
    </section>}
    {q.part&&<p className="subtle">保留原有小问记录：{q.part}。新增小问请在所属大题下管理。</p>}
    <label>特殊说明<textarea rows={2} value={q.notes} onChange={e=>setQ({...q,notes:e.target.value})}/></label><details className="quiet-details"><summary>题干与参考解</summary><label>题干<textarea rows={3} value={q.prompt} onChange={e=>setQ({...q,prompt:e.target.value})}/></label><label>参考解<textarea rows={4} value={q.answer} onChange={e=>setQ({...q,answer:e.target.value})}/></label></details>
    {error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary">应用调整</button></div>
  </form></Modal>;
}
