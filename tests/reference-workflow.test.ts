import test from 'node:test';import assert from 'node:assert/strict';
import {referenceSections,recommendedReference,editReferencePage} from '../shared/reference.js';
import {courseConfig} from '../shared/course.js';import {blankQuestion,questionKey} from '../shared/domain.js';
import {questionImportSummary,reconcileQuestions} from '../shared/questions.js';
import {parseReferenceMaterials} from '../server/reference-parser.js';

const files=[{id:'f32',kind:'reference',mime:'application/pdf',name:'3.2 Ans.pdf',text:'习题3.2',pages:3},{id:'f33',kind:'reference',mime:'application/pdf',name:'3.3 Ans.pdf',text:'习题3.3',pages:2}];
test('参考文件按实际小节匹配，不按上传顺序；未知或多个匹配不擅自选取',()=>{
  assert.equal(recommendedReference(files,'3.3'),'f33');assert.equal(recommendedReference([...files].reverse(),'3.3'),'f33');
  assert.equal(recommendedReference(files,'3.1'),'');assert.equal(recommendedReference([...files,{...files[1],id:'f34'}],'3.3'),'');
  assert.deepEqual(referenceSections({...files[0],text:'习题3.3'}),['3.3']);assert.deepEqual(referenceSections({...files[1],text:''}),['3.3']);
});
test('添加、更换、移除不修改原列表；跨小节须确认，重复/无效页和学生文件拒绝',()=>{
  const prior=[{fileId:'f33',page:1,graphic:true}];
  const added=editReferencePage(prior,files,'3.3',{fileId:'f33',page:2,graphic:false});assert.equal(added.length,2);assert.equal(prior.length,1);
  const replaced=editReferencePage(added,files,'3.3',{fileId:'f32',page:1,graphic:true},0,true);assert.equal(replaced[1].page,2);assert.equal(replaced[0].fileId,'f32');
  assert.throws(()=>editReferencePage(prior,files,'3.3',{fileId:'f32',page:1,graphic:true}),/先确认/);
  assert.throws(()=>editReferencePage(prior,files,'3.3',prior[0]),/重复添加/);
  assert.throws(()=>editReferencePage(prior,files,'3.3',{fileId:'f33',page:3,graphic:true}),/有效/);
  assert.throws(()=>editReferencePage(prior,[{...files[0],kind:'student'}],'3.2',{fileId:'f32',page:1,graphic:true}),/本作业/);
  assert.deepEqual(prior,[{fileId:'f33',page:1,graphic:true}]);
});
test('导入计数区分当前/新增/重合/新小问，不覆盖人工文字、扣分或参考页',()=>{
  const q={...blankQuestion(),section:'3.3',number:'32',prompt:'人工题干',notes:'人工备注',errorPenalty:.3,referenceSources:[{fileId:'f33',page:1,graphic:true}],children:[{id:'stable',label:'a',confirmed:true,prompt:'人工小问'}]};
  const previous=courseConfig([q]);previous.questions[0]=q;
  const candidate=courseConfig([{...q,prompt:'新文字',referenceSources:[],children:[{id:'new-a',label:'a',prompt:'新小问'},{id:'new-b',label:'b'}]},{...blankQuestion(),section:'3.1',number:'补充题'}]);
  const summary=questionImportSummary(previous,candidate);assert.deepEqual([summary.current,summary.found,summary.added.length,summary.existing.length,summary.newChildren.length],[1,2,1,1,1]);
  const next=reconcileQuestions(previous,candidate);assert.equal(next.questions[0].prompt,'人工题干');assert.equal(next.questions[0].errorPenalty,.3);assert.deepEqual(next.questions[0].referenceSources,q.referenceSources);assert.equal(next.questions[0].children![0].id,'stable');assert.equal(next.questions[0].children!.length,2);assert.equal(next.questions[1].number,'补充题');
  const reversed=questionImportSummary(candidate,previous);assert.equal(reversed.added.length,0);assert.equal(reversed.existing.length,1);
});
test('原auto与black-red两项是相同解析能力，合并界面后API旧参数仍兼容',()=>{
  const file={id:'f',name:'合成答案.pdf',text:'习题3.3\n18. 合成题干\n答案',referenceLayout:{version:1 as const,warnings:[],pages:[{page:1,width:600,height:840,graphics:[],spans:[{text:'习题3.3',color:'black' as const,x:.1,y:.1,width:.5,height:.01},{text:'18. 合成题干',color:'black' as const,x:.1,y:.2,width:.5,height:.01},{text:'合成答案',color:'red' as const,x:.1,y:.3,width:.5,height:.01}]}]}};
  const automatic=parseReferenceMaterials([file],'3.3','auto'),explicit=parseReferenceMaterials([file],'3.3','black-red'),text=parseReferenceMaterials([file],'3.3','text');
  assert.deepEqual(automatic.questions,explicit.questions);assert.equal(automatic.questions[0].parseMethod,'color');assert.equal(text.questions[0].parseMethod,'text');assert.ok(automatic.warnings.every(w=>!w.includes('材料 f：')));
});
