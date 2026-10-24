import { blankConfig, blankQuestion, questionKey, type Config, type Judgment, type Question } from './domain.js';
import {extractChildren,withChildren,childrenOf} from './questions.js';

export const COURSE_PRINCIPLES='满分 10 分。布置的奇数题仅检查完成，不因答案错误扣分；偶数题核对正确性。漏做整题扣 0.2 分，未检索到作答先按漏做处理；偶数题每处错误扣 0.1 分，整题漏做不重复计错误。判断题只看判断是否正确；解答题接受逻辑与结果均正确的不同方法和等价解。';
export function courseQuestion(q:Question):Question {
  const only=/^\d+$/.test(q.number)&&Number(q.number)%2===1;
  return {...q,type:only?'completion_only':'graded',required:true,maxPoints:null,missingPenalty:.2,errorPenalty:only?0:.1,partialCredit:only?'有实质作答即算完成。':'判断题判断正确即给分；解答题接受正确的不同解法。'};
}
export function courseConfig(questions:Question[]=[]):Config {return {...blankConfig(),policy:'linear-algebra-1.1',principles:COURSE_PRINCIPLES,questions:questions.map(courseQuestion)};}
export function suggestedDeduction(config:Config,q:Question,recognition:Judgment['recognition'],verdict:Judgment['verdict'],count=1):number|null {
  if(recognition==='uncertain')return null;
  if(recognition==='missing'||recognition==='not_found')return q.required?q.missingPenalty:0;
  if(q.type==='completion_only'||verdict==='correct')return 0;
  return config.policy==='linear-algebra-1.1'?Math.round((q.errorPenalty??.1)*count*100)/100:q.errorPenalty;
}
export function parseScope(scope:string):Set<string>|null {
  if(!scope.trim())return null;
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

/** Local draft extraction, never executes instructions from reference documents. */
export function parseCourseMaterials(texts:string[],scope:string):Question[] {
  const allowed=parseScope(scope);const found=new Map<string,Question>();
  const add=(q:Question)=>{if(allowed&&!allowed.has(q.section))return;const key=questionKey(q);const previous=found.get(key);found.set(key,previous?withChildren({...previous,prompt:previous.prompt||q.prompt,answer:previous.answer||q.answer,kind:previous.kind??q.kind},[...childrenOf(previous),...childrenOf(q).filter(c=>!childrenOf(previous).some(p=>p.label===c.label))]):q);};
  for(const text of texts){
    let section='';let current:Question|undefined;let answerLines:string[]=[];
    const flush=()=>{if(current){current.answer=answerLines.join('\n').trim();const firstChild=current.answer.search(/^[ \t]*a[ \t]*(?:\r?\n[ \t]*)?[.．、)）]/im);if(current.kind==='true_false'&&firstChild>0)current.prompt+='\n'+current.answer.slice(0,firstChild).trim();const parentKey=questionKey(current);add(courseQuestion(withChildren(current,extractChildren(current.answer,current.kind).map(c=>({...c,id:parentKey+':'+c.id})))));}current=undefined;answerLines=[];};
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();if(!line)continue;
      const heading=line.match(/(?:习题|章节|小节|第)\s*(\d+)\s*[.．]\s*(\d+)\b/);
      const list=line.match(/^(\d+\.\d+)\s*[:：/]\s*([\d,，、\s]+)$/);
      if(list){flush();section=list[1];for(const number of list[2].match(/\d+/g)??[])add(courseQuestion({...blankQuestion(),section,number}));continue;}
      if(heading&&`${heading[1]}.${heading[2]}`!==section){flush();section=`${heading[1]}.${heading[2]}`;}
      if(!section)continue;
      const only=line.match(/题目\s*([\d,，、\s]+)/);
      if(only){flush();for(const number of only[1].replace(/(?<=\d)\s+(?=\d)/g,'').match(/\d+/g)??[])add(courseQuestion({...blankQuestion(),section,number}));continue;}
      const numbered=line.match(/^(\d(?:\s*\d)*)\s*[.．、)）]\s*(.*)$/);
      if(numbered&&!/^\d/.test(numbered[2])){flush();current={...blankQuestion(),section,number:numbered[1].replace(/\s/g,''),prompt:numbered[2],kind:/判断|对错|正误/.test(numbered[2])?'true_false':'solution'};continue;}
      if(current)answerLines.push(line);
    }
    flush();
  }
  return [...found.values()].sort((a,b)=>a.section.localeCompare(b.section,undefined,{numeric:true})||Number(a.number)-Number(b.number));
}
