import { configSchema, questionKey, type Config } from './domain.js';
import {childrenOf,splitUnits} from './questions.js';

/** New grading snapshots only; never rewrites saved assignments or historical grades. */
export function unitConfig(config:Config):Config {
  if(!config.confirmed)throw new Error('请先确认作业规则');
  if(config.mode!=='deduction')throw new Error('真实批改当前使用扣分模式，请先明确题目扣分规则');
  const questions=config.questions.flatMap(q=>{
    if(q.missingPenalty===null||(q.type==='graded'&&q.errorPenalty===null))throw new Error(questionKey(q)+' 缺少明确扣分规则');
    // Completion attempts always count as one whole question, even with a partial answer.
    const split=splitUnits(q);const children=childrenOf(q);
    if(split&&!children.length)throw new Error(questionKey(q)+' 请确认独立命题/小题列表');
    if(split&&children.some(c=>c.confirmed===false))throw new Error(questionKey(q)+' 的候选小问尚未核对');
    return split?children.map(child=>({...q,part:child.label,children:[],subparts:[],unitMode:'whole' as const,
      parentKey:questionKey(q),childId:child.id,
      prompt:child.prompt?[q.prompt,child.prompt].filter(Boolean).join('\n'):q.prompt,
      answer:child.answer||(child.sourceText?'':q.answer),referenceExcerpt:child.parseWarning?child.sourceText:undefined,
      missingPenalty:child.missingPenalty??q.missingPenalty,errorPenalty:child.errorPenalty??q.errorPenalty
    })): [{...q,children:[],subparts:[],unitMode:'whole' as const}];
  });
  return configSchema.parse({...config,policy:'linear-algebra-2',questions});
}
