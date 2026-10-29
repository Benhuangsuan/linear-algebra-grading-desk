import {DEFAULT_COURSE_PRINCIPLES,ALL_GRADED_PRINCIPLES} from './reference.js';
import {questionKey,type Question,type QuestionChild,type Config} from './domain.js';

/** Legacy string lists remain readable; IDs survive label changes and reordering. */
export function childrenOf(q:Question):QuestionChild[]{
  return q.children??(q.subparts??[]).map(label=>({id:'legacy:'+questionKey(q)+':'+label,label,confirmed:true}));
}
export function withChildren(q:Question,children:QuestionChild[]):Question {
  return {...q,children,subparts:children.map(c=>c.label)};
}
export function splitUnits(q:Question){return q.type==='graded'&&!q.part&&(q.kind==='true_false'||q.unitMode==='independent');}

/** Locally extracted candidates, never authoritative teacher configuration. */
export function extractChildren(text:string,kind:Question['kind']='solution'):QuestionChild[]{
  const normalized=text.replace(/^([ \t]*[a-z])[ \t]*\r?\n[ \t]*([.．、)）])/gim,'$1$2');
  const matches=[...normalized.matchAll(/^[ \t]*([a-z])[ \t]*[.．、)）][ \t]*(?=\S|$)/gim)];
  // A sequence beginning with a avoids treating isolated mathematical variables as labels.
  const sequence:typeof matches=[];
  for(const match of matches){if(match[1].toLowerCase()===String.fromCharCode(97+sequence.length))sequence.push(match);}
  if(sequence.length<2)return [];
  return sequence.map((m,i)=>{
    const sourceText=normalized.slice(m.index!+m[0].length,sequence[i+1]?.index??normalized.length).trim();
    const child:QuestionChild={id:'candidate:'+m[1].toLowerCase(),label:m[1].toLowerCase(),confirmed:false};
    if(kind!=='true_false')return {...child,answer:sourceText};
    const lines=sourceText.split('\n').map(l=>l.trim()).filter(Boolean);
    const boundary=lines.map((line,index)=>index>0&&/^(?:(?:参考(?:答案|解)|答案|解答|判断)\s*[:：]\s*)?(?:对|错|正确|错误|是|否|True|False|T|F|[√×✓✗])(?:[，,。.:：、]|$)/i.test(line)?index:-1).filter(i=>i>=0);
    if(boundary.length===1){const at=boundary[0];return {...child,prompt:lines.slice(0,at).join('\n'),answer:lines.slice(at).join('\n'),sourceText};}
    return {...child,prompt:'',answer:'',sourceText,parseWarning:'未能可靠分离命题与参考判断，请对照原始片段和 PDF 手工编辑、核对。'};
  });
}
export function childContentKey(q:Question,label:string){return JSON.stringify([questionKey(q),label]);}
export function parentContentKey(q:Question){return JSON.stringify([questionKey(q),'parent-content']);}
export function questionContentChanged(a:Question,b:Question){return a.prompt!==b.prompt||a.answer!==b.answer||JSON.stringify(a.referenceSources??[])!==JSON.stringify(b.referenceSources??[]);}
export function questionImportSummary(previous:Config,candidate:Config){
  const old=new Map(previous.questions.map(q=>[questionKey(q),q]));
  const added=candidate.questions.filter(q=>!old.has(questionKey(q)));
  const existing=candidate.questions.filter(q=>old.has(questionKey(q)));
  const newChildren=existing.flatMap(q=>childrenOf(q).filter(c=>!childrenOf(old.get(questionKey(q))!).some(p=>p.label===c.label)).map(c=>({parent:questionKey(q),label:c.label})));
  return {current:previous.questions.length,found:candidate.questions.length,added,existing,newChildren};
}

/** Explicit additive reconciliation; teacher edits and manually added questions win. */
export function reconcileQuestions(previous:Config,candidate:Config,replaceContent:ReadonlySet<string>=new Set()):Config {
  const remaining=new Map(candidate.questions.map(q=>[questionKey(q),q]));
  const questions=previous.questions.map(old=>{
    const parsed=remaining.get(questionKey(old));remaining.delete(questionKey(old));
    if(!parsed)return old;
    const parent=replaceContent.has(parentContentKey(old))?{...old,prompt:parsed.prompt,answer:parsed.answer,referenceSources:parsed.referenceSources,parseMethod:parsed.parseMethod,parseWarning:parsed.parseWarning,referenceExcerpt:parsed.referenceExcerpt}:old;
    const children=childrenOf(old).map(child=>{
      const next=childrenOf(parsed).find(c=>c.label===child.label);
      return next&&replaceContent.has(childContentKey(old,child.label))?{...child,prompt:next.prompt??'',answer:next.answer??'',sourceText:next.sourceText,parseWarning:next.parseWarning,referenceSources:next.referenceSources,confirmed:false}:child;
    });const labels=new Set(children.map(c=>c.label));
    return withChildren(parent,[...children,...childrenOf(parsed).filter(c=>!labels.has(c.label))]);
  });
  const merged=[...questions,...remaining.values()];
  return {...previous,principles:merged.some(q=>q.allGraded)&&previous.principles===DEFAULT_COURSE_PRINCIPLES?ALL_GRADED_PRINCIPLES:previous.principles,questions:merged,confirmed:false};
}
