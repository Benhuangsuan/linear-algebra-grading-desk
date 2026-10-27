import {getDocument,OPS,Util} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {resolve} from 'node:path';
import type {ReferenceLayout,ReferencePage,ReferenceSpan} from '../shared/reference.js';

const compact=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
function color(value:unknown):ReferenceSpan['color'] {
  if(typeof value!=='string'||!/^#[\da-f]{6}$/i.test(value))return 'unknown';
  const rgb=[1,3,5].map(i=>parseInt(value.slice(i,i+2),16));
  if(rgb.every(n=>n<95))return 'black';
  if(rgb[0]>130&&rgb[0]>rgb[1]*1.6&&rgb[0]>rgb[2]*1.6)return 'red';
  return 'other';
}

/** Preserve operator colors and viewport coordinates before flattening any text. */
export async function extractReferenceLayout(bytes:Uint8Array):Promise<ReferenceLayout>{
  const task=getDocument({data:new Uint8Array(bytes),standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/',useSystemFonts:true,verbosity:0});
  const result:ReferenceLayout={version:1,pages:[],warnings:[]};let characters=0;
  try{
    const pdf=await task.promise;
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n),viewport=page.getViewport({scale:1});
      const content=await page.getTextContent({disableNormalization:true}),ops=await page.getOperatorList();
      if(ops.fnArray.length>500000)throw new Error('页面操作数量过多，请人工检查或分段导出');
      let state={fill:'#000000',stroke:'#000000',mode:0,matrix:[1,0,0,1,0,0]};const stack:typeof state[]=[];
      const glyphs:{character:string;color:ReferenceSpan['color']}[]=[];
      const graphics:ReferencePage['graphics']=[],vectors:ReferencePage['graphics']=[];
      const region=(box:number[],kind:'image'|'vector')=>{
        const points=[[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]].map(p=>{Util.applyTransform(p,Util.transform(viewport.transform,state.matrix));return p;});
        const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
        const x=Math.max(0,Math.min(...xs)),y=Math.max(0,Math.min(...ys)),right=Math.min(viewport.width,Math.max(...xs)),bottom=Math.min(viewport.height,Math.max(...ys));
        const area={x:x/viewport.width,y:y/viewport.height,width:Math.max(.001,(right-x)/viewport.width),height:Math.max(.001,(bottom-y)/viewport.height),kind};
        if(kind==='vector')vectors.push(area);
        else if(right-x>viewport.width*.04&&bottom-y>viewport.height*.035)graphics.push(area);
      };
      for(let i=0;i<ops.fnArray.length;i++){
        const op=ops.fnArray[i],args=ops.argsArray[i];
        if(op===OPS.save)stack.push({...state,matrix:[...state.matrix]});
        else if(op===OPS.restore)state=stack.pop()??state;
        else if(op===OPS.transform)state.matrix=Util.transform(state.matrix,args);
        else if(op===OPS.setFillRGBColor)state.fill=typeof args[0]==='string'?args[0]:'#unknown';
        else if(op===OPS.setStrokeRGBColor)state.stroke=typeof args[0]==='string'?args[0]:'#unknown';
        else if(op===OPS.setTextRenderingMode)state.mode=args[0];
        else if(op===OPS.showText||op===OPS.showSpacedText||op===OPS.nextLineShowText||op===OPS.nextLineSetSpacingShowText){
          const items=args.find((a:unknown)=>Array.isArray(a))??[];
          for(const g of items)if(g&&typeof g==='object'&&typeof g.unicode==='string')for(const character of compact(g.unicode).split(''))glyphs.push({character,color:state.mode===3?'unknown':color(state.mode===1?state.stroke:state.fill)});
        }else if(op===OPS.paintImageXObject||op===OPS.paintInlineImageXObject||op===OPS.paintImageMaskXObject)region([0,0,1,1],'image');
        else if(op===OPS.constructPath&&[OPS.stroke,OPS.closeStroke,OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke].includes(args[0])&&color(state.stroke)==='black'){
          const box=args.at(-1);if((Array.isArray(box)||box instanceof Float32Array||box instanceof Float64Array)&&box.length===4)region(Array.from(box as number[]),'vector');
        }
      }
      // Join connected strokes, so a vector diagram made of thin separate edges survives.
      const groups:typeof vectors=[];
      for(const v of vectors){let area={...v};for(let i=groups.length-1;i>=0;i--){const p=groups[i];if(area.x<=p.x+p.width+.006&&p.x<=area.x+area.width+.006&&area.y<=p.y+p.height+.006&&p.y<=area.y+area.height+.006){const x=Math.min(area.x,p.x),y=Math.min(area.y,p.y);area={...area,x,y,width:Math.max(area.x+area.width,p.x+p.width)-x,height:Math.max(area.y+area.height,p.y+p.height)-y};groups.splice(i,1);}}groups.push(area);}
      graphics.push(...groups.filter(v=>v.width>.04&&v.height>.035&&v.width*v.height<.9));
      const glyphText=glyphs.map(g=>g.character).join('');let cursor=0;
      const spans:ReferenceSpan[]=[];
      for(const item of content.items){
        if(!('str'in item)||!item.str)continue;
        characters+=item.str.length;if(characters>200000)throw new Error('参考文字超过本地解析上限，请分段导出');
        const needle=compact(item.str);const at=needle?glyphText.indexOf(needle,cursor):-1;
        const matched=at>=cursor&&at-cursor<2000;const colors=matched?glyphs.slice(at,at+needle.length).map(g=>g.color):[];
        if(matched)cursor=at+needle.length;
        const t=Util.transform(viewport.transform,item.transform);
        let offset=0;const runs:{text:string;color:ReferenceSpan['color']}[]=[];
        for(const ch of item.str){const size=compact(ch).length;const candidates=colors.slice(offset,offset+size);const c=size&&candidates.length===size&&candidates.every(v=>v===candidates[0])?candidates[0]:size?'unknown':runs.at(-1)?.color??colors[offset]??'unknown';offset+=size;const last=runs.at(-1);if(last?.color===c)last.text+=ch;else runs.push({text:ch,color:c});}
        let fraction=0;for(const run of runs){const width=item.width*run.text.length/item.str.length;spans.push({text:run.text,x:(t[4]+item.width*fraction)/viewport.width,y:(t[5]-item.height)/viewport.height,width:width/viewport.width,height:item.height/viewport.height,color:run.color});fraction+=run.text.length/item.str.length;}
      }
      if(spans.some(s=>s.color==='unknown'&&s.text.trim()))result.warnings.push('第 '+n+' 页有文字颜色无法可靠对应，相关内容须人工校对。');
      if(!spans.some(s=>s.text.trim()))result.warnings.push('第 '+n+' 页无可提取文字；保留原页供人工或按需视觉辅助整理。');
      result.pages.push({page:n,width:viewport.width,height:viewport.height,spans,graphics});page.cleanup();
    }
    return result;
  }finally{await task.destroy();}
}
