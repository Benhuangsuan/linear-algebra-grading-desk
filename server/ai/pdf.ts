import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument,type PDFPageProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {Crop} from '../../shared/ai.js';
import {AiError} from './config.js';
export type PageImage={page:number;width:number;height:number;data:string;hash:string;crop?:Crop;overview?:boolean;tile?:{index:number;total:number}};
export const RENDER_VERSION=3;
export const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Region={x:number;y:number;width:number;height:number};
type Options={maxEdge?:number};
const MAX_PIXELS=24_000_000,MAX_TILES=64,MAX_IMAGES=200;
function spans(length:number,edge:number){
  if(length<=edge)return [[0,length]];
  const count=Math.ceil(length/(edge-256));
  if(count>MAX_TILES)throw new AiError('pdf_limit','PDF 页面过长或过宽，请在本地分段导出；未调用付费 API',false,{stage:'prepare'});
  return Array.from({length:count},(_,i)=>[Math.max(0,Math.floor(i*length/count)-128),Math.min(length,Math.ceil((i+1)*length/count)+128)]);
}
/** Covers the complete rotated viewport, with overlap at every internal boundary. */
export function pageRegions(width:number,height:number,maxEdge=8192):Region[]{
  if(![width,height,maxEdge].every(Number.isFinite)||width<=0||height<=0||maxEdge<1024)throw new AiError('pdf_limit','PDF 页面尺寸无效，请重新导出',false,{stage:'prepare'});
  const long=Math.max(width,height)/Math.min(width,height)>2;
  if(!long&&width<=maxEdge&&height<=maxEdge&&width*height<=MAX_PIXELS)return [];
  const edge=Math.min(4096,maxEdge,long?Math.max(1024,Math.min(width,height)*1.5):4096);
  const xs=spans(width,edge),ys=spans(height,edge);
  if(xs.length*ys.length>MAX_TILES)throw new AiError('pdf_limit','PDF 单页需要过多分区，请在本地分段导出；未调用付费 API',false,{stage:'prepare'});
  return ys.flatMap(([y,bottom])=>xs.map(([x,right])=>({x,y,width:right-x,height:bottom-y})));
}
async function draw(page:PDFPageProxy,scale:number,region?:Region){
  const viewport=page.getViewport({scale});const area=region??{x:0,y:0,width:viewport.width,height:viewport.height};
  const width=Math.max(1,Math.ceil(area.width-1e-7)),height=Math.max(1,Math.ceil(area.height-1e-7));
  if(width>8192||height>8192||width*height>MAX_PIXELS)throw new AiError('pdf_limit','PDF 局部区域仍过大，请缩小放大范围或在本地分段导出',false,{stage:'prepare'});
  const canvas=createCanvas(width,height);
  await page.render({canvas:canvas as unknown as HTMLCanvasElement,canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport,transform:[1,0,0,1,-area.x,-area.y]}).promise;
  return {width,height,jpeg:await canvas.encode('jpeg',92)};
}
export async function renderPdf(bytes:Uint8Array,cacheRoot:string,crop?:Crop,{maxEdge=8192}:Options={}):Promise<PageImage[]> {
  const key=hash(Buffer.concat([Buffer.from(bytes),Buffer.from(JSON.stringify({renderer:RENDER_VERSION,scale:3,crop,maxEdge}))]));
  const folder=join(cacheRoot,'pdf',key);await mkdir(folder,{recursive:true});
  try{
    const manifest=JSON.parse(await readFile(join(folder,'pages.json'),'utf8')) as (Omit<PageImage,'data'>&{file:string})[];
    if(!Array.isArray(manifest)||!manifest.length||manifest.length>MAX_IMAGES||manifest.some(p=>!/^\d+-\d+\.jpg$/.test(p.file)||![p.width,p.height].every(n=>Number.isFinite(n)&&n>0&&n<=maxEdge)))throw new Error('invalid cache');
    return await Promise.all(manifest.map(async ({file,...p})=>{const bytes=await readFile(join(folder,file));if(hash(bytes)!==p.hash)throw new Error('invalid cache image');return {...p,data:'data:image/jpeg;base64,'+bytes.toString('base64')};}));
  }catch{/* Missing or corrupt cache is rebuilt from the immutable original. */}
  const task=getDocument({data:new Uint8Array(bytes),standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/',useSystemFonts:true,verbosity:0});
  try{
    const pdf=await task.promise;const images:PageImage[]=[];
    if(crop&&(crop.page<1||crop.page>pdf.numPages||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>1.00001||crop.y+crop.height>1.00001))throw new AiError('pdf_crop','放大区域或原页码无效',false,{stage:'prepare'});
    for(let n=1;n<=pdf.numPages;n++){
      if(crop&&n!==crop.page)continue;
      const page=await pdf.getPage(n);
      try{
        const viewport=page.getViewport({scale:crop?4:3});
        const regions=crop?[]:pageRegions(viewport.width,viewport.height,maxEdge);
        if(images.length+1+regions.length>MAX_IMAGES)throw new AiError('pdf_limit','PDF 图像分区过多，请在本地分段导出；未省略页面或调用付费 API',false,{stage:'prepare'});
        const add=async(scale:number,region?:Region,extra:Partial<PageImage>={})=>{
          const {width,height,jpeg}=await draw(page,scale,region);const file=n+'-'+images.length+'.jpg';await writeFile(join(folder,file),jpeg);
          images.push({page:n,width,height,data:'data:image/jpeg;base64,'+jpeg.toString('base64'),hash:hash(jpeg),...extra});
        };
        if(crop){if(viewport.width*crop.width>maxEdge||viewport.height*crop.height>maxEdge)throw new AiError('pdf_limit','选定放大区域仍过大，请缩小范围或人工核对；未为此发送付费请求',false,{stage:'prepare'});await add(4,{x:viewport.width*crop.x,y:viewport.height*crop.y,width:viewport.width*crop.width,height:viewport.height*crop.height},{crop});}
        else if(regions.length){
          await add(3*Math.min(1,Math.min(maxEdge,4096)/Math.max(viewport.width,viewport.height),Math.sqrt(MAX_PIXELS/(viewport.width*viewport.height))),undefined,{overview:true});
          for(const [index,region] of regions.entries())await add(3,region,{crop:{page:n,x:region.x/viewport.width,y:region.y/viewport.height,width:region.width/viewport.width,height:region.height/viewport.height},tile:{index:index+1,total:regions.length}});
        }else await add(3);
      }finally{page.cleanup();}
    }
    const manifest=images.map(({data,...p},i)=>({...p,file:p.page+'-'+i+'.jpg'}));
    const temp=join(folder,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(manifest));await rename(temp,join(folder,'pages.json'));
    return images;
  }catch(e){if(e instanceof AiError)throw e;throw new AiError('pdf_render','PDF 本地渲染失败，请检查原稿或重新导出；未调用付费 API',false,{stage:'prepare'});}
  finally{await task.destroy().catch(()=>{});}
}
