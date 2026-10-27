import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { inspectFile, normalizeFilename, inferIdentity } from './files.js';
import { MockProvider, manualGrade } from './provider.js';
import { configSchema, judgmentSchema, validateRows, configurationWarnings, type Assignment, type Course, type Submission, type StoredFile, type History } from '../shared/domain.js';
import {courseConfig,parseCourseMaterials} from '../shared/course.js';
import { inferredNameCorrection } from './identity.js';
import { gradesCsv } from './grades-export.js';
import { AiService,type AiDependencies } from './ai/service.js';
import {aiRoutes} from './ai/routes.js';
import {AiError} from './ai/config.js';
import {parseReferenceMaterials} from './reference-parser.js';
import {renderPdf} from './ai/pdf.js';

class HttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
function fail(status:number,message:string):never {throw new HttpError(status,message);}
const now=()=>new Date().toISOString();
export function createApp(dataDir:string,aiDependencies:AiDependencies={}) {
  const app=express();const store=new Store(dataDir);const provider=new MockProvider();
  let working=false;let closed=false;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host??'')) return res.status(403).json({error:'仅允许本机地址访问'});
    const origin=req.headers.origin;
    if(origin && origin!==`http://${req.headers.host}`) return res.status(403).json({error:'拒绝跨站请求，请从本机工作台操作'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    if(req.path.startsWith('/api')) res.setHeader('Cache-Control','no-store');
    if(['POST','PUT','PATCH'].includes(req.method) && !req.is('application/json') && !req.is('multipart/form-data')) return res.status(415).json({error:'请求须使用 JSON 或文件上传格式'});
    next();
  });
  app.use(express.json({limit:'3mb'}));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024,files:1,fields:8}});
  const assignment=(id:string)=>store.get<Assignment>('assignments',id)??fail(404,'作业不存在');
  const submission=(id:string)=>store.get<Submission>('submissions',id)??fail(404,'学生提交不存在');
  const busy=(s:Submission)=>{if(['queued','processing'].includes(s.status)) fail(409,'正在排队或处理中，请等待后再修改');};
  function save(s:Submission,action:string) {const next={...s,revision:s.revision+1,updatedAt:now()};store.transaction(()=>{store.history(next,action);store.put('submissions',next);});return next;}
  const ai=new AiService(store,save,aiDependencies);
  app.use('/api',aiRoutes(ai));
  // Preserve deliberate identity edits, including edits that happen to equal an old inferred name.
  const renamed=new Set(store.all<History>('history').filter(h=>h.action==='修正学生信息').map(h=>h.submissionId));
  store.transaction(()=>{
    for(const s of store.all<Submission>('submissions')) {
      if(renamed.has(s.id))continue;
      const file=store.get<StoredFile>('files',s.fileId);
      const corrected=file?inferredNameCorrection(file.name,s.studentName):null;
      if(corrected)save({...s,studentName:corrected},'修正旧版文件名姓名识别');
    }
  });
  async function drain() {
    if(working||closed)return;working=true;
    try {
      while(!closed) {
        const queued=store.all<Submission>('submissions').find(s=>s.status==='queued');if(!queued)break;
        let s=save({...queued,status:'processing',error:''},'开始 Mock 演示');
        try {
          const a=assignment(s.assignmentId);const file=store.get<StoredFile>('files',s.fileId)??fail(404,'PDF 不存在');
          const grade=await provider.grade(a,file);
          if(closed)break;
          // Deletion during an asynchronous provider call must never resurrect a record.
          if(!store.get<Submission>('submissions',s.id))continue;
          s=save({...s,status:'review',grade,review:structuredClone(grade.rows),error:''},'保存 Mock 原始建议');
        } catch(e) {if(!closed&&store.get<Submission>('submissions',s.id)) save({...s,status:'failed',error:e instanceof Error?e.message:'任务失败'},'Mock 失败');}
      }
    } finally {working=false;}
  }
  app.get('/api/state',(_req,res)=>res.json(store.state()));
  app.get('/api/health',(_req,res)=>{const attempts=store.all('ai_calls').length;res.json({ok:true,version:'2.6.0',provider:'mock',paidCalls:attempts?null:0,cloudAttempts:attempts,concurrency:1});});
  app.post('/api/courses',(req,res)=>{
    const {name}=z.object({name:z.string().trim().min(1).max(200)}).parse(req.body);
    const c:Course={id:randomUUID(),name,createdAt:now()};store.put('courses',c);res.status(201).json(c);
  });
  app.patch('/api/courses/:id',(req,res)=>{const c=store.get<Course>('courses',req.params.id)??fail(404,'课程不存在');const {name}=z.object({name:z.string().trim().min(1).max(200)}).parse(req.body);store.put('courses',{...c,name});res.json({ok:true});});
  app.delete('/api/courses/:id',async(req,res)=>{
    const id=req.params.id;const ids=store.all<Assignment>('assignments').filter(a=>a.courseId===id).map(a=>a.id);
    const files=store.all<StoredFile>('files').filter(f=>ids.includes(f.assignmentId));
    if(store.all<Submission>('submissions').some(s=>ids.includes(s.assignmentId)&&['queued','processing'].includes(s.status)))fail(409,'课程中有正在处理的任务');
    store.delete('courses',id);await removeFiles(files);res.json({ok:true});
  });
  const assignmentBody=z.object({courseId:z.string(),title:z.string().trim().min(1).max(200),description:z.string().max(20000),scope:z.string().max(2000),config:configSchema,copyFrom:z.string().optional()});
  app.post('/api/assignments',(req,res)=>{
    const b=assignmentBody.parse(req.body);if(!store.get('courses',b.courseId))fail(404,'课程不存在');
    const from=b.copyFrom?assignment(b.copyFrom):null;
    if(from && from.courseId!==b.courseId)fail(400,'只能复制同一课程的配置');
    const a:Assignment={id:randomUUID(),courseId:b.courseId,title:b.title,description:b.description,scope:from?.scope??b.scope,archived:false,version:1,config:from?{...from.config,confirmed:false}:b.config,createdAt:now()};
    store.transaction(()=>{store.put('assignments',a);store.put('versions',{id:`${a.id}:1`,assignmentId:a.id,version:1,config:a.config,at:now()});});res.status(201).json(a);
  });
  app.put('/api/assignments/:id',(req,res)=>{
    const a=assignment(req.params.id);const b=z.object({title:z.string().trim().min(1).max(200),description:z.string().max(20000),scope:z.string().max(2000),config:configSchema,version:z.number().int(),regradeUnconfirmed:z.boolean().default(false)}).parse(req.body);
    if(b.version!==a.version)fail(409,'规则已被其他页面修改，请刷新后重新编辑');
    for(const q of b.config.questions)for(const source of [...(q.referenceSources??[]),...(q.children??[]).flatMap(c=>c.referenceSources??[])]){
      const f=store.get<StoredFile>('files',source.fileId);
      if(!f||f.assignmentId!==a.id||f.kind==='student'||f.mime!=='application/pdf'||source.page>(f.pages??0))fail(400,`${q.section} / ${q.number} 的参考页已失效或不属于本作业，请更换或移除后再保存。`);
    }
    if(store.all<Submission>('submissions').some(s=>s.assignmentId===a.id&&['queued','processing'].includes(s.status)))fail(409,'请等待当前批改队列结束后修改规则');
    const changed=JSON.stringify(a.config)!==JSON.stringify(b.config);const updated={...a,...b,version:a.version+(changed?1:0)};
    store.transaction(()=>{store.put('assignments',updated);if(changed)store.put('versions',{id:`${a.id}:${updated.version}`,assignmentId:a.id,version:updated.version,config:b.config,at:now()});
      if(b.regradeUnconfirmed) {
        if(!b.config.confirmed||!b.config.questions.length)fail(400,'重算前请确认题目清单');
        for(const s of store.all<Submission>('submissions').filter(s=>s.assignmentId===a.id&&s.status!=='confirmed')) save({...s,status:'queued',error:''},'明确请求按新规则重新 Mock');
      }
    });if(b.regradeUnconfirmed)void drain();res.json(updated);
  });
  app.patch('/api/assignments/:id',(req,res)=>{const a=assignment(req.params.id);const {archived}=z.object({archived:z.boolean()}).parse(req.body);store.put('assignments',{...a,archived});res.json({ok:true});});
  app.delete('/api/assignments/:id',async(req,res)=>{const a=assignment(req.params.id);if(store.all<Submission>('submissions').some(s=>s.assignmentId===a.id&&['queued','processing'].includes(s.status)))fail(409,'有正在处理的任务');const files=store.all<StoredFile>('files').filter(f=>f.assignmentId===a.id);store.delete('assignments',a.id);await removeFiles(files);res.json({ok:true});});
  app.get('/api/assignments/:id/versions',(req,res)=>res.json(store.all<{assignmentId:string}>('versions').filter(v=>v.assignmentId===req.params.id)));
  app.post('/api/assignments/:id/files',upload.single('file'),async(req,res)=>{
    const a=assignment(String(req.params.id));if(a.archived)fail(409,'请先取消归档');
    const file=req.file??fail(400,'请选择文件');const kind=z.enum(['student','reference','prompt']).parse(req.body.kind);
    const name=normalizeFilename(file.originalname);
    const duplicate=store.all<StoredFile>('files').find(f=>f.assignmentId===a.id&&f.kind===kind&&f.name===name);
    if(duplicate && req.body.duplicate!=='keep')fail(409,'同名文件已存在。可跳过，或选择作为新提交保留两份（原记录不会覆盖）。');
    let info:Awaited<ReturnType<typeof inspectFile>>;
    try {info=await inspectFile(file.buffer,name,kind==='student');}catch(e){fail(400,e instanceof Error?e.message:'文件无法读取');}
    const id=randomUUID();
    const f:StoredFile={id,assignmentId:a.id,kind,name,diskName:id+info.ext,mime:info.mime,size:file.size,pages:info.pages,text:info.text,warning:info.warning,createdAt:now(),referenceLayout:info.referenceLayout};
    const path=join(store.uploads,f.diskName);await writeFile(path,file.buffer,{flag:'wx'});
    try {store.transaction(()=>{store.put('files',f);if(kind==='student')store.put('submissions',{id:randomUUID(),assignmentId:a.id,fileId:id,...inferIdentity(name),status:'uploaded',grade:null,review:null,manualReport:'',reportBase:'',error:'',revision:0,updatedAt:now()} satisfies Submission);});}
    catch(e){await unlink(path);throw e;}
    res.status(201).json(f);
  });
  app.get('/api/files/:id/content',(req,res)=>{
    const f=store.get<StoredFile>('files',req.params.id)??fail(404,'文件不存在');
    if(!/^[a-f0-9-]+\.(pdf|docx)$/.test(f.diskName))fail(400,'无效文件路径');
    res.setHeader('Content-Type',f.mime);res.setHeader('Content-Disposition',`${f.mime==='application/pdf'?'inline':'attachment'}; filename="document${f.mime==='application/pdf'?'.pdf':'.docx'}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(resolve(store.uploads,f.diskName));
  });
  app.delete('/api/files/:id',async(req,res)=>{const f=store.get<StoredFile>('files',req.params.id)??fail(404,'文件不存在');const s=store.all<Submission>('submissions').find(s=>s.fileId===f.id);if(s)busy(s);store.delete('files',f.id);await removeFiles([f]);res.json({ok:true});});
  app.get('/api/files/:id/pages/:page',async(req,res)=>{
    const f=store.get<StoredFile>('files',req.params.id)??fail(404,'参考材料不存在');const page=Number(req.params.page);
    if(f.kind==='student'||f.mime!=='application/pdf'||!/^[a-f0-9-]+\.pdf$/.test(f.diskName)||!Number.isInteger(page)||page<1||page>(f.pages??0))fail(400,'参考材料或来源页无效');
    const images=await renderPdf(await readFile(join(store.uploads,f.diskName)),join(store.dir,'ai-cache'),undefined,{maxEdge:4096});
    const image=images.find(p=>p.page===page)??fail(400,'来源页图像缺失，请对照原件人工检查');
    res.type('image/jpeg').send(Buffer.from(image.data.split(',')[1],'base64'));
  });
  app.get('/api/assignments/:id/parse-preview',(req,res)=>{
    const a=assignment(req.params.id);const files=store.all<StoredFile>('files').filter(f=>f.assignmentId===req.params.id&&f.kind!=='student');
    const parsed=parseReferenceMaterials(files,a.scope);res.json({questions:parsed.questions,warnings:['本地候选须对照原页校对，公式文本不能替代数学排版。',...parsed.warnings,...files.map(f=>f.warning).filter(Boolean)]});
  });
  app.post('/api/assignments/:id/prepare',async(req,res)=>{
    const a=assignment(req.params.id);const b=z.object({scope:z.string().max(2000),sourceText:z.string().max(100000).default(''),strategy:z.enum(['auto','black-red','text']).default('auto')}).parse(req.body);
    const files=store.all<StoredFile>('files').filter(f=>f.assignmentId===a.id&&f.kind!=='student');
    const texts:string[]=[];const warnings:string[]=[];
    for(let f of files){
      if(!f.referenceLayout&&f.mime==='application/pdf'&&/^[a-f0-9-]+\.pdf$/.test(f.diskName)){
        const info=await inspectFile(await readFile(join(store.uploads,f.diskName)),f.name,false);
        f={...f,text:info.text,warning:info.warning,referenceLayout:info.referenceLayout};store.put('files',f);
      }
      texts.push(f.text);if(!f.text.trim())warnings.push(`${f.name}：没有识别到题号，请补充清单。`);
    }
    try {
      const materials=files.map(f=>store.get<StoredFile>('files',f.id)!);const parsed=parseReferenceMaterials(materials,b.scope,b.strategy);
      const extra=parseCourseMaterials([b.sourceText],b.scope);
      const questions=[...parsed.questions,...extra.filter(q=>!parsed.questions.some(p=>p.section===q.section&&p.number===q.number&&p.part===q.part))];
      const materialCounts=materials.map(f=>({fileId:f.id,name:f.name,questions:parseReferenceMaterials([f],b.scope,b.strategy).questions.length}));
      res.json({config:{...courseConfig(questions),sourceText:b.sourceText},warnings:[...warnings,...parsed.warnings],materialCounts});
    }catch(e){fail(400,e instanceof Error?e.message:'题目清单生成失败');}
  });
  app.post('/api/assignments/:id/queue',(req,res)=>{
    const a=assignment(req.params.id);const b=z.object({ids:z.array(z.string()).min(1).max(50),acknowledged:z.literal(true),replaceDraft:z.boolean().default(false)}).parse(req.body);
    if(a.archived)fail(409,'请先取消归档');if(!a.config.confirmed||!a.config.questions.length)fail(400,'请先人工确认题目清单');
    const selected=[...new Set(b.ids)].map(id=>submission(id));
    for(const s of selected){if(s.assignmentId!==a.id)fail(400,'提交不属于此作业');if(s.status==='confirmed')fail(409,'已确认成绩受保护，请先明确重新打开审核');busy(s);if(s.review && !b.replaceDraft)fail(409,'存在人工草稿，须明确确认重新生成。原记录会保留在历史中。');}
    store.transaction(()=>selected.forEach(s=>save({...s,status:'queued',error:''},'加入 Mock 队列')));void drain();res.json({queued:selected.length,paidCalls:0,warnings:configurationWarnings(a.config)});
  });
  app.post('/api/submissions/:id/manual',(req,res)=>{
    const s=submission(req.params.id);busy(s);if(s.status==='confirmed')fail(409,'请先重开审核');const a=assignment(s.assignmentId);
    if(!a.config.confirmed||!a.config.questions.length)fail(400,'请先确认题目清单');
    if(s.grade) return res.json(s);
    const grade=manualGrade(a);res.json(save({...s,status:'review',grade,review:structuredClone(grade.rows)},'开始纯人工评分'));
  });
  app.patch('/api/submissions/:id/identity',(req,res)=>{const s=submission(req.params.id);busy(s);const b=z.object({studentName:z.string().trim().max(200),studentId:z.string().trim().max(100)}).parse(req.body);res.json(save({...s,...b},'修正学生信息'));});
  app.put('/api/submissions/:id/review',(req,res)=>{
    const s=submission(req.params.id);busy(s);if(s.status==='confirmed')fail(409,'成绩已确认，请先重开审核');
    const b=z.object({revision:z.number().int(),rows:z.array(judgmentSchema).max(300),manualReport:z.string().max(50000),reportBase:z.string().max(50000),confirm:z.boolean()}).parse(req.body);
    if(b.revision!==s.revision)fail(409,'记录已更新，请刷新后重新编辑，避免覆盖其他页面的修改');
    const grade=s.grade??fail(400,'请先进入人工评分或 Mock 演示');const f=store.get<StoredFile>('files',s.fileId)??fail(404,'PDF 不存在');
    const errors=validateRows(grade.config,b.rows,f.pages??1,b.confirm);
    if(b.confirm) {
      if(!grade.config.confirmed) errors.push('请先确认规则');
      if(grade.config.mode==='points'&&grade.config.questions.some(q=>q.maxPoints===null))errors.push('逐题赋分模式须补齐各题满分');
      if(grade.config.questions.some(q=>q.required&&q.missingPenalty===null))errors.push('必做题须显式配置漏做扣分（可为 0）');
    }
    if(errors.length)fail(400,errors.join('；'));
    res.json(save({...s,review:b.rows,manualReport:b.manualReport,reportBase:b.reportBase,status:b.confirm?'confirmed':'review'},b.confirm?'人工确认最终成绩':'保存人工审核草稿'));
  });
  app.post('/api/submissions/:id/reopen',(req,res)=>{const s=submission(req.params.id);if(s.status!=='confirmed')fail(400,'当前记录不是已确认状态');res.json(save({...s,status:'review'},'明确重新打开审核'));});
  app.get('/api/submissions/:id/history',(req,res)=>{submission(req.params.id);res.json(store.all<{submissionId:string}>('history').filter(h=>h.submissionId===req.params.id).reverse());});
  app.get('/api/assignments/:id/export',(req,res)=>{
    const a=assignment(req.params.id);
    const submissions=store.all<Submission>('submissions').filter(s=>s.assignmentId===a.id);
    res.setHeader('Content-Disposition',"attachment; filename=grades.csv");res.type('text/csv').send(gradesCsv(submissions));
  });
  async function removeFiles(files:StoredFile[]) {for(const f of files){try {await unlink(join(store.uploads,f.diskName));}catch(e){if(!(e instanceof Error && 'code'in e && e.code==='ENOENT'))console.error('清理已删除文件失败，请检查 data/uploads 目录权限。');}}}
  const handler:ErrorRequestHandler=(error:unknown,_req,res,_next)=>{
    if(error instanceof AiError)return void res.status(400).json({error:error.message,code:error.code});
    if(error instanceof ZodError)return void res.status(400).json({error:error.issues.map(e=>e.message).join('；')});
    if(error instanceof multer.MulterError)return void res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'文件不能超过 30 MB':`上传失败：${error.message}`});
    if(error instanceof HttpError)return void res.status(error.status).json({error:error.message});
    if(error instanceof SyntaxError)return void res.status(400).json({error:'请求 JSON 无效'});
    console.error(error instanceof Error?error.message:'未知错误');res.status(500).json({error:error instanceof Error?error.message:'本地服务出错'});
  };
  // Mounted after Vite/static middleware by index.ts to also catch their errors.
  return {app,store,errorHandler:handler,ai,close:()=>{closed=true;ai.close();store.close();}};
}
