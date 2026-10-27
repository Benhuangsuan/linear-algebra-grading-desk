import {questionKey,type Assignment,type StoredFile,type Submission} from './domain.js';
import {childrenOf,splitUnits} from './questions.js';
import {unitConfig} from './units.js';
import {aiSelectionReason} from './submission-state.js';
import type {AiBatch,ProviderStatus} from './ai.js';

export type Blocker={code:string;message:string;settings?:boolean};
/** Shared preflight for UI guidance and server preparation; no rendering or model calls. */
export function gradingBlockers(a:Assignment,files:StoredFile[]):Blocker[]{
  const reasons:Blocker[]=[];const config=a.config;
  const pending=config.questions.flatMap(q=>splitUnits(q)?childrenOf(q).filter(c=>c.confirmed===false).map(c=>questionKey(q)+' / '+c.label):[]);
  if(pending.length)reasons.push({code:'unchecked',settings:true,message:`还有 ${pending.length} 个独立计分的小问未核对（${pending.slice(0,6).join('；')}${pending.length>6?'等':''}）。请到“作业设置 → 题目清单与扣分规则”完成校对并保存。`});
  if(!config.questions.length)reasons.push({code:'questions',settings:true,message:'尚未保存题目清单，请到作业设置整理参考答案、核对题目并保存。'});
  else if(!config.confirmed)reasons.push({code:'rules',settings:true,message:'题目与扣分规则尚未确认，请到作业设置核对并保存。'});
  if(!reasons.length){try{unitConfig(config);}catch(e){reasons.push({code:'rules',settings:true,message:'题目或扣分规则尚不完整，请到作业设置检查。'+(e instanceof Error&&!e.message.startsWith('[')?e.message:'')});}}
  if(reasons.length)return reasons;
  const units=unitConfig(config).questions;const materials=files.filter(f=>f.assignmentId===a.id&&f.kind!=='student');
  for(const q of units){
    if(/下图|如图|见图|图示|示意图/.test(q.prompt+'\n'+q.answer)&&!q.referenceSources?.some(s=>s.graphic))reasons.push({code:'reference_graphic',settings:true,message:questionKey(q)+' 需要参考图片，请在作业设置中添加并核对参考页。'});
    if(q.referenceSources?.some(s=>!materials.some(f=>f.id===s.fileId&&f.mime==='application/pdf'&&s.page<=(f.pages??0))))reasons.push({code:'reference_graphic',settings:true,message:questionKey(q)+' 的参考页已失效，请更换或移除后保存设置。'});
  }
  if(!materials.some(f=>f.mime==='application/pdf')){
    if(materials.length)reasons.push({code:'reference',settings:true,message:'请将参考材料导出为 PDF 后上传；原来的 Word 文件会保留。'});
    else if(units.some(q=>q.type==='graded'&&!q.answer.trim()))reasons.push({code:'reference',settings:true,message:'请上传 PDF 参考答案，或在作业设置中补全参考解并保存。'});
  }
  return reasons;
}

export function aiActionBlockers(input:{assignment:Assignment;files:StoredFile[];ids:string[];submissions:Submission[];provider?:ProviderStatus;batches:AiBatch[];regrade:boolean;consent:boolean;deidentified:boolean;unitsConfirmed:boolean;busy:boolean;per:number;total:number}):Blocker[]{
  const x=input;const reasons:Blocker[]=[];
  if(x.busy)reasons.push({code:'busy',message:'正在处理本次操作，请等待完成，不要重复点击。'});
  if(x.assignment.archived)reasons.push({code:'archived',message:'作业已归档，请先从作业菜单取消归档。'});
  if(!x.ids.length)reasons.push({code:'selection',message:'尚未选择学生作业，请返回列表勾选需要批改的学生。'});
  const invalid=x.ids.map(id=>aiSelectionReason(x.submissions.find(s=>s.id===id),x.regrade)).filter(Boolean);
  if(invalid.length)reasons.push({code:'selection',message:'所选作业暂不可批改：'+[...new Set(invalid)].join('；')+'。请返回列表核对。'});
  if(x.batches.some(b=>['running','paused'].includes(b.status)&&b.items.some(i=>x.ids.includes(i.submissionId)&&['queued','processing'].includes(i.state))))reasons.push({code:'queue',message:'所选作业已有未结束的批次，请在“批次与费用”继续或取消原批次，不要重复发起。'});
  reasons.push(...gradingBlockers(x.assignment,x.files));
  if(!x.provider)reasons.push({code:'service',message:'正在读取 AI 配置；若长时间没有结果，请检查本地服务并重新打开窗口。'});
  else{
    if(!x.provider.configured)reasons.push({code:'service',message:'尚未配置所选 AI 服务的密钥，请按“如何启用 AI”配置后重启本地服务。也可以使用人工评分。'});
    if(!x.provider.enabled)reasons.push({code:'service',message:'尚未允许付费调用，请按“如何启用 AI”开启后重启本地服务。人工评分不受影响。'});
  }
  if(!Number.isFinite(x.per)||x.per<=0||x.per>20||!Number.isFinite(x.total)||x.total<=0||x.total>200)reasons.push({code:'budget',message:'请填写有效预算：每份大于 0 且不超过 20 元，本批大于 0 且不超过 200 元。'});
  if(!x.unitsConfirmed||!x.deidentified||!x.consent)reasons.push({code:'consent',message:'请先核对计分题目、处理页面中的姓名和学号，并逐项确认下方三项授权；勾选不会自动调用 AI。'});
  return reasons;
}
