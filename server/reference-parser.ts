import {blankQuestion,questionKey,type Question,type QuestionChild} from '../shared/domain.js';
import {courseQuestion,parseCourseMaterials} from '../shared/course.js';
import {childrenOf,withChildren} from '../shared/questions.js';
import {questionHeading,supplementNotes,sectionHeading,questionGroup,allQuestionsGraded,materialSection,type ReferenceLayout,type ReferencePage,type ReferenceSpan,type ReferenceSource} from '../shared/reference.js';

type Material={id:string;name?:string;text:string;referenceLayout?:ReferenceLayout};
export type ParseStrategy='auto'|'black-red'|'text';
function lines(page:ReferencePage){
  const rows:{y:number;spans:ReferenceSpan[]}[]=[];
  for(const span of page.spans){
    if(!span.text.trim())continue;
    const row=rows.find(r=>Math.abs(r.y-span.y)<Math.max(.003,span.height*.6));
    if(row)row.spans.push(span);else rows.push({y:span.y,spans:[span]});
  }
  return rows.sort((a,b)=>a.y-b.y).map(r=>({...r,spans:r.spans.sort((a,b)=>a.x-b.x)}));
}
const joined=(spans:ReferenceSpan[])=>spans.map((s,i)=>(i&&s.x-(spans[i-1].x+spans[i-1].width)>.003?' ':'')+s.text).join('').trim();
const append=(a:string|undefined,b:string)=>[a,b].filter(Boolean).join('\n');
function source(q:Question|QuestionChild,fileId:string,page:number,graphic=false){
  const sources=q.referenceSources??=[];const old=sources.find(s=>s.fileId===fileId&&s.page===page);
  if(old)old.graphic ||= graphic;else sources.push({fileId,page,graphic});
}

