import {visionOutput} from '../../shared/ai.js';
import {questionKey,validateRows,type Config,type Judgment} from '../../shared/domain.js';
import {AiError} from './config.js';
export function validateVision(content:string,config:Config,pages:number){
  let data:unknown;try{data=JSON.parse(content);}catch{throw new AiError('format','模型未返回有效 JSON，未保存为成功结果');}
  const parsed=visionOutput.safeParse(data);if(!parsed.success)throw new AiError('format','模型输出结构不合法');
  const output=parsed.data;const keys=new Set<string>();
  const rows:Judgment[]=output.rows.map(fact=>{
    const q=config.questions.find(q=>questionKey(q)===fact.key);
    if(!q||keys.has(fact.key))throw new AiError('format','模型返回未知或重复扣分单元');
    keys.add(fact.key);
    if(fact.type!==q.type||fact.pages.some(p=>p>pages))throw new AiError('format','模型题型或证据页码无效');
    const missing=fact.recognition==='missing'||fact.recognition==='not_found';
    const unclear=fact.recognition==='uncertain';
    if((missing&&fact.pages.length)||missing&&fact.verdict!=='missing'||unclear&&fact.verdict!=='uncertain')throw new AiError('format','未作答/不确定状态与证据不一致');
    const error=fact.recognition==='found'&&q.type==='graded'&&fact.verdict!=='correct';
    if(error&&(!fact.reason.trim()||/^(此处)?存在一处错误[。.!！]?$|^回答错误[。.!！]?$/.test(fact.reason.trim())))throw new AiError('format','错误结论缺少可核对的具体原因');
    if(q.type==='completion_only'&&fact.recognition==='found'&&fact.verdict!=='completed')throw new AiError('format','完成性题不得判数学正确性');
    const reviewReason=fact.reviewReason||(missing?'请人工核对该漏做单元':unclear?'疑似作答无法可靠辨认':error&&!fact.pages.length?'判错缺少证据页，请核对':'');
    return {...fact,deduction:unclear?null:missing?(q.required?q.missingPenalty:0):q.type==='completion_only'||fact.verdict==='correct'?0:q.errorPenalty,
      reason:missing?'未检索到该单元作答，暂按漏做扣分。':error?fact.reason:'',reviewReason,
      errorCount:error?1:undefined,reviewed:false,needsReview:!!reviewReason||missing||unclear};
  });
  for(const row of rows)if(row.deduction===.2)row.needsReview=true;
  if(keys.size!==config.questions.length)throw new AiError('format','模型结果缺少配置单元');
  if(output.zoomRequests.some(c=>c.page>pages))throw new AiError('format','模型请求的放大页码无效');
  const errors=validateRows(config,rows,pages);if(errors.length)throw new AiError('format','模型事实与评分规则不一致：'+errors.join('；'));
  return {rows,zoomRequests:output.zoomRequests};
}
