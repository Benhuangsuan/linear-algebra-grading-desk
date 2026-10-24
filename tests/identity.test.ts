import {testDirectory} from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { inferIdentity, inferredNameCorrection } from '../server/identity.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { manualGrade } from '../server/provider.js';
import { blankQuestion, type Assignment, type StoredFile, type Submission, type History } from '../shared/domain.js';
import { courseConfig } from '../shared/course.js';

test('姓名识别排除回复前缀、日期、作业标签及参考备注，保留姓名与学号',()=>{
  const cases=[
    ['Re_9.9作业_测试同学（人工批改参考文件）.pdf','测试同学',''],
    ['Re: Re_9.9作业_测试同学（人工批改参考文件）.PDF','测试同学',''],
    ['Fwd_2026-09-09_线性代数作业_测试同学_2600010000.pdf','测试同学','2600010000'],
    ['9月9日作业_测试同学_2600010000.pdf','测试同学','2600010000'],
    ['2600010000_测试同学.pdf','测试同学','2600010000'],
    ['测试同学-2600010000-2班-第3次作业.pdf','测试同学','2600010000'],
    ['2600010000（测试同学）.pdf','测试同学','2600010000'],
    ['Rebecca Smith_2600010000.pdf','Rebecca Smith','2600010000'],
  ];
  for(const [filename,studentName,studentId] of cases)assert.deepEqual(inferIdentity(filename),{studentName,studentId},filename);
  assert.equal(inferIdentity('2600010000-2600010001-测试学生.pdf').studentId,'');
  assert.equal(inferredNameCorrection(cases[0][0],'9.9测试同学'),'测试同学');
  assert.equal(inferredNameCorrection(cases[0][0],'人工自定义姓名'),null);
});

test('作业次数只从明确前缀去除，姓名学号与英文数字不全局删改',()=>{
  for(const filename of ['线代作业5-测试甲.pdf','线代作业5 测试甲.pdf','线代作业 5 - 测试甲.pdf','Re: 线代作业5－测试甲（附件）.pdf','转发_2026-09-09_线代作业5　测试甲.pdf'])assert.deepEqual(inferIdentity(filename),{studentName:'测试甲',studentId:''},filename);
  for(const filename of ['线代作业5-测试甲-23000001.pdf','线代作业5 测试甲 23000001.pdf','线代作业 5 - 测试甲 - 23000001.pdf'])assert.deepEqual(inferIdentity(filename),{studentName:'测试甲',studentId:'23000001'},filename);
  assert.deepEqual(inferIdentity('线代作业10-测试乙.pdf'),{studentName:'测试乙',studentId:''});
  assert.deepEqual(inferIdentity('John5 Smith-23000001.pdf'),{studentName:'John5 Smith',studentId:'23000001'});
  assert.equal(inferIdentity('线代作业5-测试甲-23000001-23000002.pdf').studentId,'');
  assert.equal(inferredNameCorrection('线代作业5-测试甲.pdf','5 测试甲'),'测试甲');
  assert.equal(inferredNameCorrection('线代作业5-测试甲.pdf','5 自定义名'),null);
});

test('旧自动姓名启动时修正一次，保护人工姓名、已确认评分、报告和历史',()=>{
  const dir=testDirectory('v1.2-identity-');
  const store=new Store(dir);const at='2026-10-21T00:00:00.000Z';
  store.put('courses',{id:'course',name:'隔离测试课程',createdAt:at});
  const config={...courseConfig([{...blankQuestion(),number:'7'}]),confirmed:true};
  const a:Assignment={id:'assignment',courseId:'course',title:'姓名修复',scope:'1.1',description:'',archived:false,version:1,config,createdAt:at};
  store.put('assignments',a);
  const grade=manualGrade(a);grade.rows=grade.rows.map(r=>({...r,recognition:'found',verdict:'completed',deduction:0,reason:'',reviewed:true,needsReview:false}));
  const make=(id:string,studentName:string,name='Re_9.9作业_测试同学（人工批改参考文件）.pdf'):Submission=>{
    const file:StoredFile={id:'file-'+id,assignmentId:a.id,kind:'student',name,diskName:'fixture.pdf',mime:'application/pdf',size:1,pages:1,text:'',warning:'',createdAt:at};
    store.put('files',file);
    const s:Submission={id,assignmentId:a.id,fileId:file.id,studentName,studentId:'人工保留学号',status:'confirmed',grade,review:structuredClone(grade.rows),manualReport:'独立报告',reportBase:'snapshot',error:'',revision:4,updatedAt:at};
    store.put('submissions',s);return s;
  };
  const auto=make('auto','9.9测试同学');const manual=make('manual','9.9测试同学');const custom=make('custom','自定义姓名');
  const ordinal=make('ordinal','5 测试甲','线代作业5-测试甲-23000001.pdf');const protectedOrdinal=make('protected','5 测试甲','线代作业5-测试甲-23000001.pdf');
  store.history(manual,'修正学生信息');store.history(protectedOrdinal,'修正学生信息');store.close();
  let runtime=createApp(dir);
  try {
    const repaired=runtime.store.get<Submission>('submissions',auto.id)!;
    assert.equal(repaired.studentName,'测试同学');assert.equal(repaired.revision,5);
    assert.deepEqual({...repaired,studentName:auto.studentName,revision:auto.revision,updatedAt:auto.updatedAt},auto);
    assert.deepEqual(runtime.store.get('submissions',manual.id),manual);
    assert.deepEqual(runtime.store.get('submissions',custom.id),custom);
    const fixedOrdinal=runtime.store.get<Submission>('submissions',ordinal.id)!;assert.equal(fixedOrdinal.studentName,'测试甲');assert.equal(fixedOrdinal.revision,5);
    assert.deepEqual({...fixedOrdinal,studentName:ordinal.studentName,revision:ordinal.revision,updatedAt:ordinal.updatedAt},ordinal);assert.deepEqual(runtime.store.get('submissions',protectedOrdinal.id),protectedOrdinal);
    const history=runtime.store.all<History>('history');assert.equal(history.length,4);
    assert.ok(history.some(h=>h.action==='修正旧版文件名姓名识别'&&h.submissionId===auto.id));
    runtime.close();runtime=createApp(dir);
    assert.equal(runtime.store.all('history').length,4);
    assert.equal(runtime.store.get<Submission>('submissions',auto.id)!.revision,5);
  } finally {runtime.close();}
});
