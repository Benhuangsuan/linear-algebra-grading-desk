import test from 'node:test';
import assert from 'node:assert/strict';
import {blankQuestion,questionKey,type Grade,type Judgment,type Submission} from '../shared/domain.js';
import {courseConfig} from '../shared/course.js';
import {hasFormalResult,isUngraded,aiSelectionReason,reconcileSelection} from '../shared/submission-state.js';

const config={...courseConfig([{...blankQuestion(),number:'7'}]),confirmed:true};
const row:Judgment={key:questionKey(config.questions[0]),type:'completion_only',recognition:'found',verdict:'completed',deduction:0,reason:'',pages:[1],needsReview:true,reviewed:false};
function submission(id='A',provider?:Grade['provider']):Submission{return {id,assignmentId:'assignment',fileId:'file-'+id,studentName:'Synthetic '+id,studentId:'',status:provider?'review':'uploaded',grade:provider?{provider,model:'fixture',version:1,at:'2026-10-23',config,rows:[{...row}],raw:null}:null,review:null,manualReport:'',reportBase:'',error:'',revision:0,updatedAt:'2026-10-23'};}
test('未批改与待确认分开：Mock/人工占位、正式人工、两个视觉服务和旧确认记录',()=>{
  assert.equal(isUngraded(submission()),true);
  const mock=submission('B','mock');assert.equal(isUngraded(mock),true); // Numeric demo score is insufficient.
  for(const provider of ['deepseek','qwen'] as const){const s=submission('A',provider);assert.equal(s.status,'review');assert.equal(isUngraded(s),false);assert.equal(hasFormalResult(s),true);assert.match(aiSelectionReason(s),/正式批改/);assert.equal(aiSelectionReason(s,true),'');
    const uncertain={...s,grade:{...s.grade!,rows:[{...row,recognition:'uncertain' as const,verdict:'uncertain' as const,deduction:null}]}};assert.equal(isUngraded(uncertain),false);
  }
  const manual=submission('D','manual');manual.grade!.rows=[{...row,recognition:'uncertain',verdict:'uncertain',deduction:null}];assert.equal(isUngraded(manual),true);
  manual.review=[{...row,reviewed:true,needsReview:false}];assert.equal(isUngraded(manual),false);assert.equal(manual.status,'review');
  mock.review=[{...row,reviewed:true,needsReview:false}];assert.equal(isUngraded(mock),false); // Explicit complete human review of a demo.
  assert.equal(isUngraded({...submission('L','mock'),status:'confirmed'}),false);
  const malformed=submission('M','deepseek');malformed.grade!.rows=[];assert.equal(isUngraded(malformed),true);
});
test('等待/处理中及暂停占位不可再选，失败/取消无结果可重试，有效旧结果不误算未批改',()=>{
  for(const status of ['queued','processing'] as const){const s={...submission(),status};assert.equal(isUngraded(s),false);assert.ok(aiSelectionReason(s));assert.ok(aiSelectionReason(s,true));}
  for(const provider of [undefined,'mock'] as const){const failed={...submission('F',provider),status:'failed' as const,error:'fixture failure'};assert.equal(isUngraded(failed),true);assert.equal(aiSelectionReason(failed),'');}
  assert.equal(isUngraded({...submission('F','deepseek'),status:'failed'}),false);
  assert.equal(aiSelectionReason({...submission(),status:'uploaded'}),''); // Cancelled/unstarted task is not permanently locked.
  assert.match(aiSelectionReason({...submission(),status:'confirmed'},true),/重开/);
  assert.match(aiSelectionReason(undefined),/删除/);
});
test('选择状态调和只剔无效项，立即统一勾选与人数；保留其他目标且不自动重新加入',()=>{
  const a=submission('A'),b=submission('B','mock'),c=submission('C');
  assert.deepEqual(reconcileSelection(['A','B','C','B'],[a,b,c]).valid,['A','B','C']);
  for(const next of [{...a,status:'queued' as const},{...a,status:'processing' as const},submission('A','deepseek'),{...a,status:'confirmed' as const}]){
    const result=reconcileSelection(['A','B','C'],[next,b,c]);assert.deepEqual(result.valid,['B','C']);assert.equal(result.removed[0].id,'A');assert.ok(result.removed[0].reason);
  }
  assert.deepEqual(reconcileSelection(['A','B','C'],[b,c]).valid,['B','C']);
  assert.deepEqual(reconcileSelection(['B','C'],[a,b,c]).valid,['B','C']);
});
