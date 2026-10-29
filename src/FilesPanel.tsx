import { useRef, useState, useId } from 'react';
import { Upload, FileText, Trash2, ExternalLink } from 'lucide-react';
import type { StoredFile } from '../shared/domain';
import { api, contentUrl } from './api';
import { Modal, Notice } from './components';

export function UploadBox({assignmentId,kind,onDone,label,disabled=false}:{assignmentId:string;kind:StoredFile['kind'];onDone:(files?:StoredFile[])=>Promise<void>;label?:string;disabled?:boolean}) {
  const input=useRef<HTMLInputElement>(null);
  const helpId=useId();
  const [busy,setBusy]=useState(false);const [progress,setProgress]=useState('');const [error,setError]=useState('');
  async function upload(files:FileList) {
    if(busy||disabled)return;
    const selected=Array.from(files);
    if(selected.length>50){setError('每次最多上传 50 份文件。');return;}
    setBusy(true);setError('');const created:StoredFile[]=[];const errors:string[]=[];
    try {
      for(let i=0;i<selected.length;i++){
        const f=selected[i];setProgress(`${i+1}/${selected.length}`);
        const form=new FormData();form.append('file',f);form.append('kind',kind);
        try {
          let result:StoredFile;
          try {result=await api(`/assignments/${assignmentId}/files`,'POST',form);}
          catch(e){if(e instanceof Error&&e.message.startsWith('同名文件')&&window.confirm(`“${f.name}”已存在，是否保留两份？`)){form.append('duplicate','keep');result=await api(`/assignments/${assignmentId}/files`,'POST',form);}else throw e;}
          created.push(result);
        }catch(e){errors.push(`${f.name}：${e instanceof Error?e.message:'上传失败'}`);}
      }
      if(created.length)await onDone(created);
      if(errors.length)setError(errors.join('\n'));
    }catch(e){setError(e instanceof Error?e.message:'处理上传结果失败，请重试。');}
    finally{setBusy(false);setProgress('');if(input.current)input.current.value='';}
  }
  const caption=label??(kind==='student'?'上传作业':'添加文件');
  return <div className="upload-control" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files);}}>
    <button className={kind==='student'?'primary':''} disabled={busy||disabled} aria-describedby={busy||disabled?helpId:undefined} title="可多选或拖入文件，每份不超过 30 MB" onClick={()=>input.current?.click()}><Upload size={16}/>{busy?`上传中 ${progress}`:caption}</button>
    {(busy||disabled)&&<span id={helpId} className="control-hint">{busy?'正在上传，请等待完成。':'当前暂不能上传；归档作业请先取消归档，正在整理或保存时请等待完成。'}</span>}
    <input ref={input} hidden aria-label={caption} type="file" accept={kind==='student'?'.pdf':'.pdf,.docx'} multiple onChange={e=>{if(e.target.files)void upload(e.target.files);}}/>
    {error&&<div className="upload-error" role="alert">{error}<button className="text-button" onClick={()=>setError('')}>关闭</button></div>}
  </div>;
}

export function FilesPanel({assignmentId,files,onRefresh,onUploaded,disabled}:{assignmentId:string;files:StoredFile[];onRefresh:()=>Promise<void>;onUploaded:(files?:StoredFile[])=>Promise<void>;disabled?:boolean}) {
  const [kind,setKind]=useState<'reference'|'prompt'>('reference');const [preview,setPreview]=useState<StoredFile|null>(null);const [error,setError]=useState('');
  const materials=files.filter(f=>f.kind!=='student');
  async function remove(f:StoredFile){if(!window.confirm(`删除参考材料“${f.name}”？`))return;try{await api(`/files/${f.id}`,'DELETE');await onRefresh();}catch(e){setError(e instanceof Error?e.message:'删除失败');}}
  return <section className="settings-section">
    <div className="section-heading"><h2>参考材料</h2><div className="toolbar"><select className="inline-select" aria-label="材料类型" value={kind} onChange={e=>setKind(e.target.value as 'reference'|'prompt')}><option value="reference">参考答案</option><option value="prompt">作业原题</option></select><UploadBox assignmentId={assignmentId} kind={kind} onDone={onUploaded} disabled={disabled}/></div></div>
    {error&&<Notice tone="danger">{error}</Notice>}
    {materials.length?<div className="material-list">{materials.map(f=><div className="material-row" key={f.id}><FileText size={18}/><span className="material-name">{f.name}</span><span className="subtle material-kind">{f.kind==='reference'?'答案':'原题'}</span><div className="toolbar">{f.mime==='application/pdf'?<a className="text-button" href={contentUrl(f.id)} target="_blank" rel="noreferrer">查看<ExternalLink size={13}/></a>:<button className="text-button" onClick={()=>setPreview(f)}>查看</button>}<button className="icon-button danger-text" title={`删除 ${f.name}`} disabled={disabled} onClick={()=>void remove(f)}><Trash2 size={14}/></button></div></div>)}</div>:<p className="empty-line">上传参考答案后，选择文件和识别方式，再明确开始整理。</p>}
    {preview&&<Modal title={preview.name} onClose={()=>setPreview(null)}><Notice>数学公式以原文件为准。需要完整预览时，请用 Word 导出 PDF 后上传。</Notice><pre className="docx-text">{preview.text||'没有可提取的文字。'}</pre><a className="button" href={contentUrl(preview.id)}>下载原文件</a></Modal>}
  </section>;
}
