import {PDFDocument,PDFDict,PDFName,StandardFonts,rgb} from 'pdf-lib';
/** Invented text and vector shapes only; no textbook, font asset or private file. */
export async function styledReference(mixedLine=false){
  const rows=[
    {text:'习题 3.3 参考答案',y:790},{text:'奇数题：',y:760},{text:'题目 5,13',y:735},{text:'偶数题答案：',y:710},
    {text:'18. Synthetic multi-line prompt',y:680},{text:'second prompt line',y:660},{text:'Reference eighteen',y:640,red:true},
    {text:'26. Synthetic transformation',y:610},{text:'continuation of conditions',y:590},{text:'Reference twenty-six',y:570,red:true},
    {text:'32. Shared condition, 见下图',y:530},{text:'a. Synthetic first subquestion',y:370},{text:'Reference alpha',y:350,red:true},{text:'b. Synthetic second subquestion',y:320},{text:'Reference beta',y:300,red:true},
    {text:'补充题1. Synthetic independent extra',y:790,page:1},{text:'continued statement',y:765,page:1},{text:'Extra answer one',y:740,page:1,red:true},
    {text:'补充题2. Another extra',y:700,page:1},{text:'Extra answer two',y:675,page:1,red:true},
  ];
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);await font.embed();
  const chars=[...new Set(rows.flatMap(r=>[...r.text]))];const codes=new Map(chars.map((c,i)=>[c,i+32]));
  const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Synthetic def /CMapType 2 def\n1 begincodespacerange <00> <FF> endcodespacerange\n'+chars.length+' beginbfchar\n'+chars.map(c=>'<'+codes.get(c)!.toString(16).padStart(2,'0')+'> <'+Buffer.from(c,'utf16le').swap16().toString('hex')+'>').join('\n')+'\nendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end';
  pdf.context.lookup(font.ref,PDFDict).set(PDFName.of('ToUnicode'),pdf.context.register(pdf.context.flateStream(cmap)));
  for(let i=0;i<2;i++){
    const page=pdf.addPage([600,840]),resource=page.node.newFontDictionary('Synthetic',font.ref).toString();
    const commands=rows.filter(r=>(r.page??0)===i).map(r=>'q '+(r.red?'1 0 0':'0 0 0')+' rg BT '+resource+' 11 Tf 0 Tr 1 0 0 1 '+(mixedLine&&r.text==='Reference eighteen'?380:30)+' '+(mixedLine&&r.text==='Reference eighteen'?680:r.y)+' Tm <'+[...r.text].map(c=>codes.get(c)!.toString(16).padStart(2,'0')).join('')+'> Tj ET Q').join('\n');
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(commands)));
    if(i===0)for(const [start,end] of [[{x:100,y:420},{x:220,y:420}],[{x:220,y:420},{x:160,y:500}],[{x:160,y:500},{x:100,y:420}]])page.drawLine({start,end,color:rgb(0,0,0),thickness:1});
  }
  return Buffer.from(await pdf.save());
}
