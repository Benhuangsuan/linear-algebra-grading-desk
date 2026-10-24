import {testDirectory} from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {renderPdf} from '../server/ai/pdf.js';
test('7页本地视觉转换：完整页码、清晰尺寸、内容缓存及局部放大',async()=>{
  const dir=testDirectory('stage2-pdf-');
  const pdf=await PDFDocument.create();
  for(let n=1;n<=7;n++){const p=pdf.addPage([400,560]);p.drawText('Synthetic section '+(n%2+1)+', page '+n,{x:20,y:520});p.drawLine({start:{x:40,y:100},end:{x:150,y:200},thickness:2});}
  const handwriting=createCanvas(500,300);const pen=handwriting.getContext('2d');pen.fillStyle='white';pen.fillRect(0,0,500,300);pen.fillStyle='black';pen.font='italic 28px "Comic Sans MS"';pen.fillText('[ 1   2 ]',30,70);pen.fillText('[ 0   1 ]',30,115);pen.fillText('a. T   b. F   c. True / False',30,170);pen.font='26px "Microsoft YaHei"';pen.fillText('对 错 √ × ✓ ✗',30,220);pen.strokeStyle='red';pen.lineWidth=3;pen.beginPath();pen.moveTo(120,140);pen.lineTo(190,185);pen.moveTo(190,140);pen.lineTo(120,185);pen.stroke();
  const embedded=await pdf.embedPng(handwriting.toBuffer('image/png'));pdf.getPage(3).drawImage(embedded,{x:10,y:200,width:350,height:210});
  const bytes=await pdf.save();const pages=await renderPdf(bytes,dir);
  assert.deepEqual(pages.map(p=>p.page),[1,2,3,4,5,6,7]);assert.equal(pages[0].width,1200);assert.ok(pages.every(p=>p.data.startsWith('data:image/jpeg;base64,')&&p.data.length>1000));
  const decoded=await loadImage(Buffer.from(pages[3].data.split(',')[1],'base64'));const probe=createCanvas(decoded.width,decoded.height);const probeCtx=probe.getContext('2d');probeCtx.drawImage(decoded,0,0);const pixels=probeCtx.getImageData(0,0,decoded.width,decoded.height).data;let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>150&&pixels[i]>pixels[i+1]*1.5&&pixels[i]>pixels[i+2]*1.5)red++;assert.ok(red>100,'历史红笔像素应保留，不能以删红笔的方式损坏数学内容');
  const cacheFolder=join(dir,'pdf',readdirSync(join(dir,'pdf'))[0]);const before=statSync(join(cacheFolder,'1-0.jpg')).mtimeMs;
  const cached=await renderPdf(bytes,dir);assert.deepEqual(cached.map(p=>p.hash),pages.map(p=>p.hash));assert.equal(statSync(join(cacheFolder,'1-0.jpg')).mtimeMs,before);
  const zoom=await renderPdf(bytes,dir,{page:4,x:.1,y:.1,width:.5,height:.5});
  assert.equal(zoom.length,1);assert.equal(zoom[0].page,4);assert.equal(zoom[0].width,800);assert.equal(zoom[0].crop?.page,4);
});
