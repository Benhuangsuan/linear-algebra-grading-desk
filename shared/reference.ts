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

type ReferenceFile={id:string;name:string;text:string;kind:string;mime:string;pages:number|null};
/** Prefer chapter headings in the actual document; filenames are a fallback. */
export function referenceSections(file:Pick<ReferenceFile,'name'|'text'>):string[]{
  const content=[...file.text.matchAll(/(?:习题|章节|小节|第)\s*(\d+)\s*[.．]\s*(\d+)(?!\d)/g)].map(m=>m[1]+'.'+m[2]);
  const names=[...file.name.matchAll(/(?:^|[^\d.])(\d+\.\d+)(?=$|[^\d.])/g)].map(m=>m[1]);
  return [...new Set(content.length?content:names)];
}
export function recommendedReference(files:ReferenceFile[],section:string):string {
  const matches=files.filter(f=>f.kind!=='student'&&f.mime==='application/pdf'&&referenceSections(f).includes(section));
  const answers=matches.filter(f=>f.kind==='reference');const candidates=answers.length?answers:matches;
  return candidates.length===1?candidates[0].id:'';
}
export function needsReferenceConfirmation(file:ReferenceFile,section:string){return !referenceSections(file).includes(section);}
export function editReferencePage(value:ReferenceSource[],files:ReferenceFile[],section:string,next:ReferenceSource,replaceIndex:number|null=null,confirmed=false):ReferenceSource[]{
  const file=files.find(f=>f.id===next.fileId&&f.kind!=='student'&&f.mime==='application/pdf');
  if(!file||!Number.isInteger(next.page)||next.page<1||next.page>(file.pages??0))throw Error('请选择本作业的参考答案，并填写有效的 PDF 页码。');
  if(needsReferenceConfirmation(file,section)&&!confirmed)throw Error('这份文件的小节与本题不同或无法确定，请先确认这页确实用于本题。');
  if(replaceIndex!==null&&(!Number.isInteger(replaceIndex)||!value[replaceIndex]))throw Error('要更换的参考页已经变化，请重新选择。');
  const duplicate=value.findIndex(s=>s.fileId===next.fileId&&s.page===next.page);
  if(duplicate>=0&&duplicate!==replaceIndex)throw Error('这页已经在本题参考中，无需重复添加。');
  if(replaceIndex===null&&value.length>=100)throw Error('每题最多添加 100 个参考页。');
  return replaceIndex===null?[...value,next]:value.map((s,i)=>i===replaceIndex?next:s);
}
