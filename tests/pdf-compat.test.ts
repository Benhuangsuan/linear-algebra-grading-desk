import {testDirectory} from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {PDFDocument,rgb,degrees} from 'pdf-lib';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {pageRegions,renderPdf} from '../server/ai/pdf.js';
import {AiError,providerConfig} from '../server/ai/config.js';
import {complete} from '../server/ai/transport.js';

test('2.4 分区覆盖完整长页/横页/巨幅页，内部重叠且画布有界；极端页在本地明确拦截',()=>{
  for(const [width,height] of [[2448,5768.106],[6000,1200],[9000,9000],[1200,18000]]){
    const regions=pageRegions(width,height,4096);assert.ok(regions.length>1&&regions.length<=64);
    for(const r of regions)assert.ok(r.width<=4096&&r.height<=4096&&r.width*r.height<=24_000_000);
    const xs=[...new Set(regions.map(r=>r.x))].sort((a,b)=>a-b),ys=[...new Set(regions.map(r=>r.y))].sort((a,b)=>a-b);
    assert.equal(xs[0],0);assert.equal(ys[0],0);assert.ok(Math.abs(Math.max(...regions.map(r=>r.x+r.width))-width)<.01);assert.ok(Math.abs(Math.max(...regions.map(r=>r.y+r.height))-height)<.01);
    for(let i=1;i<xs.length;i++)assert.ok(regions.find(r=>r.x===xs[i-1])!.x+regions.find(r=>r.x===xs[i-1])!.width>xs[i]);
    for(let i=1;i<ys.length;i++)assert.ok(regions.find(r=>r.y===ys[i-1])!.y+regions.find(r=>r.y===ys[i-1])!.height>ys[i]);
  }
  assert.deepEqual(pageRegions(1200,1680,4096),[]);
  assert.throws(()=>pageRegions(1000,1e9,4096),e=>e instanceof AiError&&e.code==='pdf_limit');
  assert.throws(()=>pageRegions(NaN,1000),AiError);
});

test('2.4 非标准单页与旋转混合尺寸 PDF：页首/页尾像素保留，缓存与原页码不变',async()=>{
  const dir=testDirectory('v2.4-pdf-');const pdf=await PDFDocument.create();const p=pdf.addPage([816,1922.702]);
  p.drawRectangle({x:10,y:1882.702,width:40,height:30,color:rgb(1,0,0)});p.drawRectangle({x:10,y:10,width:40,height:30,color:rgb(0,0,1)});p.drawText('Synthetic matrix [1 2; 0 1]',{x:80,y:1900,size:14});p.drawText('40. a T / b F',{x:80,y:20,size:14});
  const wide=pdf.addPage([400,2000]);wide.setRotation(degrees(90));wide.drawText('Rotated synthetic page',{x:20,y:1000,size:18});
  const bytes=await pdf.save();const images=await renderPdf(bytes,dir,undefined,{maxEdge:4096});const first=images.filter(p=>p.page===1);assert.equal(first.length,3);assert.equal(first[0].overview,true);assert.equal(first[1].tile?.index,1);assert.equal(first[2].tile?.total,2);
  assert.ok(images.every(p=>p.page===1||p.page===2));assert.ok(images.every(p=>p.width<=4096&&p.height<=4096));assert.ok(images.some(p=>p.page===2&&p.tile));
  async function pixel(image:typeof first[number],x:number,y:number){const decoded=await loadImage(Buffer.from(image.data.split(',')[1],'base64'));const canvas=createCanvas(decoded.width,decoded.height);const ctx=canvas.getContext('2d');ctx.drawImage(decoded,0,0);return ctx.getImageData(x,y,1,1).data;}
  const top=await pixel(first[1],60,60),bottom=await pixel(first[2],60,first[2].height-60);assert.ok(top[0]>200&&top[2]<40);assert.ok(bottom[2]>200&&bottom[0]<40);
  assert.deepEqual((await renderPdf(bytes,dir,undefined,{maxEdge:4096})).map(p=>p.hash),images.map(p=>p.hash));
});

test('2.4 巨幅原页局部放大直接绘制区域，不创建整个超大画布；请求超限不调用 fetch',async()=>{
  const pdf=await PDFDocument.create();const p=pdf.addPage([500,5000]);p.drawRectangle({x:0,y:0,width:100,height:100,color:rgb(0,0,1)});
  const dir=testDirectory('v2.4-crop-');const images=await renderPdf(await pdf.save(),dir,{page:1,x:0,y:.98,width:.2,height:.02});assert.equal(images.length,1);assert.equal(images[0].width,400);assert.equal(images[0].height,400);assert.equal(images[0].page,1);
  let calls=0;const c=providerConfig('deepseek',{AI_ALLOW_PAID:'true',DEEPSEEK_API_KEY:'fixture-credential'});
  await assert.rejects(complete(c,[{role:'user',content:Array.from({length:601},()=>({type:'image_url' as const,image_url:{url:'data:image/jpeg;base64,fixture',detail:'high' as const}}))}],async()=>{calls++;throw new Error('must not call');}),e=>e instanceof AiError&&e.code==='input_limit');assert.equal(calls,0);
});