/** Color is opt-in per import, or auto-detected only when both black and red exist. */
export function parseReferenceMaterials(materials:Material[],scope:string,strategy:ParseStrategy='auto'){
  const questions:Question[]=[],warnings:string[]=[];
  for(const file of materials){
    const layout=file.referenceLayout;
    const spans=layout?.pages.flatMap(p=>p.spans)??[];
    const colored=strategy!=='text'&&spans.some(s=>s.color==='red')&&spans.some(s=>s.color==='black');
    if(!colored){
      const inferred=materialSection(file);const fallback=parseCourseMaterials([inferred&&!sectionHeading(file.text)?'章节 '+inferred+'\n'+file.text:file.text],'').map(q=>({...q,parseMethod:'text' as const,parseWarning:'这些内容按文字整理，题干、小问和参考答案需要你对照原页检查。'}));
      for(const q of fallback)if(layout)q.referenceSources=layout.pages.map(p=>({fileId:file.id,page:p.page,graphic:p.graphics.length>0}));
      if(!fallback.length)warnings.push((file.name??'参考材料')+'：'+(!file.text.trim()?'未取得文字，请手动添加题目或选择页面辅助整理。':!inferred?'未找到章节标题，请在补充文字中填写章节和题号，或手动添加题目并指定小节。':'已找到章节，但未找到题号，请手动补充清单；已上传文件保留，可重新整理。'));
      questions.push(...fallback);warnings.push((file.name??'参考材料')+(strategy==='text'?'：已按你的选择只整理文字，请对照 PDF 核对题干与答案。':'：未找到能可靠区分题干和答案的颜色，已只按文字整理，请检查题目内容。'));
      if(layout)for(const page of layout.pages)if(page.graphics.length)warnings.push((file.name??'参考材料')+' 第 '+page.page+' 页有图形但未可靠关联，请人工检查或使用页面辅助整理。');
      continue;
    }
    warnings.push(...layout!.warnings);
    if(strategy==='auto')warnings.push((file.name??'参考材料')+'：已按黑色题干、红色答案整理。请确认材料确实采用这种颜色，并检查分离结果。');
    let section=materialSection(file)??'',group:Question['group'];const allGraded=allQuestionsGraded(file.text);let current:Question|undefined,child:QuestionChild|undefined;
    const flush=()=>{if(current){current.kind=/判断|对错|正误/.test(current.prompt)?'true_false':'solution';questions.push(courseQuestion(current));}current=undefined;child=undefined;};
    for(const page of layout!.pages){
      const pageRows=lines(page);const boundaries:{y:number;q:Question}[]=[];
      if(current)boundaries.push({y:0,q:current});
      for(const row of pageRows){
        const text=joined(row.spans),black=joined(row.spans.filter(s=>s.color==='black'));
        const heading=sectionHeading(text),nextGroup=questionGroup(text);
        if(heading){if(heading!==section){flush();section=heading;group=undefined;}continue;}
        if(nextGroup){if(nextGroup!==group)flush();group=nextGroup;continue;}
        if(/^(?:注[：:]|.*参考答案$)/.test(text))continue;
        const only=text.match(/题目\s*([\d,，、\s]+)/);
        if(only&&section){flush();for(const number of only[1].match(/\d+/g)??[])questions.push(courseQuestion({...blankQuestion(),section,number,parseMethod:'color'}));continue;}
        if(!section)continue;
        const numbered=questionHeading(black);
        if(numbered){flush();current=withChildren({...blankQuestion(),section,...(group?{group}:{}),...(allGraded?{allGraded:true}:{}),number:numbered.number,prompt:numbered.text,answer:joined(row.spans.filter(s=>s.color==='red')),notes:supplementNotes(numbered.number),parseMethod:'color'},[]);source(current,file.id,page.page);boundaries.push({y:row.y,q:current});continue;}
        if(!current)continue;
        if(/^[\p{Script=Han}]{2,12}[.．:：]/u.test(black)&&!/[，。]/.test(black)&&black.length<22){current.parseWarning='发现可能的独立标题，请人工核对题目边界。';warnings.push(questionKey(current)+'：'+current.parseWarning);}
        const label=black.match(/^([a-z])\s*[.．、)）]\s*(.*)$/i);
        if(label&&label[1].toLowerCase()===String.fromCharCode(97+childrenOf(current).length)){
          child={id:questionKey(current)+':candidate:'+label[1].toLowerCase(),label:label[1].toLowerCase(),prompt:label[2],answer:joined(row.spans.filter(s=>s.color==='red')),confirmed:false};
          current.children!.push(child);current.subparts!.push(child.label);source(child,file.id,page.page);source(current,file.id,page.page);continue;
        }
        const target=child??current;source(target,file.id,page.page);source(current,file.id,page.page);
        const red=joined(row.spans.filter(s=>s.color==='red')),unclear=joined(row.spans.filter(s=>s.color==='other'||s.color==='unknown'));
        if(black.length<30&&/^(?:补充|附加|拓展|延伸|额外|思考|另[一二三四五六七八九十\d]*题)/.test(black)&&target.answer?.trim()&&!red){
          target.parseWarning='参考解后出现未标号的黑色片段，可能是新题边界或颜色混用；请对照原页人工归类。';
          if(child)child.sourceText=append(child.sourceText,black);else current.referenceExcerpt=append(current.referenceExcerpt,black);
          warnings.push(questionKey(current)+'：'+target.parseWarning);
        }else if(black)target.prompt=append(target.prompt,black);
        if(red)target.answer=append(target.answer,red);
        if(unclear){if(child)child.sourceText=append(child.sourceText,text);else current.referenceExcerpt=append(current.referenceExcerpt,text);target.parseWarning='颜色不明确的片段未自动归类，请对照原页手工补录。';warnings.push(questionKey(current)+'：'+target.parseWarning);}
      }
      for(const [index,boundary] of boundaries.entries()){
        const bottom=boundaries[index+1]?.y??1;
        const graphic=page.graphics.some(g=>g.y+g.height>boundary.y&&g.y<bottom)||/下图|如图|见图|图示|示意图/.test(boundary.q.prompt)&&boundary.q.referenceSources?.some(s=>s.page===page.page&&s.fileId===file.id);
        if(graphic)source(boundary.q,file.id,page.page,true);
      }
      if(page.graphics.length&&!boundaries.length)warnings.push((file.name??'参考材料')+' 第 '+page.page+' 页的图形尚未关联到题目，请人工核对。');
    }
    flush();
    if(!questions.some(q=>q.referenceSources?.some(s=>s.fileId===file.id)))warnings.push((file.name??'参考材料')+'：未找到可用的章节或题号，请手动添加题目并填写小节；文件保留，可重新整理。');
  }
  const unique=new Map<string,Question>();
  for(const q of questions){const key=questionKey(q);if(!unique.has(key))unique.set(key,q);else warnings.push(key+'：重复来源仅保留首份候选，请核对。');}
  return {questions:[...unique.values()],warnings:[...new Set(warnings)]};
}

export function referenceSourcesFor(q:Question):ReferenceSource[]{
  const all=[...(q.referenceSources??[]),...childrenOf(q).flatMap(c=>c.referenceSources??[])];
  return all.filter((s,i)=>all.findIndex(p=>p.fileId===s.fileId&&p.page===s.page)===i).map(s=>({...s,graphic:all.some(p=>p.fileId===s.fileId&&p.page===s.page&&p.graphic)}));
}
