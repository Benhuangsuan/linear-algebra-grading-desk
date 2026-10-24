import {z} from 'zod';
import type {AiCall,Price} from '../../shared/ai.js';
import type {ProviderConfig} from './config.js';
import type {Message} from './transport.js';
export function estimateInput(c:ProviderConfig,messages:Message[]):number{
  let tokens=0;
  for(const message of messages){
    if(typeof message.content==='string'){tokens+=Buffer.byteLength(message.content);continue;}
    for(const part of message.content)tokens+=part.type==='text'?Buffer.byteLength(part.text):(c.id==='deepseek'?1024:16384);
  }
  return Math.ceil(tokens*1.15)+512; // all text bytes, image upper bounds, overhead; no cache discount.
}
export function cost(price:Price,input:number,output:number,cached=0){
  return Math.ceil(((Math.max(0,input-cached)*price.input+cached*price.cached+output*price.output)/1_000_000)*1e6)/1e6;
}
const usageSchema=z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative(),prompt_cache_hit_tokens:z.number().int().nonnegative().optional(),prompt_tokens_details:z.object({cached_tokens:z.number().int().nonnegative().optional()}).optional()}).passthrough();
export function accounting(usage:unknown,price:Price){
  const parsed=usageSchema.safeParse(usage);if(!parsed.success)return {inputTokens:null,outputTokens:null,cacheHitTokens:null,estimatedCny:null,usage:null};
  const u=parsed.data;const reported=u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens;
  const cached=Math.min(u.prompt_tokens,reported??0);
  return {inputTokens:u.prompt_tokens,outputTokens:u.completion_tokens,cacheHitTokens:reported===undefined?null:cached,estimatedCny:cost(price,u.prompt_tokens,u.completion_tokens,cached),usage:u};
}
export function committed(call:AiCall){return call.estimatedCny??call.reservedCny;}
