import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { createServer } from 'node:http';
import { createApp } from './app.js';

if(existsSync('.env')) process.loadEnvFile('.env');
if(process.env.AI_PROVIDER && process.env.AI_PROVIDER!=='mock') throw new Error('第 1 阶段仅支持 AI_PROVIDER=mock，不会调用付费 API。');
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须为有效端口');
const runtime=createApp(resolve(process.env.DATA_DIR??'data'));
const server=createServer(runtime.app);
for(const folder of ['cmaps','standard_fonts','wasm']) runtime.app.use(`/pdf-resources/${folder}`,express.static(resolve('node_modules/pdfjs-dist',folder),{dotfiles:'deny',index:false}));
const dev=process.argv[1].endsWith('.ts');
if(dev) {
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true,hmr:{server}},appType:'spa'});
  runtime.app.use(vite.middlewares);
} else {
  if(!existsSync('dist/index.html'))throw new Error('请先执行 npm run build');
  runtime.app.use(express.static(resolve('dist')));
  runtime.app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));
}
runtime.app.use(runtime.errorHandler);
server.listen(port,'127.0.0.1',()=>console.log(`\n线代作业批改平台 2.5.0：http://127.0.0.1:${port}\n默认 Mock / 人工 · 数据保存在 ${runtime.store.dir}\n按 Ctrl+C 停止。\n`));
server.on('error',(e:NodeJS.ErrnoException)=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已占用；关闭旧服务，或在 .env 中更改 PORT。`:e.message);process.exit(1);});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close();process.exit(0);});
