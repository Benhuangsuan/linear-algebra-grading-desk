import type {Config,StoredFile} from '../shared/domain';
import {questionKey} from '../shared/domain';
import {childrenOf,childContentKey,parentContentKey,questionContentChanged,questionImportSummary} from '../shared/questions';
import {Modal} from './components';

export type ImportResult={config:Config;warnings:string[];materialCounts?:{fileId:string;name:string;questions:number}[];uploadedIds?:string[]};
export function ReferenceReview({previous,result,files,selected,onSelected,onKeep,onApply}:{previous:Config;result:ImportResult;files:StoredFile[];selected:Set<string>;onSelected:(s:Set<string>)=>void;onKeep:()=>void;onApply:()=>void}){
  const summary=questionImportSummary(previous,result.config),canAdd=summary.added.length+summary.newChildren.length>0;
  const pages=(q:Config['questions'][number])=>q.referenceSources?.map(s=>(files.find(f=>f.id===s.fileId)?.name??'参考文件已删除')+' · 第 '+s.page+' 页'+(s.graphic?'（含图形）':'')).join('；')||'无';
  const uploads=result.materialCounts?.filter(f=>result.uploadedIds?.includes(f.fileId))??[];
  function choose(key:string,checked:boolean){const next=new Set(selected);checked?next.add(key):next.delete(key);onSelected(next);}
  function close(){if(selected.size&&!window.confirm('勾选的修改还没有加入题目清单。确定暂不采用并关闭？'))return;onKeep();}
  const action=selected.size?(canAdd?'添加新题并采用勾选的修改':'采用勾选的修改'):'添加新发现的题目（推荐）';
  return <Modal title="检查整理出的题目" onClose={close}>
    <div className="import-summary"><p>当前已有 <strong>{summary.current}</strong> 道题。本次共整理出 <strong>{summary.found}</strong> 道，其中 <strong>{summary.added.length}</strong> 道是新题，<strong>{summary.existing.length}</strong> 道已在清单中。</p>
      {uploads.length>0&&<p>新上传的文件：{uploads.map(f=>`${f.name}（识别出 ${f.questions} 道题）`).join('；')}。上面的总数也包括其他已上传材料。</p>}
      {summary.newChildren.length>0&&<p>另外发现已有大题下的 {summary.newChildren.length} 个新小问。</p>}
    </div>
    <p>添加后只更新当前页面的题目清单，<strong>还要点击“保存设置”才会保存到本机</strong>。已有扣分规则和人工修改默认保留。</p>
    <div className="candidate-list">
      {summary.added.length>0&&<section><h3>将添加的新题（{summary.added.length}）</h3><p>{summary.added.map(questionKey).join('、')}</p></section>}
      {summary.newChildren.length>0&&<section><h3>将添加的新小问</h3><p>{summary.newChildren.map(c=>c.parent+' / '+c.label).join('、')}</p></section>}
      {summary.existing.length>0&&<details className="quiet-details"><summary>已有题目与新内容的比较（{summary.existing.length}）</summary><p className="subtle">只替换你明确勾选的文字或参考页面；各题扣分规则、备注和已有成绩保留。</p>
        {summary.existing.map(q=>{const prior=previous.questions.find(p=>questionKey(p)===questionKey(q))!;const key=parentContentKey(q);return <section key={key} className="import-existing"><h4>{questionKey(q)}</h4>
          {questionContentChanged(prior,q)&&<details className="quiet-details"><summary>比较题干、参考解和参考页面</summary><p>现有题干：{prior.prompt||'（空）'}</p><p>这次整理的题干：{q.prompt||'（空）'}</p><p>现有参考解：{prior.answer||'（空）'}</p><p>这次整理的参考解：{q.answer||'（空）'}</p><p>现有参考页：{pages(prior)}</p><p>这次整理的参考页：{pages(q)}</p><label className="checkbox"><input type="checkbox" aria-label={'更新大题内容 '+questionKey(q)} checked={selected.has(key)} onChange={e=>choose(key,e.target.checked)}/>用这些内容替换本题现有题干、参考解和参考页面</label></details>}
          {childrenOf(q).map(child=>{const old=childrenOf(prior).find(c=>c.label===child.label);if(!old||old.prompt===child.prompt&&old.answer===child.answer)return null;const childKey=childContentKey(q,child.label);return <details className="quiet-details" key={childKey}><summary>{questionKey(q)} / {child.label} 内容差异</summary><p>现有题干：{old.prompt||'（空）'}</p><p>现有参考解：{old.answer||'（空）'}</p><p>这次整理的题干：{child.prompt||'（待补录）'}</p><p>这次整理的参考解：{child.answer||'（待补录）'}</p>{child.parseWarning&&<p>{child.parseWarning}</p>}<label className="checkbox"><input type="checkbox" aria-label={'更新小问内容 '+questionKey(q)+' / '+child.label} checked={selected.has(childKey)} onChange={e=>choose(childKey,e.target.checked)}/>用这些内容替换本小问现有文字（扣分不变）</label></details>;})}
          {!questionContentChanged(prior,q)&&!childrenOf(q).some(c=>{const old=childrenOf(prior).find(p=>p.label===c.label);return old&&(old.prompt!==c.prompt||old.answer!==c.answer);})&&<p className="subtle">保留现有内容与规则。</p>}
        </section>;})}
      </details>}
    </div>
    <div className="modal-actions"><button onClick={close}>暂不添加，保持现有题目</button><button className="primary" disabled={!canAdd&&!selected.size} onClick={onApply}>{action}</button></div><p className="subtle">暂不添加时，已上传的 PDF 文件仍然保留。</p>
  </Modal>;
}
