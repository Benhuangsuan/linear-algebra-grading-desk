// Offline comparison only. This command never imports a Provider or sends HTTP requests.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import type {Submission,History,Assignment} from '../shared/domain.js';
import {questionKey} from '../shared/domain.js';
import {unitConfig} from '../shared/units.js';
import type {AiCall} from '../shared/ai.js';
const goldSchema=z.array(z.object({submissionId:z.string(),units:z.array(z.object({key:z.string(),recognition:z.enum(['found','missing','not_found','uncertain']),verdict:z.enum(['completed','correct','partial','incorrect','missing','uncertain']),pages:z.array(z.number().int().positive())}))}));
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const goldPath=arg('--gold');
if(!goldPath&&!process.argv.includes('--template'))throw new Error('用法：npm.cmd run benchmark:ai -- --template 或 --gold <本机人工标注JSON> [--data ./data]；只读本地结果，不调用API');
const gold=goldPath?goldSchema.parse(JSON.parse(readFileSync(goldPath,'utf8'))):[];
const db=new DatabaseSync(join(resolve(arg('--data')??process.env.DATA_DIR??'data'),'grading.sqlite'),{readOnly:true});
type Metric={provider:string;model:string;submissions:number;units:number;unannotatedUnits:number;missingFalsePositive:number;correctFalseDeduction:number;wrongMissed:number;verdictMismatch:number;evidenceMismatch:number;reviewNeeded:number;estimatedCny:number;unknownUsageCalls:number;cacheHitTokens:number};
const metrics=new Map<string,Metric>();
try{
  const all=<T>(table:string)=>db.prepare('SELECT payload FROM '+table).all().map(r=>JSON.parse(String(r.payload)) as T);
  const submissions=all<Submission>('submissions');const history=all<History>('history');const calls=all<AiCall>('ai_calls');
  if(process.argv.includes('--template')){
    const assignments=all<Assignment>('assignments');const out=resolve('codex输出/codex工作区');mkdirSync(out,{recursive:true});
    const template=submissions.map(s=>{
      const config=s.grade?.config??assignments.find(a=>a.id===s.assignmentId)?.config;
      return {submissionId:s.id,label:s.studentName,units:config?unitConfig(config).questions.map(q=>({key:questionKey(q),recognition:'uncertain',verdict:'uncertain',pages:[]})):[]};
    });
    const target=join(out,'人工标注模板-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    writeFileSync(target,JSON.stringify(template,null,2));console.log('请逐单元独立人工标注，不要照抄AI输出；模板仅保存本机：'+target);
  }
  if(goldPath){
  for(const sample of gold){
    const snapshots=[...history.filter(h=>h.submissionId===sample.submissionId).map(h=>h.snapshot),...submissions.filter(s=>s.id===sample.submissionId)];
    const latest=new Map<string,Submission>();
    for(const s of snapshots){if(s.grade&&['deepseek','qwen'].includes(s.grade.provider))latest.set(s.grade.provider+' / '+s.grade.model,s);}
    for(const [key,s] of latest){
      const grade=s.grade!;const metric=metrics.get(key)??{provider:grade.provider,model:grade.model,submissions:0,units:0,unannotatedUnits:0,missingFalsePositive:0,correctFalseDeduction:0,wrongMissed:0,verdictMismatch:0,evidenceMismatch:0,reviewNeeded:0,estimatedCny:0,unknownUsageCalls:0,cacheHitTokens:0};
      metric.submissions++;
      for(const g of sample.units){
        if(g.recognition==='uncertain'||g.verdict==='uncertain'){metric.unannotatedUnits++;continue;}
        const r=grade.rows.find(r=>r.key===g.key);metric.units++;
        const expectedMissing=['missing','not_found'].includes(g.recognition);
        if(!r){metric.verdictMismatch++;continue;}
        const missing=['missing','not_found'].includes(r.recognition);
        if(missing&&!expectedMissing)metric.missingFalsePositive++;
        if(['correct','completed'].includes(g.verdict)&&(r.deduction??0)>0)metric.correctFalseDeduction++;
        if(['partial','incorrect'].includes(g.verdict)&&r.deduction===0)metric.wrongMissed++;
        if(r.verdict!==g.verdict)metric.verdictMismatch++;
        if(g.pages.length&&!r.pages.some(p=>g.pages.includes(p)))metric.evidenceMismatch++;
        if(r.needsReview)metric.reviewNeeded++;
      }
      const relevant=calls.filter(c=>c.submissionId===sample.submissionId&&c.provider===grade.provider&&c.model===grade.model);
      metric.estimatedCny+=relevant.reduce((a,c)=>a+(c.estimatedCny??0),0);
      metric.unknownUsageCalls+=relevant.filter(c=>c.inputTokens===null||c.outputTokens===null).length;
      metric.cacheHitTokens+=relevant.reduce((a,c)=>a+(c.cacheHitTokens??0),0);
      metrics.set(key,metric);
    }
  }
  const out=resolve('codex输出/codex工作区');mkdirSync(out,{recursive:true});
  const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
  const path=join(out,'ai-benchmark-'+timestamp+'.json');
  writeFileSync(path,JSON.stringify({measuredAt:new Date().toISOString(),mode:'local-comparison-no-api',samples:gold.length,results:[...metrics.values()],notes:'费用为 usage 与配置单价估算，非账单；未知用量单列。判断符号、等价解与红笔分离需人工逐项标注，不能从JSON通过推断准确。'},null,2));
  console.log(metrics.size?'已生成本地对照报告：'+path:'尚无真实Provider结果；生成空报告，不虚构质量和费用：'+path);
  }
}finally{db.close();}
