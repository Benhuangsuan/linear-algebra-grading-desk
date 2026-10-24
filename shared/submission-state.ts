import {validateRows,type Submission} from './domain.js';

/** Derived from saved results, never from a displayed score or provider badge. */
export function hasFormalResult(s:Submission):boolean {
  if(s.status==='confirmed')return true; // Preserve legacy teacher confirmations, including reviewed Mock.
  const grade=s.grade;if(!grade||!grade.config.questions.length)return false;
  if(grade.provider==='deepseek'||grade.provider==='qwen')
    return grade.rows.length>0&&validateRows(grade.config,grade.rows,Number.MAX_SAFE_INTEGER).length===0;
  // A manual placeholder or untouched demo is not a completed human assessment.
  const rows=s.review??grade.rows;
  return rows.length>0&&validateRows(grade.config,rows,Number.MAX_SAFE_INTEGER,true).length===0;
}
export function isUngraded(s:Submission):boolean {
  return !['queued','processing','confirmed'].includes(s.status)&&!hasFormalResult(s);
}
export function aiSelectionReason(s:Submission|undefined,regrade=false):string {
  if(!s)return '提交已删除';
  if(s.status==='confirmed')return '成绩已确认，需先重开审核';
  if(s.status==='queued')return '已进入队列';
  if(s.status==='processing')return '正在批改';
  if(!regrade&&hasFormalResult(s))return '已有正式批改结果，需要重批请使用「重新 AI 批改」';
  return '';
}
export type RemovedSelection={id:string;name:string;reason:string};
export function reconcileSelection(ids:Iterable<string>,submissions:Submission[]){
  const byId=new Map(submissions.map(s=>[s.id,s]));const valid:string[]=[];const removed:RemovedSelection[]=[];
  for(const id of new Set(ids)){
    const s=byId.get(id);const reason=aiSelectionReason(s);
    if(reason)removed.push({id,name:s?.studentName||'已删除的提交',reason});else valid.push(id);
  }
  return {valid,removed};
}
