import AdmZip from 'adm-zip';
import {createCanvas} from '@napi-rs/canvas';
import {PDFDocument,PDFDict,PDFName,StandardFonts} from 'pdf-lib';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';

/** All fixtures are invented; no course attachments or existing database are read. */
export function testDirectory(prefix:string){
  const root=resolve('codex输出/codex工作区');mkdirSync(root,{recursive:true});
  return mkdtempSync(join(root,prefix));
}
export const referenceTexts=[
  '习题 1.1\n奇数题：题目 7,11,15\n偶数题答案：\n8. 合成计算题\n参考解：2\n12. 合成计算题\n参考解：3\n16. 合成计算题\n参考解：4\n34. 判断下列合成命题\na. 2 等于 2\n对。相同整数。\nb. 3 等于 4\n错。不同整数。\nc. 4 大于 3\n对。比较整数。\nd. 5 小于 4\n错。比较整数。',
  '习题 1.2\n奇数题：题目 13,17,21\n偶数题答案：\n14. 合成计算题\n参考解：4\n18. 合成计算题\n参考解：5\n26. 判断下列合成命题\na. 2 等于 2\n对。\nb. 3 等于 3\n对。\nc. 4 等于 4\n对。\nd. 5 等于 5\n对。\ne ． 6 等于 6\n对。',
  '习题 1.3\n奇数题：题目 19,23,27\n偶数题答案：\n20. 合成计算题\n参考解：6\n24. 判断下列合成命题\na. 2 等于 2\n对。\nb. 3 等于 3\n对。\nc. 4 等于 4\n对。\nd. 5 等于 5\n对。\ne ． 6 等于 6\n对。\n36. 合成计算题\na. 计算 2 加 2\n参考解：4\nb. 计算 3 加 3\n参考解：6\nc. 计算 4 加 4\n参考解：8',
];
export const splitReference='习题 3.1 参考答案\n40. 设矩阵 M=diag(2,3)，判断下列命题\na. det M 等于 6\n对，两个对角元素相乘得到 6。\nb. det M 等于 5\n错，行列式是元素之积，不是元素之和。';

/** Raster text plus a matching ToUnicode text layer, without a bundled font asset. */
export async function syntheticPdf(text:string):Promise<Buffer>{
  const pdf=await PDFDocument.create();
  const chars=[...new Set([...text.replace(/\n/g,'')])];
  if(chars.length>220)throw new Error('Synthetic fixture exceeds its small text alphabet');
  const codes=new Map(chars.map((char,i)=>[char,i+32]));
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  await font.embed();
  const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticUnicode def /CMapType 2 def\n1 begincodespacerange <00> <FF> endcodespacerange\n'+chars.length+' beginbfchar\n'+chars.map(c=>'<'+codes.get(c)!.toString(16).padStart(2,'0')+'> <'+Buffer.from(c,'utf16le').swap16().toString('hex')+'>').join('\n')+'\nendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end';
  pdf.context.lookup(font.ref,PDFDict).set(PDFName.of('ToUnicode'),pdf.context.register(pdf.context.flateStream(cmap)));
  const lines=text.split('\n');
  for(let offset=0;offset<lines.length;offset+=26){
    const part=lines.slice(offset,offset+26),page=pdf.addPage([600,840]);
    const canvas=createCanvas(1200,1680),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,1680);ctx.fillStyle='black';ctx.font='22px sans-serif';
    part.forEach((line,i)=>ctx.fillText(line,70,96+i*54));
    page.drawImage(await pdf.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:600,height:840});
    const resource=page.node.newFontDictionary('Synthetic',font.ref).toString();
    const content=part.map((line,i)=>'BT '+resource+' 11 Tf 3 Tr 1 0 0 1 35 '+(792-i*27)+' Tm <'+[...line].map(c=>codes.get(c)!.toString(16).padStart(2,'0')).join('')+'> Tj ET').join('\n');
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(content)));
  }
  return Buffer.from(await pdf.save());
}
export async function syntheticReferences(){
  return Promise.all(referenceTexts.map(async(text,i)=>({name:`synthetic-${i+1}.pdf`,buffer:await syntheticPdf(text)})));
}
export function syntheticDocx(text:string):Buffer{
  const zip=new AdmZip(),escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  zip.addFile('[Content_Types].xml',Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels',Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml',Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>'+text.split('\n').map(line=>'<w:p><w:r><w:t xml:space="preserve">'+escape(line)+'</w:t></w:r></w:p>').join('')+'<w:p><m:oMath><m:r><m:t>x=2</m:t></m:r></m:oMath></w:p></w:body></w:document>'));
  return zip.toBuffer();
}
