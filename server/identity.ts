function identityParts(filename:string) {
  const base=filename.replace(/\.pdf$/i,'');
  const matches=[...base.matchAll(/(?<!\d)\d{8,12}(?!\d)/g)];
  return {base,studentId:matches.length===1?matches[0][0]:''};
}

function parseIdentity(filename:string,stripOrdinal:boolean) {
  const {base,studentId}=identityParts(filename);
  let value=base;
  if(stripOrdinal)value=value.replace(/[‐‑–—−－]/g,'-').replace(/\u3000/g,' ');
  value=value
    .replace(/^(?:(?:re|fw|fwd|回复|转发)(?:\s*[:：_-]\s*|\s+))+/i,'')
    .replace(/[（(]([^）)]*)[）)]/g,(_whole:string,inside:string)=>/人工批改|参考|作业|附件|副本/.test(inside)?'':' '+inside+' ')
    .replace(/(?<!\d)\d{8,12}(?!\d)/g,'')
    .replace(/(?<!\d)(?:19|20)\d{2}[年./_-]\d{1,2}[月./_-]\d{1,2}日?(?!\d)/g,'')
    .replace(/(?<!\d)\d{1,2}月\d{1,2}日?(?!\d)/g,'')
    .replace(/(?<!\d)\d{1,2}[.．/-]\d{1,2}(?!\d)/g,'')
    .replace(/\d+班/g,'')
  if(stripOrdinal)value=value.replace(/^[\s_-]*(?:(?:线性代数与几何|线性代数|线代)\s*)?作业\s*(?:第\s*)?\d{1,3}(?:\s*(?:次|周))?(?=[\s_-]|$)[\s_-]*/,'');
  const studentName=value
    .replace(/(?:线性代数与几何|线性代数|线代)?作业/g,'')
    .replace(/第?\s*\d+\s*(?:次|周)/g,'')
    .replace(/[-_＿\s]+/g,' ').trim();
  return {studentId,studentName:studentName||base};
}
export function inferIdentity(filename:string){return parseIdentity(filename,true);}

/** Matches known legacy automatic names; caller must also exclude manual identity history. */
export function inferredNameCorrection(filename:string,currentName:string):string|null {
  const {base,studentId}=identityParts(filename);
  const previous=base.replace(studentId,'').replace(/^Re[_\s-]*/i,'').replace(/[（(].*?[）)]/g,'').replace(/\d+班/g,'').replace(/(?:线代|线性代数)?作业/g,'').replace(/第?\d+(?:次|周)/g,'').replace(/[-_＿\s]+/g,' ').trim()||base;
  const priorNames=[previous,parseIdentity(filename,false).studentName];
  if(!priorNames.some(name=>currentName.replace(/\s+/g,'')===name.replace(/\s+/g,'')))return null;
  const next=inferIdentity(filename).studentName;
  return next!==currentName?next:null;
}
