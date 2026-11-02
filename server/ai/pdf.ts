import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument,type PDFPageProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {Crop} from '../../shared/ai.js';
import {AiError} from './config.js';
export type PageImage={page:number;width:number;height:number;data:string;hash:string;crop?:Crop;overview?:boolean;tile?:{index:number;total:number}};
export const RENDER_VERSION=4;
export const IMAGE_EDGE=2400,JPEG_QUALITY=84;
export const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Region={x:number;y:number;width:number;height:number};
type Options={maxEdge?:number;expectedPages?:number};
const MAX_PIXELS=24_000_000,MAX_TILES=64,MAX_IMAGES=200;
export function completeImageCoverage(images:Omit<PageImage,'data'>[],pages:number,crop?:Crop){
  const expected=crop?[crop.page]:Array.from({length:pages},(_,i)=>i+1);
  if(images.some(i=>!expected.includes(i.page)))return false;
  return expected.every(page=>{
    const views=images.filter(i=>i.page===page);if(!views.length)return false;
    if(crop)return views.length===1&&JSON.stringify(views[0].crop)===JSON.stringify(crop);
    const tiles=views.filter(v=>v.tile);
    if(!tiles.length)return views.length===1&&!views[0].overview&&!views[0].crop;
    if(views.filter(v=>v.overview).length!==1||views.length!==tiles.length+1||tiles.some((t,i)=>t.tile!.total!==tiles.length||t.tile!.index!==i+1||!t.crop))return false;
    const xs=[...new Set([0,1,...tiles.flatMap(t=>[t.crop!.x,t.crop!.x+t.crop!.width])])].sort((a,b)=>a-b);
    return xs.slice(0,-1).every((x,i)=>{
      const mid=(x+xs[i+1])/2,spans=tiles.filter(t=>t.crop!.x<=mid&&t.crop!.x+t.crop!.width>=mid).map(t=>[t.crop!.y,t.crop!.y+t.crop!.height]).sort((a,b)=>a[0]-b[0]);let end=0;
      for(const [from,to]of spans){if(from>end+1e-6)return false;end=Math.max(end,to);}return end>=1-1e-6;
    });
  });
}
function spans(length:number,edge:number){
  if(length<=edge)return [[0,length]];
  const count=Math.ceil(length/(edge-256));
  if(count>MAX_TILES)throw new AiError('pdf_limit','页面过长或过宽，超出本地安全处理范围；请核对原稿或人工评分，未发送请求，不会视为漏做',false,{stage:'prepare'});
  return Array.from({length:count},(_,i)=>[Math.max(0,Math.floor(i*length/count)-128),Math.min(length,Math.ceil((i+1)*length/count)+128)]);
}
/** Covers the complete rotated viewport, with overlap at every internal boundary. */
export function pageRegions(width:number,height:number,maxEdge=8192):Region[]{
  if(![width,height,maxEdge].every(Number.isFinite)||width<=0||height<=0||maxEdge<1024)throw new AiError('pdf_limit','PDF 页面尺寸无效，请重新导出',false,{stage:'prepare'});
  const long=Math.max(width,height)/Math.min(width,height)>2;
  if(!long&&width<=maxEdge&&height<=maxEdge&&width*height<=MAX_PIXELS)return [];
  const edge=Math.min(4096,maxEdge,long?Math.max(1024,Math.min(width,height)*1.5):4096);
  const xs=spans(width,edge),ys=spans(height,edge);
  if(xs.length*ys.length>MAX_TILES)throw new AiError('pdf_limit','单页需要的分区超过本地安全上限；请核对原稿或人工评分，未发送请求，不会视为漏做',false,{stage:'prepare'});
  return ys.flatMap(([y,bottom])=>xs.map(([x,right])=>({x,y,width:right-x,height:bottom-y})));
}
async function draw(page:PDFPageProxy,scale:number,region?:Region){
  const original=page.getViewport({scale});const requested=region??{x:0,y:0,width:original.width,height:original.height};
  // Render the region directly at its delivery resolution, never allocate a giant full-page canvas.
  const factor=Math.min(1,IMAGE_EDGE/Math.max(requested.width,requested.height));
  const viewport=page.getViewport({scale:scale*factor});const area={x:requested.x*factor,y:requested.y*factor,width:requested.width*factor,height:requested.height*factor};
  const width=Math.max(1,Math.ceil(area.width-1e-7)),height=Math.max(1,Math.ceil(area.height-1e-7));
  if(width>8192||height>8192||width*height>MAX_PIXELS)throw new AiError('pdf_limit','局部区域超过安全处理范围，请缩小放大范围或人工评分；未发送请求',false,{stage:'prepare'});
  const canvas=createCanvas(width,height);
  await page.render({canvas:canvas as unknown as HTMLCanvasElement,canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport,transform:[1,0,0,1,-area.x,-area.y]}).promise;
  let jpeg=await canvas.encode('jpeg',JPEG_QUALITY);
  if(jpeg.length>4*1024*1024)jpeg=await canvas.encode('jpeg',80);
  if(jpeg.length>6*1024*1024)throw new AiError('pdf_limit','原第 '+page.pageNumber+' 页图像优化后仍过大，请核对原稿或人工评分；未发送请求，不会视为漏做',false,{stage:'prepare'});
  return {width,height,jpeg};
}
export async function renderPdf(bytes:Uint8Array,cacheRoot:string,crop?:Crop,{maxEdge=8192,expectedPages}:Options={}):Promise<PageImage[]> {
  const key=hash(Buffer.concat([Buffer.from(bytes),Buffer.from(JSON.stringify({renderer:RENDER_VERSION,edge:IMAGE_EDGE,quality:JPEG_QUALITY,crop,maxEdge}))]));
  const folder=join(cacheRoot,'pdf',key);await mkdir(folder,{recursive:true});
  try{
    const manifest=JSON.parse(await readFile(join(folder,'pages.json'),'utf8')) as (Omit<PageImage,'data'>&{file:string})[];
    if(!Array.isArray(manifest)||!manifest.length||manifest.length>MAX_IMAGES||manifest.some((p,i)=>p.file!==p.page+'-'+i+'.jpg'||![p.width,p.height].every(n=>Number.isFinite(n)&&n>0&&n<=Math.min(maxEdge,IMAGE_EDGE)))||!completeImageCoverage(manifest,expectedPages??Math.max(...manifest.map(p=>p.page)),crop))throw new Error('invalid cache');
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
        const native=page.getViewport({scale:1});
        const scale=crop?4:Math.min(3,Math.max(1,4096/Math.max(native.width,native.height)));
        const viewport=page.getViewport({scale});
        const long=Math.max(viewport.width,viewport.height)/Math.min(viewport.width,viewport.height)>2;
        const regions=crop?[]:pageRegions(viewport.width,viewport.height,long?maxEdge:Math.max(viewport.width,viewport.height)<=IMAGE_EDGE*1.1?maxEdge:Math.min(maxEdge,IMAGE_EDGE));
        if(images.length+1+regions.length>MAX_IMAGES)throw new AiError('pdf_limit','原第 '+n+' 页起需要的图像分区超过本地安全上限，请人工核对或重新导出该文件；未省略页面、未发送请求，不会视为漏做',false,{stage:'prepare'});
        const add=async(scale:number,region?:Region,extra:Partial<PageImage>={})=>{
          const {width,height,jpeg}=await draw(page,scale,region);const file=n+'-'+images.length+'.jpg';await writeFile(join(folder,file),jpeg);
          images.push({page:n,width,height,data:'data:image/jpeg;base64,'+jpeg.toString('base64'),hash:hash(jpeg),...extra});
        };
        if(crop){if(viewport.width*crop.width>maxEdge||viewport.height*crop.height>maxEdge)throw new AiError('pdf_limit','选定放大区域仍过大，请缩小范围或人工核对；未为此发送付费请求',false,{stage:'prepare'});await add(4,{x:viewport.width*crop.x,y:viewport.height*crop.y,width:viewport.width*crop.width,height:viewport.height*crop.height},{crop});}
        else if(regions.length){
          await add(scale*Math.min(1,IMAGE_EDGE/Math.max(viewport.width,viewport.height)),undefined,{overview:true});
          for(const [index,region] of regions.entries())await add(scale,region,{crop:{page:n,x:region.x/viewport.width,y:region.y/viewport.height,width:region.width/viewport.width,height:region.height/viewport.height},tile:{index:index+1,total:regions.length}});
        }else await add(scale);
      }catch(e){if(e instanceof AiError&&!e.message.includes('原第'))throw new AiError(e.code,'原第 '+n+' 页：'+e.message,e.retryable,e.diagnostic);throw e;}finally{page.cleanup();}
    }
    if(expectedPages!==undefined&&expectedPages!==pdf.numPages||!completeImageCoverage(images,pdf.numPages,crop))throw new AiError('pdf_coverage','PDF 原页或区域覆盖不完整，未发送请求，不会判漏做；请检查原稿',false,{stage:'prepare'});
    const manifest=images.map(({data,...p},i)=>({...p,file:p.page+'-'+i+'.jpg'}));
    const temp=join(folder,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(manifest));await rename(temp,join(folder,'pages.json'));
    return images;
  }catch(e){if(e instanceof AiError)throw e;throw new AiError('pdf_render','PDF 本地渲染失败，请检查原稿或重新导出；未调用付费 API',false,{stage:'prepare'});}
  finally{await task.destroy().catch(()=>{});}
}
