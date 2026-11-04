import express from 'express';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {uxHarness} from '../tests/grading-ux-fixtures.js';
import type {StoredFile} from '../shared/domain.js';

// Manual review uses the same synthetic fixtures and injected mock as browser tests.
// It never reads environment credentials and cannot fall through to a paid API.
const h=await uxHarness();
await h.upload('student','SyntheticBroken.pdf');
const s=h.submissions()[1],f=h.runtime.store.get<StoredFile>('files',s.fileId)!;
writeFileSync(join(h.runtime.store.uploads,f.diskName),'broken synthetic PDF');
h.runtime.app.use(express.static(resolve('dist')));
h.runtime.app.get('/{*path}',(_r,res)=>res.sendFile(resolve('dist/index.html')));
const url=h.base+'/?course='+h.assignment.courseId+'&assignment='+h.assignment.id;
writeFileSync(resolve('codex工作区/review-preview.json'),JSON.stringify({pid:process.pid,url,dataDir:h.dir,provider:'injected mock only'},null,2));
console.log('合成资料与模拟 API 验收：'+url);
console.log('此验收服务不调用真实 DeepSeek；按 Ctrl+C 关闭。');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void h.close().finally(()=>process.exit(0));});
