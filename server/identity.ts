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
export function inferIdentity(filename:string){
  const normalized=filename.replace(/[‐‑–—−－+＋＿]/g,'-').replace(/\u3000/g,' ');
  const identity=parseIdentity(normalized,true);
  const base=normalized.replace(/\.pdf$/i,'');
  const numbers=[...base.matchAll(/(?<!\d)\d{8,12}(?!\d)/g)];
  const candidate=numbers.length===1&&numbers[0][0].length===10?numbers[0][0]:'';
  const parts=base.replace(/[（(]/g,'-').replace(/[）)]/g,'').replace(/\d+班|第?\s*\d+\s*(?:次|周)作业/g,'').split(/[-_\s]+/).filter(Boolean);
  const standalone=candidate&&(parts[0]===candidate||parts.at(-1)===candidate);
  const ambiguous=/(?:日期|时间|题号|编号|题目|习题|参考答案)/.test(identity.studentName)||!/[\p{L}]/u.test(identity.studentName)||/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{2}$/.test(candidate);
  return {...identity,studentId:standalone&&!ambiguous?candidate:''};
}

/** Matches known legacy automatic names; caller must also exclude manual identity history. */
export function inferredNameCorrection(filename:string,currentName:string):string|null {
  const {base,studentId}=identityParts(filename);
  const previous=base.replace(studentId,'').replace(/^Re[_\s-]*/i,'').replace(/[（(].*?[）)]/g,'').replace(/\d+班/g,'').replace(/(?:线代|线性代数)?作业/g,'').replace(/第?\d+(?:次|周)/g,'').replace(/[-_＿\s]+/g,' ').trim()||base;
  const priorNames=[previous,parseIdentity(filename,false).studentName];
  if(!priorNames.some(name=>currentName.replace(/\s+/g,'')===name.replace(/\s+/g,'')))return null;
  // Freeze the existing repair: new parsing rules never rewrite old identities on startup.
  const next=parseIdentity(filename,true).studentName;
  return next!==currentName?next:null;
}
