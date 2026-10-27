import { questionKey, summarize, deductionRows, type Submission } from '../shared/domain.js';

export function gradeCell(submission:Submission):string {
  if(submission.status!=='confirmed'||!submission.grade)return '待确认';
  const {config}=submission.grade;
  const rows=submission.review??submission.grade.rows;
  const score=summarize(config,rows).score;
  if(score===null)return '待确认';
  const missing=new Set<string>();
  for(const row of deductionRows(config,rows)) {
    const questions=config.questions.filter(q=>questionKey(q)===row.key||(config.policy==='linear-algebra-1.1'&&q.section+' / '+q.number===row.key));
    if(questions.some(q=>q.required)&&row.verdict==='missing'&&(row.deduction??0)>0&&(row.recognition==='missing'||row.recognition==='not_found'))missing.add(row.key);
  }
  return score+(missing.size?'，漏'+missing.size+'题':'');
}

export function gradesCsv(submissions:Submission[]):string {
  // Quote both columns and retain spreadsheet-formula protection and an Excel-friendly UTF-8 BOM.
  const escape=(value:string)=>'"'+value.replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
  const data=[['姓名','成绩'],...submissions.map(s=>[s.studentName,gradeCell(s)])];
  return '\uFEFF'+data.map(row=>row.map(escape).join(',')).join('\r\n');
}
