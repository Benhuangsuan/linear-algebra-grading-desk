import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookOpen, Plus, ChevronRight, HelpCircle, FolderOpen } from 'lucide-react';
import { type Assignment, type Course, type State } from '../shared/domain';
import { courseConfig } from '../shared/course';
import { api } from './api';
import { Modal, Notice, ActionMenu, useBeforeUnload } from './components';
import { ConfigEditor } from './ConfigEditor';
import { ReviewWorkspace } from './ReviewWorkspace';
import './styles.css';

const initial=new URLSearchParams(window.location.search);
type Tab='students'|'settings';
function App(){
  const [state,setState]=useState<State|null>(null);const [courseId,setCourseId]=useState(initial.get('course')??'');
  const [assignmentId,setAssignmentId]=useState(initial.get('assignment')??'');const [tab,setTab]=useState<Tab>(initial.get('tab')==='settings'?'settings':'students');
  const [error,setError]=useState('');const [dirty,setDirty]=useState(false);const [help,setHelp]=useState(false);
  const [courseModal,setCourseModal]=useState<Course|'new'|null>(null);const [newAssignment,setNewAssignment]=useState(false);const [showArchived,setShowArchived]=useState(false);
  useBeforeUnload(dirty);
  const refreshId=useRef(0);
  const refresh=useCallback(async()=>{const id=++refreshId.current;const next=await api<State>('/state');if(id===refreshId.current){setState(next);setError('');}},[]);
  const handleError=useCallback((e:unknown)=>setError(e instanceof Error?e.message:'操作失败'),[]);
  useEffect(()=>{const sync=()=>void refresh().catch(handleError);const visible=()=>{if(document.visibilityState==='visible')sync();};sync();window.addEventListener('focus',sync);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',visible);};},[refresh,handleError]);
  const queued=state?.submissions.some(s=>['queued','processing'].includes(s.status));
  useEffect(()=>{if(!queued)return;const timer=setInterval(()=>void refresh().catch(handleError),1000);return()=>clearInterval(timer);},[queued,refresh,handleError]);
  const course=state?.courses.find(c=>c.id===courseId)??state?.courses[0];
  const assignment=state?.assignments.find(a=>a.id===assignmentId&&a.courseId===course?.id);
  const assignments=state?.assignments.filter(a=>a.courseId===course?.id)??[];
  const files=state?.files.filter(f=>f.assignmentId===assignment?.id)??[];
  const submissions=state?.submissions.filter(s=>s.assignmentId===assignment?.id)??[];
  useEffect(()=>{if(!state)return;const query=new URLSearchParams();if(course)query.set('course',course.id);if(assignment){query.set('assignment',assignment.id);query.set('tab',tab);}window.history.replaceState(null,'',`${window.location.pathname}${query.size?'?'+query:''}`);},[state,course?.id,assignment?.id,tab]);
  function navigate(action:()=>void){if(dirty&&!window.confirm('有未保存的修改，确定放弃并离开？'))return;setDirty(false);action();}
  async function removeCourse(){if(!course||!window.confirm(`删除课程“${course.name}”及其中所有作业和成绩？`))return;try{await api(`/courses/${course.id}`,'DELETE');setCourseId('');setAssignmentId('');await refresh();}catch(e){handleError(e);}}
  async function removeAssignment(a:Assignment){if(!window.confirm(`删除“${a.title}”及其所有文件和成绩？`))return;try{await api(`/assignments/${a.id}`,'DELETE');setAssignmentId('');await refresh();}catch(e){handleError(e);}}
  async function archive(a:Assignment){try{await api(`/assignments/${a.id}`,'PATCH',{archived:!a.archived});setAssignmentId('');await refresh();}catch(e){handleError(e);}}
  function open(a:Assignment){navigate(()=>{setAssignmentId(a.id);setTab('students');});}
  return <div className="app">
    <aside className="sidebar"><a className="brand" href="/" onClick={e=>{e.preventDefault();navigate(()=>setAssignmentId(''));}}><span className="brand-symbol">∑</span><strong>作业批改</strong></a>
      <div className="sidebar-section"><span>课程</span><button className="icon-button" aria-label="新增课程" onClick={()=>navigate(()=>{setAssignmentId('');setCourseModal('new');})}><Plus size={17}/></button></div>
      <nav aria-label="课程列表">{state?.courses.map(c=><button key={c.id} className={`course-link ${c.id===course?.id?'active':''}`} onClick={()=>navigate(()=>{setCourseId(c.id);setAssignmentId('');})}><BookOpen size={17}/><span>{c.name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className="text-button" onClick={()=>setHelp(true)}><HelpCircle size={15}/>使用说明</button><span>2.4.0</span></div>
    </aside>
    <main><header className="topbar"><div className="breadcrumbs"><button onClick={()=>navigate(()=>setAssignmentId(''))}>{course?.name??'课程'}</button>{assignment&&<><ChevronRight size={14}/><span>{assignment.title}</span></>}</div><button className="mode-pill" onClick={()=>setHelp(true)}>Mock / AI</button></header>
      {error&&<div className="connection-error"><Notice tone="danger">{error}<button className="text-button" onClick={()=>void refresh().catch(handleError)}>重试连接</button></Notice></div>}
      {!state?<div className="loading-state">{error?'本地服务未连接':'正在打开…'}</div>:!course?<div className="content"><div className="empty-state"><FolderOpen size={32}/><h1>创建第一门课程</h1><button className="primary" onClick={()=>setCourseModal('new')}><Plus size={16}/>创建课程</button></div></div>:!assignment?<div className="content course-page">
        <div className="page-heading"><h1>{course.name}</h1><div className="toolbar"><button className="primary" onClick={()=>setNewAssignment(true)}><Plus size={16}/>新建作业</button><ActionMenu label="课程操作"><button onClick={()=>setCourseModal(course)}>重命名课程</button><button className="danger-text" onClick={()=>void removeCourse()}>删除课程</button></ActionMenu></div></div>
        <div className="section-heading course-list-title"><h2>课程作业</h2><label className="checkbox"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>显示归档</label></div>
        <div className="assignment-list"><div className="assignment-list-heading"><span>名称</span><span>范围</span><span>已确认</span><span/></div>
          {assignments.filter(a=>showArchived||!a.archived).map(a=>{const ss=state.submissions.filter(s=>s.assignmentId===a.id);return <div className="assignment-row" key={a.id}><button className="assignment-open" onClick={()=>open(a)}><FolderOpen size={19}/><strong>{a.title}</strong>{a.archived&&<span className="row-state">已归档</span>}</button><span className="subtle">{a.scope||'—'}</span><span className="subtle">{ss.filter(s=>s.status==='confirmed').length} / {ss.length}</span><ActionMenu label={`作业操作 ${a.title}`}><button onClick={()=>{open(a);setTab('settings');}}>编辑设置</button><button onClick={()=>void archive(a)}>{a.archived?'取消归档':'归档作业'}</button><button className="danger-text" onClick={()=>void removeAssignment(a)}>删除作业</button></ActionMenu></div>;})}
          {!assignments.filter(a=>showArchived||!a.archived).length&&<div className="list-empty">还没有作业，点击「新建作业」开始。</div>}
        </div>
      </div>:<><div className="assignment-header"><div className="page-heading"><div><h1>{assignment.title}</h1>{assignment.scope&&<p>{assignment.scope}</p>}</div><ActionMenu label="当前作业操作"><button onClick={()=>navigate(()=>void archive(assignment))}>{assignment.archived?'取消归档':'归档作业'}</button><button className="danger-text" onClick={()=>navigate(()=>void removeAssignment(assignment))}>删除作业</button></ActionMenu></div><nav className="tabs" aria-label="作业页面"><button className={tab==='students'?'active':''} onClick={()=>navigate(()=>setTab('students'))}>学生作业</button><button className={tab==='settings'?'active':''} onClick={()=>navigate(()=>setTab('settings'))}>作业设置</button></nav></div>
        <div className="content assignment-content">{assignment.archived&&<Notice>作业已归档。需要继续批改时，请先取消归档。</Notice>}{tab==='students'?<ReviewWorkspace key={assignment.id} assignment={assignment} submissions={submissions} files={files} onRefresh={refresh} onDirty={setDirty} onSetup={()=>navigate(()=>setTab('settings'))}/>:<ConfigEditor key={`${assignment.id}:${assignment.version}`} assignment={assignment} files={files} onSaved={refresh} onDirty={setDirty}/>}</div>
      </>}
    </main>
    {courseModal&&<CourseModal course={courseModal} onClose={()=>setCourseModal(null)} onSaved={async id=>{setCourseModal(null);setCourseId(id);setAssignmentId('');await refresh();}}/>}
    {newAssignment&&course&&<AssignmentModal course={course} assignments={assignments} onClose={()=>setNewAssignment(false)} onSaved={async a=>{setNewAssignment(false);setAssignmentId(a.id);setTab('settings');await refresh();}}/>}
    {help&&<Modal title="使用说明 · 2.4.0" onClose={()=>setHelp(false)}><p>先在作业设置中上传参考答案、保存题目清单，再上传学生作业并开始批改。</p><p>Mock 评分仅供演示；AI 批改需在弹窗主动选择服务、核对规则并同意传输。需要时可打开原稿、人工修改并确认成绩。</p><p>数据保存在本机的 data 文件夹。备份前先停止服务，再复制整个文件夹。完整操作步骤见项目 README.md。</p></Modal>}
  </div>;
}

function CourseModal({course,onClose,onSaved}:{course:Course|'new';onClose:()=>void;onSaved:(id:string)=>Promise<void>}) {
  const [name,setName]=useState(course==='new'?'':course.name);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  return <Modal title={course==='new'?'新建课程':'重命名课程'} onClose={onClose}><form onSubmit={e=>{e.preventDefault();setBusy(true);void api<Course>(course==='new'?'/courses':`/courses/${course.id}`,course==='new'?'POST':'PATCH',{name}).then(c=>onSaved(course==='new'?c.id:course.id)).catch(e=>setError(e instanceof Error?e.message:'保存失败')).finally(()=>setBusy(false));}}><label>课程名称<input required autoFocus maxLength={200} value={name} placeholder="线性代数与几何" onChange={e=>setName(e.target.value)}/></label>{error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>保存课程</button></div></form></Modal>;
}
function AssignmentModal({course,assignments,onClose,onSaved}:{course:Course;assignments:Assignment[];onClose:()=>void;onSaved:(a:Assignment)=>Promise<void>}) {
  const [title,setTitle]=useState('');const [scope,setScope]=useState('');const [copyFrom,setCopyFrom]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  return <Modal title="新建作业" onClose={onClose}><form onSubmit={e=>{e.preventDefault();setBusy(true);void api<Assignment>('/assignments','POST',{courseId:course.id,title,scope,description:'',config:courseConfig(),copyFrom:copyFrom||undefined}).then(onSaved).catch(e=>setError(e instanceof Error?e.message:'创建失败')).finally(()=>setBusy(false));}}><label>作业名称<input required autoFocus maxLength={200} value={title} placeholder="第 1 次作业" onChange={e=>setTitle(e.target.value)}/></label><label>作业范围<input value={scope} placeholder="例如 1.1-1.3" onChange={e=>setScope(e.target.value)}/></label>{assignments.length>0&&<details className="quiet-details"><summary>复制已有作业的设置</summary><select aria-label="复制配置" value={copyFrom} onChange={e=>setCopyFrom(e.target.value)}><option value="">不复制</option>{assignments.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}</select></details>}{error&&<Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>创建作业</button></div></form></Modal>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
