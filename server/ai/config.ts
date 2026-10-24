import type { ProviderId, ProviderStatus, Price, AiDiagnostic } from '../../shared/ai.js';
export type Env=Record<string,string|undefined>;
export type ProviderConfig={id:ProviderId;name:string;key:string;model:string;endpoint:string;timeout:number;maxOutput:number;retries:number;enabled:boolean;priceDate:string;rates:{input:number;output:number;cached:number}};
const number=(env:Env,name:string,fallback:number,min:number,max:number)=>{
  const n=Number(env[name]??fallback);if(!Number.isFinite(n)||n<min||n>max)throw new Error(name+' 配置无效');return n;
};
export function providerConfig(id:ProviderId,env:Env=process.env):ProviderConfig {
  const deep=id==='deepseek';const prefix=deep?'DEEPSEEK':'QWEN';
  const endpoint=env[prefix+'_BASE_URL']??(deep?'https://api.deepseek.com':'https://dashscope.aliyuncs.com/compatible-mode/v1');
  const url=new URL(endpoint);
  const allowed=deep?url.hostname==='api.deepseek.com':url.hostname==='dashscope.aliyuncs.com'||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|eu-central-1|us-east-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname);
  if(url.protocol!=='https:'||!allowed||url.username||url.password||url.search||url.hash||url.port)throw new Error('仅支持官方 HTTPS 模型端点');
  if(!deep&&url.hostname!=='dashscope.aliyuncs.com'&&!url.hostname.includes('.cn-beijing.')&&['QWEN_INPUT_CNY_PER_M','QWEN_OUTPUT_CNY_PER_M','QWEN_CACHED_CNY_PER_M'].some(k=>!env[k]))throw new Error('非北京地区必须显式配置该地区三项价格，不能沿用默认价格');
  const model=env[prefix+'_MODEL']??(deep?'deepseek-flash':'qwen3.7-flash');
  if(deep?!/^deepseek-flash$/.test(model):!/^qwen3\.7-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(model))throw new Error('模型名不在已验证的视觉适配范围');
  // Conservative PEAK USD pricing * configurable budget conversion, not a live FX quote.
  const fx=number(env,'AI_USD_CNY_BUDGET_RATE',8,.1,100);
  return {id,name:deep?'DeepSeek':'Qwen',key:env[deep?'DEEPSEEK_API_KEY':'DASHSCOPE_API_KEY']??'',model,endpoint:endpoint.replace(/\/$/,''),
    timeout:number(env,'AI_TIMEOUT_MS',240000,100,600000),maxOutput:number(env,'AI_MAX_OUTPUT_TOKENS',deep?16384:8192,512,65536),retries:number(env,'AI_MAX_RETRIES',1,0,2),
    enabled:env.AI_ALLOW_PAID==='true',priceDate:env.AI_PRICE_DATE??'2026-10-23',
    rates:{input:number(env,prefix+'_INPUT_CNY_PER_M',deep?.3*fx:1.2,.00001,10000),output:number(env,prefix+'_OUTPUT_CNY_PER_M',deep?1.2*fx:4.8,.00001,10000),cached:number(env,prefix+'_CACHED_CNY_PER_M',deep?.006*fx:.24,0,10000)}};
}
export function priceFor(c:ProviderConfig,input:number):Price {
  // Qwen default is Beijing's conservative highest tier; custom prices remain explicit configuration.
  return {...c.rates,date:c.priceDate,currency:'CNY',tier:c.id==='deepseek'?'peak / budget conversion':'conservative <=1M tier'};
}
export function safeStatus(c:ProviderConfig,connection='未测试'):ProviderStatus {
  return {id:c.id,name:c.name,model:c.model,configured:!!c.key,connection,enabled:c.enabled,priceDate:c.priceDate,defaultMaxOutputTokens:c.maxOutput};
}
export class AiError extends Error {
  constructor(readonly code:string,message:string,readonly retryable=false,readonly diagnostic:AiDiagnostic={}){super(message);}
}
