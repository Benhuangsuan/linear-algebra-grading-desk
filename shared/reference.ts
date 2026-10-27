import {z} from 'zod';

export const referenceSourceSchema=z.object({fileId:z.string().min(1).max(100),page:z.number().int().min(1).max(100),graphic:z.boolean()});
export type ReferenceSource=z.infer<typeof referenceSourceSchema>;
export type ReferenceSpan={text:string;x:number;y:number;width:number;height:number;color:'black'|'red'|'other'|'unknown'};
export type ReferencePage={page:number;width:number;height:number;spans:ReferenceSpan[];graphics:{x:number;y:number;width:number;height:number;kind:'image'|'vector'}[]};
export type ReferenceLayout={version:1;pages:ReferencePage[];warnings:string[]};

/** Named headings are first-class identifiers; a trailing ordinal is retained. */
export function questionHeading(line:string):{number:string;text:string}|undefined {
  if(/^(?:习题|章节|小节|第)\s*\d+\s*[.．]\s*\d+/.test(line))return;
  const numeric=line.match(/^(\d(?:\s*\d)*)\s*[.．、)）]\s*(.*)$/);
  if(numeric&&!/^\d/.test(numeric[2]))return {number:numeric[1].replace(/\s/g,''),text:numeric[2]};
  const named=line.match(/^([\p{Script=Han}]{1,10}题(?:\s*[0-9一二三四五六七八九十百]+)?)\s*(?:[.．、:：)）]\s*(.*)|$)/u);
  if(named&&!/^(?:奇数题|偶数题|判断题|解答题|选择题|填空题|题目|小题)$/.test(named[1]))return {number:named[1].replace(/\s/g,''),text:named[2]??''};
}
export function supplementNotes(number:string){return /^补充题/.test(number)?'学生可能使用“补充题”“补充”或“补”指代本题；如有多道补充题，请结合序号及作答内容区分，不得混为同题。':'';}
