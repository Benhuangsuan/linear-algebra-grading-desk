import {testDirectory} from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {blankQuestion,blankConfig,questionKey,type State,type Assignment,type Submission,type StoredFile,type Judgment} from '../shared/domain.js';

test('本地闭环：上传、隔离失败重试、人工审核、版本保护、重启持久化与删除',async()=>{
  const dir=testDirectory('api-test-');
  let runtime=createApp(dir);runtime.app.use(runtime.errorHandler);
  let server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
  let base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  async function request<T>(path:string,method='GET',body?:unknown,status=200):Promise<T>{const response=await fetch(base+path,{method,headers:body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:undefined,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});const data:unknown=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data as T;}
  const stop=async()=>{await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));runtime.close();};
  try {
    assert.equal((await request<{paidCalls:number}>('/health')).paidCalls,0);
    const foreign=await fetch(base+'/courses',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{"name":"bad"}'});assert.equal(foreign.status,403);
    const course=await request<{id:string}>('/courses','POST',{name:'测试课程'},201);
    const config={...blankConfig(),confirmed:true,questions:[{...blankQuestion(),section:'1.1',number:'7',type:'completion_only',missingPenalty:1,errorPenalty:0},{...blankQuestion(),section:'1.2',number:'26',part:'a',missingPenalty:2,errorPenalty:.5,prompt:'题干',answer:'接受等价解'},{...blankQuestion(),section:'1.3',number:'19',type:'completion_only',missingPenalty:1,errorPenalty:0}]};
    let a=await request<Assignment>('/assignments','POST',{courseId:course.id,title:'三小节作业',scope:'1.1 / 1.2 / 1.3',description:'本地测试',config},201);
    const pdf=await PDFDocument.create();for(let i=0;i<3;i++)pdf.addPage([400,600]).drawText(`Synthetic test page ${i+1} - no student data`,{x:20,y:550,size:13});const bytes=await pdf.save();
    async function upload(name:string,content:Uint8Array=bytes,status=201,duplicate?:string){const form=new FormData();form.append('kind','student');form.append('file',new Blob([new Uint8Array(content)],{type:'application/pdf'}),name);if(duplicate)form.append('duplicate',duplicate);return request<StoredFile>(`/assignments/${a.id}/files`,'POST',form,status);}
    const f=await upload('Re_9.9作业_测试同学（自动化测试参考文件）.pdf');assert.equal(f.pages,3);
    await upload('Re_9.9作业_测试同学（自动化测试参考文件）.pdf',bytes,409);
    await upload('Re_9.9作业_测试同学（自动化测试参考文件）.pdf',bytes,201,'keep');
    const invalid=new FormData();invalid.append('kind','student');invalid.append('file',new Blob(['fake']),'fake.pdf');
    const bad=await fetch(base+`/assignments/${a.id}/files`,{method:'POST',body:invalid});assert.equal(bad.status,400);await bad.json();
    let st=await request<State>('/state');assert.equal(st.submissions.length,2);
    const [s1,s2]=st.submissions;assert.equal(s1.studentName,'测试同学');
    // Exercise partial failure without shipping a fake failure switch in the app.
    const broken=runtime.store.get<StoredFile>('files',s2.fileId)!;runtime.store.put('files',{...broken,pages:0});
    await request(`/assignments/${a.id}/queue`,'POST',{ids:[s1.id,s2.id],acknowledged:true});
    async function waitQueue(){for(let i=0;i<70;i++){const state=await request<State>('/state');if(!state.submissions.some(s=>['queued','processing'].includes(s.status)))return state;await new Promise(r=>setTimeout(r,50));}throw new Error('队列超时');}
    st=await waitQueue();assert.equal(st.submissions[0].status,'review');assert.equal(st.submissions[1].status,'failed');
    runtime.store.put('files',broken);await request(`/assignments/${a.id}/queue`,'POST',{ids:[s2.id],acknowledged:true});st=await waitQueue();assert.equal(st.submissions[1].status,'review');
    let s=st.submissions[0];assert.equal(s.grade?.provider,'mock');
    const initial=s.grade!.rows;
    await request(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows:initial,manualReport:'',reportBase:'',confirm:true},400);
    const rows:Judgment[]=a.config.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'partial',deduction:q.type==='completion_only'?0:.25,reason:'已人工核对，接受不同方法。',pages:[2,3],needsReview:false,reviewed:true}));
    await request(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows:[{...rows[0],deduction:1},...rows.slice(1)],manualReport:'',reportBase:'',confirm:false},400);
    s=await request<Submission>(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows,manualReport:'这是一份独立保存的人工报告。',reportBase:'snapshot',confirm:true});assert.equal(s.status,'confirmed');
    await request(`/assignments/${a.id}/queue`,'POST',{ids:[s.id],acknowledged:true,replaceDraft:true},409);
    await request(`/submissions/${s.id}/review`,'PUT',{revision:s.revision,rows,manualReport:'覆盖尝试',reportBase:'',confirm:false},409);
    a=await request<Assignment>(`/assignments/${a.id}`,'PUT',{...a,config:{...a.config,principles:'新版规则'},regradeUnconfirmed:true});assert.equal(a.version,2);st=await waitQueue();
    const protectedResult=st.submissions.find(v=>v.id===s.id)!;assert.equal(protectedResult.status,'confirmed');assert.equal(protectedResult.grade!.version,1);assert.equal(protectedResult.manualReport,s.manualReport);
    assert.equal((await request<unknown[]>(`/assignments/${a.id}/versions`)).length,2);
    const copy=await request<Assignment>('/assignments','POST',{courseId:course.id,title:'复制配置',scope:'',description:'',config:blankConfig(),copyFrom:a.id},201);assert.equal(copy.config.confirmed,false);assert.equal(copy.config.questions.length,3);
    // Synthetic PDFs exercise file serving and manual-only startup without private attachments.
    for(const name of ['SyntheticGamma.pdf','SyntheticDelta.pdf']){const sample=await upload(name,bytes);assert.equal(sample.pages,3);const response=await fetch(base+`/files/${sample.id}/content`);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal((await response.arrayBuffer()).byteLength,sample.size);}
    const history=await request<unknown[]>(`/submissions/${s.id}/history`);assert.ok(history.length>=3);
    const response=await fetch(base+`/assignments/${a.id}/export`);assert.equal(response.status,200);const csv=await response.text();assert.ok(csv.startsWith('"姓名","成绩"\r\n'));assert.ok(csv.includes('"测试同学","9.75分"'));assert.ok(csv.includes('"待确认"'));assert.ok(!csv.includes('学号'));assert.ok(!csv.includes('人工报告'));
    await stop();runtime=createApp(dir);runtime.app.use(runtime.errorHandler);server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
    st=await request<State>('/state');const persisted=st.submissions.find(v=>v.id===s.id)!;assert.deepEqual(persisted.review,rows);assert.equal(persisted.manualReport,s.manualReport);assert.equal(persisted.status,'confirmed');
    const manualSubmission=st.submissions.find(v=>v.status==='uploaded')!;
    const manual=await request<Submission>(`/submissions/${manualSubmission.id}/manual`,'POST',{});assert.equal(manual.grade!.provider,'manual');
    assert.ok(manual.review!.every(r=>r.recognition==='uncertain'&&r.deduction===null));
    await request(`/courses/${course.id}`,'PATCH',{name:'重命名测试'});await request(`/assignments/${a.id}`,'PATCH',{archived:true});
    await request(`/courses/${course.id}`,'DELETE');st=await request<State>('/state');assert.equal(st.submissions.length,0);assert.equal(st.assignments.length,0);assert.equal(st.files.length,0);
  }finally{await stop();}
});
