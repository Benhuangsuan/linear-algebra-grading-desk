import { blankConfig, blankQuestion, questionKey, type Config, type Judgment, type Question } from './domain.js';
import {extractChildren,withChildren,childrenOf} from './questions.js';
import {questionHeading,supplementNotes,sectionHeading,questionGroup,allQuestionsGraded,DEFAULT_COURSE_PRINCIPLES as COURSE_PRINCIPLES,ALL_GRADED_PRINCIPLES} from './reference.js';

export {DEFAULT_COURSE_PRINCIPLES as COURSE_PRINCIPLES} from './reference.js';
export function courseQuestion(q:Question):Question {
  const only=q.classificationEvidence?q.type==='completion_only':!q.allGraded&&/^\d+$/.test(q.number)&&Number(q.number)%2===1;
  return {...q,type:only?'completion_only':'graded',required:true,maxPoints:null,missingPenalty:.2,errorPenalty:only?0:.1,partialCredit:only?'有实质作答即算完成。':'判断题判断正确即给分；解答题接受正确的不同解法。'};
}
export function courseConfig(questions:Question[]=[]):Config {return {...blankConfig(),policy:'linear-algebra-1.1',principles:questions.some(q=>q.allGraded)?ALL_GRADED_PRINCIPLES:COURSE_PRINCIPLES,questions:questions.map(courseQuestion)};}
export function materialQuestion(q:Question,text:string):Question {
  const all=allQuestionsGraded(text),mixed=/奇数题[^。\n]*(?:完成)[^。\n]*偶数题[^。\n]*批改/.test(text);
  const evidence=all?'原文要求所有题目均需批改':mixed&&!q.group&&/^\d+$/.test(q.number)?'原文要求奇数题仅检查完成、偶数题批改':q.notes.includes('材料仅列出了题号')?'原文仅完成题号列表，无参考解':'';
  if(!evidence){const hasAnswer=!!q.answer.trim()||!!q.children?.some(c=>c.answer?.trim());if(hasAnswer&&(q.parseMethod==='color'||/偶数题答案|参考解|参考答案/.test(text)))return courseQuestion({...q,type:'graded',classificationEvidence:'原材料提供本题参考解，用于核对正确性',typeConfirmed:true});return {...q,typeConfirmed:false,parseWarning:'检查方式没有可靠依据，请在调整题目中核对并确认。'};}
  const type=all?'graded':mixed&&/^\d+$/.test(q.number)?Number(q.number)%2?'completion_only':'graded':'completion_only';
  return courseQuestion({...q,type,classificationEvidence:evidence,typeConfirmed:true});
}
export function suggestedDeduction(config:Config,q:Question,recognition:Judgment['recognition'],verdict:Judgment['verdict'],count=1):number|null {
  if(recognition==='uncertain')return null;
  if(recognition==='missing'||recognition==='not_found')return q.required?q.missingPenalty:0;
  if(q.type==='completion_only'||verdict==='correct')return 0;
  return config.policy==='linear-algebra-1.1'?Math.round((q.errorPenalty??.1)*count*100)/100:q.errorPenalty;
}
export function parseScope(scope:string):Set<string>|null {
  if(!scope.trim())return null;
  if(!/^[\d.\s,，、;；—–~～至-]+$/.test(scope))return null;
  const sections=new Set<string>();
  const normalized=scope.replace(/[—–~～至]/g,'-').replace(/\s*-\s*/g,'-');
  for(const token of normalized.split(/[,，、;；\s]+/).filter(Boolean)) {
    const range=token.match(/^(\d+)\.(\d+)\s*-\s*(?:(\d+)\.)?(\d+)$/);
    if(range){const chapter=Number(range[1]);const start=Number(range[2]);const end=Number(range[4]);if((range[3]&&Number(range[3])!==chapter)||end<start||end-start>100)throw new Error(`不支持的范围：${token}，请按小节填写`);for(let n=start;n<=end;n++)sections.add(`${chapter}.${n}`);continue;}
    if(/^\d+\.\d+$/.test(token)){sections.add(token);continue;}
    throw new Error(`范围格式不正确：${token}，例如 1.1-1.3 或 2.2-2.4,2.8`);
  }
  return sections;
}

export function scopeSections(scope:string){try{return parseScope(scope);}catch{return null;}}

/** Local draft extraction, never executes instructions from reference documents. */
export function parseCourseMaterials(texts:string[],scope:string):Question[] {
  const allowed=scopeSections(scope);const found=new Map<string,Question>();
  const add=(q:Question)=>{if(allowed&&!allowed.has(q.section))return;const key=questionKey(q);const previous=found.get(key);found.set(key,previous?withChildren({...previous,prompt:previous.prompt||q.prompt,answer:previous.answer||q.answer,kind:previous.kind??q.kind},[...childrenOf(previous),...childrenOf(q).filter(c=>!childrenOf(previous).some(p=>p.label===c.label))]):q);};
  for(const text of texts){
    let section='';let group:Question['group'];const allGraded=allQuestionsGraded(text);let current:Question|undefined;let answerLines:string[]=[];
    const flush=()=>{if(current){current.answer=answerLines.join('\n').trim();const firstChild=current.answer.search(/^[ \t]*a[ \t]*(?:\r?\n[ \t]*)?[.．、)）]/im);if(current.kind==='true_false'&&firstChild>0)current.prompt+='\n'+current.answer.slice(0,firstChild).trim();const parentKey=questionKey(current);add(courseQuestion(withChildren(current,extractChildren(current.answer,current.kind).map(c=>({...c,id:parentKey+':'+c.id})))));}current=undefined;answerLines=[];};
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();if(!line)continue;
      const heading=sectionHeading(line);const nextGroup=questionGroup(line);if(nextGroup){if(nextGroup!==group)flush();group=nextGroup;continue;}if(/^(?:注[：:]|.*参考答案$)/.test(line)&&!heading)continue;
      const list=line.match(/^(\d+\.\d+)\s*[:：/]\s*([\d,，、\s]+)$/);
      if(list){flush();section=list[1];for(const number of list[2].match(/\d+/g)??[])add(courseQuestion({...blankQuestion(),section,number}));continue;}
      if(heading&&heading!==section){flush();section=heading;group=undefined;}
      if(!section)continue;
      const only=line.match(/题目\s*([\d,，、\s]+)/);
      if(only){flush();for(const number of only[1].replace(/(?<=\d)\s+(?=\d)/g,'').match(/\d+/g)??[])add(courseQuestion({...blankQuestion(),section,number,notes:'材料仅列出了题号，无参考解。'}));continue;}
      if(heading)continue;
      const numbered=questionHeading(line);
      if(numbered&&!(numbered.text===''&&/[)）]$/.test(line))){flush();current={...blankQuestion(),section,...(group?{group}:{}),...(allGraded?{allGraded:true}:{}),number:numbered.number,prompt:numbered.text,notes:supplementNotes(numbered.number),kind:/判断|对错|正误/.test(numbered.text)?'true_false':'solution'};continue;}
      if(current)answerLines.push(line);
    }
    flush();
  }
  return [...found.values()];
}
