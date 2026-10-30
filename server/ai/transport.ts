import {z,ZodError} from 'zod';
import {AiError,type ProviderConfig} from './config.js';
export type Content={type:'text';text:string}|{type:'image_url';image_url:{url:string;detail:'high'}};
export type Message={role:'system'|'user';content:string|Content[]};
export type TransportResult={content:string;model:string;usage:unknown;finish:string;httpStatus:number;reasoningCharacters:number};
export type Fetch=typeof fetch;
const wire=z.object({model:z.string().optional(),usage:z.unknown().optional(),choices:z.array(z.object({message:z.object({content:z.string(),reasoning_content:z.string().nullable().optional()}),finish_reason:z.string().nullable()}))});
export function assertRequestLimits(c:ProviderConfig,messages:Message[]){
  const imageCount=messages.reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').length:0),0);
  if(c.id==='deepseek'&&imageCount>600)throw new AiError('input_limit','本次图像数量超过服务商上限，请减少同批参考材料或本地分段导出；未发送请求',false,{stage:'prepare'});
  if(Buffer.byteLength(JSON.stringify(messages))+1024>46*1024*1024)throw new AiError('input_limit','本次完整图像超过请求大小上限，请本地分段导出；未删页、未发送请求',false,{stage:'prepare'});
}
export function scrub(text:string,key:string){return key?text.replaceAll(key,'[密钥已隐藏]'):text;}
function safeUsage(value:unknown,key:string):unknown {
  if(value===undefined)return null;
  return JSON.parse(JSON.stringify(value,(_k,v:unknown)=>typeof v==='string'?scrub(v,key):v)) as unknown;
}
export async function complete(c:ProviderConfig,messages:Message[],fetcher:Fetch=fetch,signal?:AbortSignal,onInterrupted?:(result:TransportResult)=>void):Promise<TransportResult>{
  if(!c.enabled)throw new AiError('disabled','真实 API 尚未启用；请先配置 AI_ALLOW_PAID 并获得调用授权');
  if(!c.key)throw new AiError('missing_key','未检测到 '+(c.id==='deepseek'?'DEEPSEEK_API_KEY':'DASHSCOPE_API_KEY'));
  assertRequestLimits(c,messages);
  const body={model:c.model,messages,stream:true,stream_options:{include_usage:true},max_tokens:c.maxOutput,
    response_format:{type:'json_object'},...(c.id==='deepseek'?{thinking:{type:'enabled'},reasoning_effort:'high'}:{enable_thinking:true,vl_high_resolution_images:true})};
  const encoded=JSON.stringify(body);
  if(Buffer.byteLength(encoded)>46*1024*1024)throw new AiError('input_limit','页面图像超过请求大小上限；没有删页或降清晰度，请改用人工或拆分作业');
  let response:Response;
  const timeout=AbortSignal.timeout(c.timeout);
  try{response=await fetcher(c.endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},body:encoded,signal:AbortSignal.any([timeout,...(signal?[signal]:[])]),redirect:'error'});}
  catch{throw new AiError(signal?.aborted?'cancelled':timeout.aborted?'timeout':'network','请求中断、网络不可达或超时；用量未知，预算按保守预留保留',false,{stage:'request'});}
  if(!response.ok){
    const status=response.status;await response.body?.cancel().catch(()=>{});
    const code=status===401?'invalid_key':status===402?'balance':status===403?'permission':status===429?'rate_limit':status===400||status===404?'model_or_format':'provider_error';
    const labels:Record<string,string>={invalid_key:'Key 无效',balance:'余额不足',permission:'账号无权限或地区不匹配',rate_limit:'服务商限流',model_or_format:'模型、图片或 JSON 参数不受支持',provider_error:'服务商异常'};
    throw new AiError(code,labels[code],status===429||status>=500,{httpStatus:status,stage:'response'});
  }
  if(!(response.headers.get('content-type')??'').includes('text/event-stream')){
    let parsed:z.infer<typeof wire>;
    try{parsed=wire.parse(await response.json());}catch(e){const code=signal?.aborted?'cancelled':timeout.aborted?'timeout':e instanceof SyntaxError||e instanceof ZodError?'format':'network';throw new AiError(code,'服务商响应未完成或格式错误；用量未知，保留预算预留',false,{httpStatus:response.status,stage:'response'});}
    const first=parsed.choices[0];if(!first)throw new AiError('format','服务商没有返回结果',false,{httpStatus:response.status,stage:'response'});
    return {content:scrub(first.message.content,c.key),model:scrub(parsed.model??c.model,c.key),usage:safeUsage(parsed.usage,c.key),finish:first.finish_reason??'',httpStatus:response.status,reasoningCharacters:first.message.reasoning_content?.length??0};
  }
  const reader=response.body?.getReader();if(!reader)throw new AiError('format','服务商返回了空响应',false,{httpStatus:response.status,stage:'response'});
  const decoder=new TextDecoder();let pending='';let content='';let model=c.model;let finish='';let usage:unknown=null;let size=0;let reasoningCharacters=0;
  const consume=(line:string)=>{
    if(!line.startsWith('data:'))return;const value=line.slice(5).trim();if(!value||value==='[DONE]')return;
    let data:unknown;try{data=JSON.parse(value);}catch{throw new AiError('format','流式 JSON 数据损坏');}
    const parsed=z.object({model:z.string().optional(),usage:z.unknown().optional(),choices:z.array(z.object({delta:z.object({content:z.string().nullable().optional(),reasoning_content:z.string().nullable().optional()}).passthrough(),finish_reason:z.string().nullable().optional()})).optional()}).safeParse(data);
    if(!parsed.success)throw new AiError('format','流式响应结构无效',false,{httpStatus:response.status,stage:'response'});const chunk=parsed.data;
    if(chunk.model)model=chunk.model;if(chunk.usage)usage=chunk.usage;
    for(const choice of chunk.choices??[]){content+=choice.delta.content??'';reasoningCharacters+=choice.delta.reasoning_content?.length??0;if(choice.finish_reason)finish=choice.finish_reason;}
    // reasoning_content intentionally neither requested as output nor persisted.
  };
  try{
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32*1024*1024)throw new AiError('format','响应超出本机限制');pending+=decoder.decode(part.value,{stream:true});let at:number;while((at=pending.indexOf('\n'))>=0){consume(pending.slice(0,at).replace(/\r$/,''));pending=pending.slice(at+1);}}
    pending+=decoder.decode();if(pending.trim())consume(pending);
  }catch(e){if(content)onInterrupted?.({content:scrub(content,c.key),model:scrub(model,c.key),usage:safeUsage(usage,c.key),finish:finish||'interrupted',httpStatus:response.status,reasoningCharacters});await reader.cancel().catch(()=>{});if(e instanceof AiError)throw new AiError(e.code,e.message,e.retryable,{httpStatus:response.status,stage:'response',...e.diagnostic});throw new AiError(signal?.aborted?'cancelled':timeout.aborted?'timeout':'network','响应中断，用量按未知处理，保留预算预留',false,{httpStatus:response.status,stage:'response'});}
  finally{reader.releaseLock();}
  return {content:scrub(content,c.key),model:scrub(model,c.key),usage:safeUsage(usage,c.key),finish,httpStatus:response.status,reasoningCharacters};
}
