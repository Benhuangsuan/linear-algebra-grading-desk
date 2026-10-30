import { z } from 'zod';
export const providerId=z.enum(['deepseek','qwen']);
export type ProviderId=z.infer<typeof providerId>;
export const batchOptions=z.object({
  ids:z.array(z.string()).min(1).max(50),provider:providerId,
  consent:z.literal(true),deidentified:z.literal(true),unitsConfirmed:z.literal(true),
  perSubmissionBudget:z.number().finite().positive().max(20).default(.5),
  totalBudget:z.number().finite().positive().max(200).default(2),
  warningAcknowledged:z.boolean().default(false),regrade:z.boolean().default(false),
  previewToken:z.string().max(100).optional(),expectedVersion:z.number().int().positive().optional(),
  maxOutputTokens:z.number().int().min(512).max(65536).optional(),
});
export type BatchOptions=z.infer<typeof batchOptions>;
export type ProviderStatus={id:ProviderId;name:string;model:string;configured:boolean;connection:string;enabled:boolean;priceDate:string;defaultMaxOutputTokens:number};
export type AiDiagnostic={stage?:'prepare'|'request'|'response'|'completion'|'validation'|'save';httpStatus?:number;finishReason?:string;maxOutputTokens?:number;retryable?:boolean;validation?:'accepted'|'rejected';responseCharacters?:number;reasoningCharacters?:number;reasoningTokens?:number;inputImages?:number;schemaFields?:string[]};
export function reportedReasoningTokens(usage:unknown):number|undefined{
  const parsed=z.object({completion_tokens:z.number().int().nonnegative(),completion_tokens_details:z.object({reasoning_tokens:z.number().int().nonnegative()})}).safeParse(usage);
  if(parsed.success&&parsed.data.completion_tokens_details.reasoning_tokens<=parsed.data.completion_tokens)return parsed.data.completion_tokens_details.reasoning_tokens;
}
export type AiBatch={id:string;assignmentId:string;provider:ProviderId;options:BatchOptions;configVersion:number;status:'running'|'paused'|'cancelled'|'completed';items:{submissionId:string;state:'queued'|'processing'|'completed'|'failed'|'cancelled';error:string;failure?:(AiDiagnostic&{code:string})}[];createdAt:string;updatedAt:string};
export type AiCall={id:string;batchId:string;submissionId:string;assignmentId:string;version:number;provider:ProviderId;model:string;pages:number;at:string;attempt:number;purpose:'grade'|'zoom'|'connection'|'reference_parse';status:'reserved'|'success'|'failed';reservedCny:number;estimatedCny:number|null;inputTokens:number|null;outputTokens:number|null;cacheHitTokens:number|null;usage:unknown;price:Price;error:string;diagnostic?:AiDiagnostic};
export type Price={input:number;output:number;cached:number;date:string;currency:'CNY';tier:string};
export type Crop={page:number;x:number;y:number;width:number;height:number};
export const cropSchema=z.object({page:z.number().int().positive(),x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).refine(c=>c.x+c.width<=1.00001&&c.y+c.height<=1.00001,'放大区域超出页面');
export const factSchema=z.object({
  key:z.string().max(200),type:z.enum(['completion_only','graded']),
  recognition:z.enum(['found','missing','not_found','uncertain']),
  verdict:z.enum(['completed','correct','partial','incorrect','missing','uncertain']),
  reason:z.string().max(1500).default(''),pages:z.array(z.number().int().positive()).max(100),
  reviewReason:z.string().max(1000).default(''),
}).strict();
export const visionOutput=z.object({rows:z.array(factSchema).max(300),zoomRequests:z.array(cropSchema).max(4).default([])}).strict();
