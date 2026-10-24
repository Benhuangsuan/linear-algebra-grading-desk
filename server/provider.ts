import { judgmentSchema, questionKey, validateRows, type Assignment, type Grade, type Judgment, type StoredFile } from '../shared/domain.js';
import { suggestedDeduction } from '../shared/course.js';

export interface GradingProvider { readonly name:string; grade(assignment:Assignment,file:StoredFile):Promise<Grade> }
export function manualGrade(a:Assignment):Grade {
  return {provider:'manual',model:'human',at:new Date().toISOString(),version:a.version,config:structuredClone(a.config),raw:null,
    rows:a.config.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'uncertain',verdict:'uncertain',deduction:null,reason:'待人工查看 PDF 并录入。',pages:[],needsReview:true,reviewed:false}))};
}
export class MockProvider implements GradingProvider {
  readonly name='mock';
  async grade(a:Assignment,file:StoredFile):Promise<Grade> {
    // Mock deliberately never interprets file contents, names, text, or historical red-pen marks.
    await new Promise(resolve=>setTimeout(resolve,250));
    const rows:Judgment[]=a.config.questions.map((q,i)=>{
      const course=a.config.policy==='linear-algebra-1.1';
      const uncertain=q.disputed || (!course&&(i%5===4 || (q.type==='graded' && (!q.prompt.trim() || !q.answer.trim() || q.errorPenalty===null))));
      const missing=!uncertain && i%7===3;
      const recognition=uncertain?'uncertain':missing?(course?'not_found':'missing'):'found';
      const partial=!uncertain && !missing && q.type==='graded' && i%3===1;
      const verdict=uncertain?'uncertain':missing?'missing':q.type==='completion_only'?'completed':partial?'partial':'correct';
      const deduction=suggestedDeduction(a.config,q,recognition,verdict);
      return {key:questionKey(q),type:q.type,recognition,verdict,deduction,errorCount:partial?1:undefined,
        reason:uncertain?'识别不清，需核对。':missing?'未检索到作答，暂按漏做处理。':partial?'此处存在一处错误。':'',
        pages:missing?[]:[i%(file.pages??1)+1],needsReview:true,reviewed:false};
    });
    const parsed=judgmentSchema.array().parse(rows);
    const errors=validateRows(a.config,parsed,file.pages??1);
    if(errors.length) throw new Error(errors.join('；'));
    return {provider:'mock',model:'offline-demo-v1',at:new Date().toISOString(),version:a.version,config:structuredClone(a.config),rows:parsed,raw:{demo:true,rows:parsed,usage:{requests:0,cost:0}}};
  }
}
