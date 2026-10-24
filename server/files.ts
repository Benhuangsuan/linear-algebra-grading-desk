import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import { blankQuestion, type Question } from '../shared/domain.js';
import { resolve } from 'node:path';
export { inferIdentity } from './identity.js';

export async function inspectFile(buffer:Buffer,name:string,student:boolean) {
  if (/\.pdf$/i.test(name)) {
    if (!buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF');
    let doc:PDFDocument;
    try {doc=await PDFDocument.load(buffer,{updateMetadata:false,throwOnInvalidObject:false});}
    catch {throw new Error('PDF 无法读取，可能损坏或加密。请重新导出 PDF。');}
    if (doc.isEncrypted) throw new Error('暂不接受加密 PDF，请先解除密码保护');
    const pages=doc.getPageCount();
    if(pages<1 || pages>100) throw new Error('每个 PDF 必须为 1～100 页');
    let text='';let warning='';
    if(!student){
      try {
        const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task=getDocument({data:new Uint8Array(buffer),standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/',useSystemFonts:true,verbosity:0});
        const pdf=await task.promise;
        try {for(let n=1;n<=pdf.numPages&&text.length<200000;n++){const page=await pdf.getPage(n);const content=await page.getTextContent();for(const item of content.items){if('str'in item)text+=item.str+(item.hasEOL?'\n':'');}text+='\n';}}finally{await task.destroy();}
        if(!text.trim())warning='这份 PDF 没有可提取的文字，请补充题目清单。';
      } catch(e){warning=`无法提取 PDF 文字，请补充题目清单。（${e instanceof Error?e.message:'解析失败'}）`;}
    }
    return {ext:'.pdf',mime:'application/pdf',pages,text,warning};
  }
  if (!student && /\.docx$/i.test(name)) {
    let zip:AdmZip;
    try {zip=new AdmZip(buffer);} catch {throw new Error('无效的 DOCX 文件');}
    const entries=zip.getEntries();
    if(entries.length>3000 || entries.reduce((s,e)=>s+e.header.size,0)>100*1024*1024) throw new Error('DOCX 解压内容过大');
    const doc=zip.getEntry('word/document.xml');
    if(!doc) throw new Error('文件缺少 Word 文档结构');
    const xml=doc.getData().toString('utf8');
    const math=/<(?:\w+:)?oMath\b/.test(xml); const images=entries.some(e=>e.entryName.startsWith('word/media/'));
    const text=(await mammoth.extractRawText({buffer})).value.slice(0,200000);
    return {ext:'.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pages:null,text,
      warning:`DOCX 文本预览仅供核对题号，不能替代原文。${math?'检测到原生数学公式/矩阵，文本提取可能遗漏。':''}${images?'文档含图片，文本预览不包含图片。':''}请用 Word 导出 PDF 后一并上传，以完整预览数学排版。`};
  }
  throw new Error(student?'学生提交仅接受 PDF':'参考材料仅接受 PDF 或 DOCX');
}
export function normalizeFilename(name:string) {
  const decoded=Buffer.from(name,'latin1').toString('utf8');
  const normalized=[...name].every(c=>c.charCodeAt(0)<=255) && !decoded.includes('�')?decoded:name;
  return normalized.replace(/[\x00-\x1f]/g,'').replace(/\\/g,'/').split('/').pop()!.slice(0,240) || '未命名.pdf';
}
export function suggestQuestions(text:string):Question[] {
  const section=text.match(/习题\s*(\d+(?:\.\d+)+)/)?.[1];
  if(!section) return [];
  const rows:Question[]=[];
  const only=text.match(/奇数题[：:]([\s\S]*?)(?:偶数题|$)/)?.[1]??'';
  const numbers=only.match(/题目\s*([\d,，、\s]+)/)?.[1]?.match(/\d+/g)??[];
  for(const number of numbers) rows.push({...blankQuestion(),section,number,type:'completion_only',errorPenalty:0});
  // Only the explicitly labelled reference section is parsed; parity is not a general rule.
  const graded=text.split(/偶数题答案[：:]/)[1]??'';
  for(const m of graded.matchAll(/^\s*(\d+)[.．、]\s*(.+)/gm)) rows.push({...blankQuestion(),section,number:m[1],type:'graded',prompt:m[2].trim()});
  return rows.filter((q,i,all)=>all.findIndex(x=>x.section===q.section&&x.number===q.number)===i);
}
