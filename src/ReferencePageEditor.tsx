import {useEffect,useState} from 'react';
import type {StoredFile} from '../shared/domain';
import {recommendedReference,referenceSections,needsReferenceConfirmation,editReferencePage,type ReferenceSource} from '../shared/reference';
import {Notice} from './components';

export function ReferenceSources({value=[],files,section,onChange,onPendingChange}:{value?:ReferenceSource[];files:StoredFile[];section:string;onChange:(s:ReferenceSource[])=>void;onPendingChange:(v:boolean)=>void}){
  const materials=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf');
  const [fileId,setFileId]=useState(()=>recommendedReference(materials,section)),[page,setPage]=useState('1'),[graphic,setGraphic]=useState(true);
  const [replaceIndex,setReplaceIndex]=useState<number|null>(null),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const materialKey=JSON.stringify(materials.map(f=>[f.id,...referenceSections(f)]));
  function reset(){setFileId(recommendedReference(materials,section));setPage('1');setGraphic(true);setReplaceIndex(null);setConfirmed(false);setPending(false);setError('');}
  useEffect(()=>{reset();},[section,materialKey]);
  useEffect(()=>onPendingChange(pending),[pending,onPendingChange]);
  const selected=materials.find(f=>f.id===fileId),needsConfirmation=selected&&needsReferenceConfirmation(selected,section);
  function touch(){setPending(true);setConfirmed(false);setError('');setMessage('');}
  function apply(){
    try{const next=editReferencePage(value,materials,section,{fileId,page:Number(page),graphic},replaceIndex,confirmed);onChange(next);setMessage(replaceIndex===null?'这页已添加到本题。请点“应用调整”，再在页面上保存设置。':'本题参考页已更换。请点“应用调整”，再在页面上保存设置。');reset();}
    catch(e){setError(e instanceof Error?e.message:'参考页修改失败，请检查文件和页码。');}
  }
  return <details className="quiet-details reference-sources"><summary>题目对应的参考答案页面（{value.length}）</summary>
    <div className="reference-existing"><h4>已关联的参考页</h4>{!value.length&&<p className="subtle">尚未添加参考页。下面的选择不会自动添加。</p>}
      {value.map((s,i)=>{const file=materials.find(f=>f.id===s.fileId);return <div key={s.fileId+':'+s.page} className="reference-source">
        <p><strong>{file?.name??'参考文件已删除或不属于本作业'} · 第 {s.page} 页</strong></p>
        <label className="checkbox"><input type="checkbox" checked={s.graphic} onChange={e=>{onChange(value.map((v,j)=>j===i?{...v,graphic:e.target.checked}:v));setMessage('图形用途已修改，尚未保存。');}}/>这页含有本题需要的图形（各小问共用）</label>
        <div className="toolbar"><button type="button" onClick={()=>{setReplaceIndex(i);setFileId(s.fileId);setPage(String(s.page));setGraphic(s.graphic);touch();}}>更换这页参考</button><button type="button" className="text-button" onClick={()=>{onChange(value.filter((_,j)=>j!==i));reset();setMessage('已从本题移除这页参考，PDF 原文件保留；尚未保存。');}}>移除这页参考</button></div>
        {file?<details className="quiet-details"><summary>预览参考答案页面</summary><img className="reference-page" src={`/api/files/${s.fileId}/pages/${s.page}`} alt={`参考答案第 ${s.page} 页`} onError={()=>setError('参考答案页面无法读取，请检查原文件和页码后再批改。')}/></details>:<Notice>请更换或移除这条失效的参考页。</Notice>}
      </div>;})}
    </div>
    {materials.length>0&&<div className="reference-add"><h4>{replaceIndex===null?'添加参考页':'更换参考页'}</h4><p className="subtle">选择文件和页码后，点击下方按钮才会修改上方列表。</p>
      <div className="form-grid"><label>{replaceIndex===null?'要添加的参考答案':'要换成的参考答案'}<select aria-label={replaceIndex===null?'要添加的参考答案':'要换成的参考答案'} value={fileId} onChange={e=>{setFileId(e.target.value);touch();}}><option value="">请选择参考答案</option>{materials.map(f=><option value={f.id} key={f.id}>{f.name}</option>)}</select></label><label>PDF 页码<input type="number" min="1" max={selected?.pages??100} value={page} onChange={e=>{setPage(e.target.value);touch();}}/></label></div>
      {!fileId&&<p className="subtle">没有唯一匹配本题小节 {section} 的文件，请自行选择。</p>}
      <label className="checkbox"><input type="checkbox" checked={graphic} onChange={e=>{setGraphic(e.target.checked);touch();}}/>添加的这页包含本题需要的图形</label>
      {needsConfirmation&&<Notice>这份文件的小节{referenceSections(selected).length?'为 '+referenceSections(selected).join('、'):'无法确定'}，本题属于 {section}。<label className="checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认这页确实用于本题</label></Notice>}
      <div className="toolbar"><button type="button" onClick={apply}>{replaceIndex===null?'添加这页作为题目参考':'确认更换这页参考'}</button>{(pending||replaceIndex!==null)&&<button type="button" className="text-button" onClick={()=>{reset();setMessage('已取消本次选择，上方参考页没有改变。');}}>取消本次选择</button>}</div>
      {pending&&<p className="subtle">这次选择尚未加入本题，请先点击上方添加或更换按钮。</p>}
    </div>}
    {message&&<p className="save-message" role="status">{message}</p>}{error&&<Notice tone="danger">{error}</Notice>}
  </details>;
}
