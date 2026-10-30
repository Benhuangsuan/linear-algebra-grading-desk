import {Router} from 'express';
import {z} from 'zod';
import {providerId} from '../../shared/ai.js';
import type {AiService} from './service.js';
export function aiRoutes(service:AiService){
  const router=Router();
  router.get('/ai/providers',(_req,res)=>res.json(service.statuses()));
  router.post('/ai/providers/:id/test',async(req,res)=>{
    z.object({consent:z.literal(true)}).parse(req.body);
    res.json(await service.connection(providerId.parse(req.params.id)));
  });
  router.post('/assignments/:id/ai/preview',async(req,res)=>res.json(await service.preview(String(req.params.id),req.body)));
  router.post('/assignments/:id/reference-ai/batch-preview',async(req,res)=>res.json(await service.referenceBatchPreview(String(req.params.id),req.body)));
  router.post('/assignments/:id/reference-ai/tasks',async(req,res)=>res.json(await service.startReferenceTask(String(req.params.id),req.body)));
  router.get('/assignments/:id/reference-ai/tasks/latest',(req,res)=>res.json(service.referenceTask(String(req.params.id))));
  const selection=z.object({fileId:z.string().min(1).max(100),resultId:z.string().min(1).max(150)}).strict();
  router.get('/assignments/:id/reference-ai/results',async(req,res)=>res.json(await service.referenceLibrary.summaries(String(req.params.id))));
  router.post('/assignments/:id/reference-ai/results/preview',async(req,res)=>{const b=z.object({selections:z.array(selection).min(1).max(50),resolutions:z.record(z.string().max(200),z.string().max(150)).default({})}).strict().parse(req.body);res.json(await service.referenceLibrary.preview(String(req.params.id),b.selections,b.resolutions));});
  router.post('/assignments/:id/reference-ai/results/recover',async(req,res)=>res.json(await service.referenceLibrary.recover(String(req.params.id),selection.parse(req.body))));
  router.post('/assignments/:id/reference-ai/results/inspect',async(req,res)=>{const {result}=await service.referenceLibrary.selected(String(req.params.id),selection.parse(req.body),false);res.json({config:{total:10,mode:'deduction',principles:'',questions:result.questions,confirmed:false},status:result.status,error:result.error});});
  router.get('/assignments/:id/reference-ai/results/:resultId/diagnostics',(req,res)=>res.json(service.referenceLibrary.diagnostics(String(req.params.id),String(req.params.resultId))));
  router.post('/assignments/:id/reference-ai/tasks/:taskId/cancel',(req,res)=>res.json(service.cancelReferenceTask(String(req.params.id),String(req.params.taskId))));
  router.post('/assignments/:id/reference-ai/preview',async(req,res)=>res.json(await service.referencePreview(String(req.params.id),req.body)));
  router.post('/assignments/:id/reference-ai/parse',async(req,res)=>res.json(await service.referenceParse(String(req.params.id),req.body)));
  router.post('/assignments/:id/ai/queue',async(req,res)=>res.json(await service.enqueue(String(req.params.id),req.body)));
  router.get('/assignments/:id/ai', (req,res)=>res.json(service.overview(String(req.params.id))));
  router.post('/ai/batches/:id/control',(req,res)=>res.json(service.control(String(req.params.id),z.object({action:z.enum(['pause','resume','cancel'])}).parse(req.body).action)));
  return router;
}
