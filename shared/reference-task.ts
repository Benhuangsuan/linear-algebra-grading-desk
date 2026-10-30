import type {Config,Question} from './domain.js';
export type ReferenceTask={id:string;assignmentId:string;version:number;provider:string;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';createdAt:string;error:string;warnings:string[];config:Config;estimatedCny:number;totalBudget:number;committedCny:number;referenceVersion?:number;files:{id:string;name:string;pages:number;processedPages:number[];status:'waiting'|'processing'|'completed'|'failed';resultId?:string;fileHash?:string;error?:string}[]};

export const REFERENCE_PROMPT_VERSION='reference-batch-v4';
export const REFERENCE_RESULT_VERSION=1;
export type ReferenceResponse={id:string;taskId:string;assignmentId:string;fileId:string;fileHash:string;sections:string[];pages:number[];promptVersion:string;model:string;finish:string;createdAt:string;content:string;validation?:'accepted'|'rejected';error?:string};
export type ReferenceResult={id:string;assignmentId:string;taskId:string;fileId:string;fileHash:string;sections:string[];pages:number;processedPages:number[];status:'complete'|'partial'|'failed';questions:Question[];responseIds:string[];callIds:string[];model:string;promptVersion:string;resultVersion:number;createdAt:string;completedAt?:string;legacy?:boolean;error:string;errorCode?:string};
export type ReferenceResultSummary=Omit<ReferenceResult,'questions'>&{questionCount:number;available:boolean;matchingFileIds:string[];unavailableReason:string;estimatedCny:number;usageUnknown:boolean;hasResponse:boolean};
export type ReferenceSelection={fileId:string;resultId:string};
export type ReferenceConflict={key:string;choices:{resultId:string;fileId:string;prompt:string;answer:string}[]};
export type ReferenceResultPreview={config?:Config;conflicts:ReferenceConflict[];warnings:string[]};
