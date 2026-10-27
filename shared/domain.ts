import { z } from 'zod';
import {referenceSourceSchema,type ReferenceLayout} from './reference.js';

const score = z.number().finite().min(0).max(10000);
export const childSchema = z.object({
  id:z.string().min(1).max(150), label:z.string().trim().min(1).max(30),
  prompt:z.string().max(20000).optional(), answer:z.string().max(20000).optional(),
  sourceText:z.string().max(20000).optional(), parseWarning:z.string().max(1000).optional(),
  confirmed:z.boolean().optional(), missingPenalty:score.optional(), errorPenalty:score.optional(),
  referenceSources:z.array(referenceSourceSchema).max(100).optional(),
});
export type QuestionChild = z.infer<typeof childSchema>;
export const questionSchema = z.object({
  section: z.string().trim().min(1).max(50), number: z.string().trim().min(1).max(50),
  part: z.string().trim().max(30).default(''),
  type: z.enum(['completion_only', 'graded']), required: z.boolean(),
  maxPoints: score.nullable(), missingPenalty: score.nullable(), errorPenalty: score.nullable(),
  partialCredit: z.string().max(4000), notes: z.string().max(4000),
  prompt: z.string().max(20000), answer: z.string().max(20000), disputed: z.boolean(),
  kind: z.enum(['true_false','solution']).optional(),
  subparts: z.array(z.string().trim().min(1).max(30)).max(100).optional(),
  children: z.array(childSchema).max(100).optional(),
  parentKey:z.string().max(200).optional(), childId:z.string().max(150).optional(),
  referenceExcerpt:z.string().max(20000).optional(),
  unitMode: z.enum(['whole','independent']).optional(),
  referenceSources:z.array(referenceSourceSchema).max(100).optional(),
  parseWarning:z.string().max(1000).optional(),parseMethod:z.enum(['text','color','ai']).optional(),
});
export type Question = z.infer<typeof questionSchema>;
export const configSchema = z.object({
  total: z.number().finite().positive().max(10000), mode: z.enum(['deduction', 'points']),
  principles: z.string().max(20000), questions: z.array(questionSchema).max(300),
  confirmed: z.boolean(),
  policy: z.enum(['linear-algebra-1.1','linear-algebra-2']).optional(),
  sourceText: z.string().max(100000).optional(),
}).superRefine((c, ctx) => {
  if(c.policy==='linear-algebra-1.1'&&(c.total!==10||c.mode!=='deduction'))ctx.addIssue({code:'custom',message:'本课程采用 10 分制扣分规则'});
  const keys = new Set<string>();
  for (const q of c.questions) {
    const key = questionKey(q);
    if (keys.has(key)) ctx.addIssue({ code: 'custom', message: `题目标识重复：${key}` });
    keys.add(key);
    const labels=q.children?.map(c=>c.label)??q.subparts??[];
    if(new Set(labels).size!==labels.length || q.children&&new Set(q.children.map(c=>c.id)).size!==q.children.length)
      ctx.addIssue({code:'custom',message:`${key} 的小问编号或标识重复`});
    if(q.children && JSON.stringify(labels)!==JSON.stringify(q.subparts??labels))
      ctx.addIssue({code:'custom',message:`${key} 的小问列表不一致`});
    for(const child of q.children??[])for(const n of [child.missingPenalty,child.errorPenalty])if(n!==undefined&&n>c.total)
      ctx.addIssue({code:'custom',message:`${key} / ${child.label} 的扣分超过总分`});
    for (const n of [q.maxPoints, q.missingPenalty, q.errorPenalty]) {
      if (n !== null && n > c.total) ctx.addIssue({ code: 'custom', message: `${key} 的分值不能超过作业总分` });
    }
    if (q.type === 'completion_only' && q.errorPenalty !== null && q.errorPenalty !== 0)
      ctx.addIssue({ code: 'custom', message: `${key} 仅检查完成，不可设置正确性扣分` });
    if (c.mode === 'points' && q.maxPoints !== null && [q.missingPenalty, q.errorPenalty].some(n => n !== null && n > q.maxPoints!))
      ctx.addIssue({ code: 'custom', message: `${key} 扣分超过该题满分` });
  }
  for (const q of c.questions) {
    if (!q.part && c.questions.some(other => other.section === q.section && other.number === q.number && other.part))
      ctx.addIssue({ code: 'custom', message: `${questionKey(q)} 不可同时配置整题与其小问，避免重复计分` });
  }
  if (c.mode === 'points' && c.questions.every(q => q.maxPoints !== null) && Math.abs(c.questions.reduce((s,q) => s + (q.maxPoints ?? 0),0) - c.total) > .00001)
    ctx.addIssue({ code: 'custom', message: '逐题满分之和必须等于作业总分' });
});
export type Config = z.infer<typeof configSchema>;
export const judgmentSchema = z.object({
  key: z.string(), type: z.enum(['completion_only','graded']),
  recognition: z.enum(['found','missing','not_found','uncertain']),
  verdict: z.enum(['completed','correct','partial','incorrect','missing','uncertain']),
  deduction: score.nullable(), reason: z.string().max(10000),
  pages: z.array(z.number().int().positive()).max(100), needsReview: z.boolean(), reviewed: z.boolean(),
  errorCount: z.number().int().min(1).max(100).optional(),
  reviewReason: z.string().max(1000).optional(),
});
export type Judgment = z.infer<typeof judgmentSchema>;
export type Grade = { provider: 'mock' | 'manual' | 'deepseek' | 'qwen'; model: string; at: string; version: number; config: Config; rows: Judgment[]; raw: unknown };
export type Course = { id: string; name: string; createdAt: string };
export type Assignment = { id: string; courseId: string; title: string; description: string; scope: string; archived: boolean; version: number; config: Config; createdAt: string };
export type StoredFile = { id: string; assignmentId: string; kind: 'student'|'reference'|'prompt'; name: string; diskName: string; mime: string; size: number; pages: number | null; createdAt: string; text: string; warning: string; referenceLayout?:ReferenceLayout };
export type Submission = {
  id: string; assignmentId: string; fileId: string; studentName: string; studentId: string;
  status: 'uploaded'|'queued'|'processing'|'review'|'confirmed'|'failed';
  grade: Grade | null; review: Judgment[] | null; manualReport: string; reportBase: string;
  error: string; revision: number; updatedAt: string;
};
export type History = { id: string; submissionId: string; action: string; at: string; snapshot: Submission };
export type State = { courses: Course[]; assignments: Assignment[]; files: StoredFile[]; submissions: Submission[]; provider: string; mockEnabled?:boolean };
export function questionKey(q: Pick<Question,'section'|'number'|'part'>) { return `${q.section} / ${q.number}${q.part ? ` / ${q.part}` : ''}`; }
export function blankQuestion(): Question { return { section:'1.1',number:'',part:'',type:'graded',required:true,maxPoints:null,missingPenalty:null,errorPenalty:null,partialCredit:'',notes:'',prompt:'',answer:'',disputed:false }; }
export function blankConfig(): Config { return { total:10,mode:'deduction',principles:'',questions:[],confirmed:false }; }
export function configurationWarnings(c: Config): string[] {
  const warnings:string[]=[];
  if (!c.confirmed) warnings.push('题目清单尚未人工确认');
  if (!c.questions.length) warnings.push('请补录题目清单');
  for (const q of c.questions) {
    const key=questionKey(q);
    if (q.required && q.missingPenalty === null) warnings.push(`${key}：未设置漏做扣分（可显式填写 0）`);
    if (q.type === 'graded' && q.errorPenalty === null) warnings.push(`${key}：未设置错误扣分`);
    if (c.mode === 'points' && q.maxPoints === null) warnings.push(`${key}：未设置逐题满分`);
    if (q.type === 'graded' && (!q.prompt.trim() || !q.answer.trim())) warnings.push(`${key}：题干或参考解未补录，自动意见须人工确认`);
    if (q.disputed) warnings.push(`${key}：题意或规则有争议，须人工复核`);
  }
  return warnings;
}
export function validateRows(config: Config, rows: Judgment[], pages: number, confirming = false): string[] {
  const errors:string[]=[];
  const keys=new Set<string>();
  for (const row of rows) {
    const q=config.questions.find(q=>questionKey(q)===row.key);
    if (!q || keys.has(row.key)) { errors.push(`未知或重复题目：${row.key}`); continue; }
    keys.add(row.key);
    if (q.type!==row.type) errors.push(`${row.key} 批改类型不匹配`);
    if (row.pages.some(p=>p>pages)) errors.push(`${row.key} 证据页码超出 PDF 页数`);
    const missing=row.recognition==='missing'||row.recognition==='not_found';
    if (missing && row.verdict!=='missing') errors.push(`${row.key} 未做状态与判定不一致`);
    if (row.recognition==='uncertain' && row.verdict!=='uncertain') errors.push(`${row.key} 识别不清时不能判作正确或错误`);
    if (row.recognition==='found' && ['missing','uncertain'].includes(row.verdict)) errors.push(`${row.key} 判定与识别状态不一致`);
    if (q.type==='graded' && row.recognition==='found' && !['correct','partial','incorrect'].includes(row.verdict)) errors.push(`${row.key} 正确性题须给出数学判定`);
    if (q.type==='completion_only' && row.recognition==='found' && (row.verdict!=='completed' || row.deduction!==0)) errors.push(`${row.key} 完成性题已找到作答，不能扣正确性分`);
    if (!q.required && missing && row.deduction!==0) errors.push(`${row.key} 非必做题不能因漏做扣分`);
    const limit=config.mode==='points' ? q.maxPoints ?? config.total : config.total;
    if (row.deduction!==null && row.deduction>limit) errors.push(`${row.key} 扣分超过上限`);
    if (missing && q.required && q.missingPenalty!==null && row.deduction!==q.missingPenalty) errors.push(`${row.key} 漏做只能使用配置中的漏做扣分，不再叠加错误扣分`);
    if (config.policy==='linear-algebra-1.1' && row.recognition==='found' && q.type==='graded') {
      const countLimit=q.part?1:Math.max(1,q.subparts?.length??0);
      if((row.errorCount??1)>countLimit) errors.push(`${row.key} 错误处数超过小问数量；无小问题目只计一处错误`);
      const expected=row.verdict==='correct'?0:Math.round((q.errorPenalty??.1)*(row.errorCount??1)*100)/100;
      if(row.deduction!==expected) errors.push(`${row.key} 扣分应为 ${expected} 分，请核对错误处数`);
    }
    if(config.policy==='linear-algebra-2'){
      if(row.recognition==='found'&&q.type==='graded'&&row.deduction!==(row.verdict==='correct'?0:q.errorPenalty))errors.push(row.key+' 一个扣分单元只扣一次错误分');
      if((row.errorCount??1)>1)errors.push(row.key+' 不允许叠加连锁错误');
      if(missing&&row.pages.length)errors.push(row.key+' 未检索到作答不得填写证据页');
    }
    if (row.deduction && !row.reason.trim()) errors.push(`${row.key} 扣分须填写原因`);
    if (confirming && (!row.reviewed || row.recognition==='uncertain' || row.deduction===null || row.needsReview)) errors.push(`${row.key} 尚未完成复核或分值未确定`);
    if (confirming && !config.policy && row.recognition==='found' && !row.pages.length) errors.push(`${row.key} 请填写作答所在页码`);
  }
  if (keys.size!==config.questions.length) errors.push('批改结果缺少配置中的题目');
  return errors;
}
export function summarize(config: Config, rows: Judgment[]) {
  const unresolved=rows.filter(r=>r.deduction===null || r.recognition==='uncertain').length;
  const deduction=deductionRows(config,rows).reduce((sum,r)=>sum+(r.deduction??0),0);
  const value=Math.round(Math.max(0,Math.min(config.total,config.total-deduction))*100)/100;
  return { score: unresolved ? null : value, provisional:value, unresolved, deduction:Math.round(deduction*100)/100 };
}
export function reportFor(s: Pick<Submission,'grade'|'review'|'status'>): string {
  if (!s.grade) return '尚未开始批改。请进入人工评分，或配置 AI 后选择作业批改。';
  const {config,rows,provider}=s.grade;
  const ai=summarize(config,rows); const final=summarize(config,s.review??rows);
  const details=deductionRows(config,s.review??rows).filter(r=>r.deduction && r.deduction>0).map(r=>`${r.key}：扣 ${r.deduction} 分，${r.reason}`).join('\n');
  const pending=(s.review??rows).filter(r=>r.needsReview || !r.reviewed || r.deduction===null).length;
  return `${provider==='mock'?'【模拟评分，未识别或批改 PDF】':provider==='manual'?'【纯人工评分】':'【'+provider+' 视觉建议，需人工确认】'}\n满分：${config.total}\n${provider!=='manual'?`建议总分：${ai.score??'待确定'}`:'无 AI 建议'}\n人工最终总分：${s.status==='confirmed'?final.score:'待确认'}（当前未确认成绩：${final.score??'待确定'}）\n${details||'暂无已确定的扣分条目。'}${pending?`\n需复核：${pending} 项。`:''}`;
}

/** A whole question missing across several configured subparts is charged once. */
export function deductionRows(config:Config,rows:Judgment[]):Judgment[] {
  if(config.policy!=='linear-algebra-1.1')return rows;
  const groups=new Map<string,Judgment[]>();
  for(const row of rows){const q=config.questions.find(q=>questionKey(q)===row.key);if(!q)continue;const key=`${q.section} / ${q.number}`;groups.set(key,[...(groups.get(key)??[]),row]);}
  return [...groups.entries()].flatMap(([key,group])=>{
    if(group.length>1&&group.every(r=>r.recognition==='missing'||r.recognition==='not_found')){
      const first=group[0];return [{...first,key,deduction:Math.max(...group.map(r=>r.deduction??0)),reason:group.some(r=>r.recognition==='not_found')?'未检索到整题作答，暂按漏做处理。':'整题未做。',pages:[]}];
    }
    return group;
  });
}
