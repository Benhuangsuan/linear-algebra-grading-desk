import { questionKey, summarize, type Submission } from '../shared/domain.js';

export function gradeCell(submission:Submission):string {
  if(submission.status!=='confirmed'||!submission.grade)return '待确认';
  const {config}=submission.grade;
  const rows=submission.review??submission.grade.rows;
  const score=summarize(config,rows).score;
  if(score===null)return '待确认';
  const missing=new Set<string>();
  for(const q of config.questions) {
    if(!q.required)continue;
    const row=rows.find(r=>r.key===questionKey(q));
    if(row&&(row.recognition==='missing'||row.recognition==='not_found'))missing.add(q.section+' / '+q.number);
  }
  return score+'分'+(missing.size?'，漏'+missing.size+'题':'');
}

export function gradesCsv(submissions:Submission[]):string {
  // Quote both columns and retain spreadsheet-formula protection and an Excel-friendly UTF-8 BOM.
  const escape=(value:string)=>'"'+value.replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
  const data=[['姓名','成绩'],...submissions.map(s=>[s.studentName,gradeCell(s)])];
  return '\uFEFF'+data.map(row=>row.map(escape).join(',')).join('\r\n');
}
