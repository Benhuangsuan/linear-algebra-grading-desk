import test from 'node:test';import assert from 'node:assert/strict';
import {inspectFile} from '../server/files.js';import {parseReferenceMaterials} from '../server/reference-parser.js';
import {styledReference} from './reference-fixtures.js';
import {blankQuestion,configSchema,questionKey} from '../shared/domain.js';
import {courseConfig,parseCourseMaterials} from '../shared/course.js';
import {unitConfig} from '../shared/units.js';
import {reconcileQuestions,parentContentKey} from '../shared/questions.js';
import {messagesFor} from '../server/ai/prompt.js';
import {referenceCandidate} from '../server/ai/reference.js';

test('彩色PDF在提取层保留颜色坐标，矢量图归父题，多个非数字题不串题',async()=>{
  const info=await inspectFile(await styledReference(),'synthetic.pdf',false);assert.ok(info.referenceLayout);assert.ok(info.referenceLayout.pages[0].graphics.some(g=>g.kind==='vector'));
  const result=parseReferenceMaterials([{id:'ref',...info}],'3.3');assert.deepEqual(result.questions.map(q=>q.number),['5','13','18','26','32','补充题1','补充题2']);
  const q18=result.questions.find(q=>q.number==='18')!;assert.match(q18.prompt,/second prompt line/);assert.equal(q18.answer,'Reference eighteen');
  const q32=result.questions.find(q=>q.number==='32')!;assert.deepEqual(q32.children?.map(c=>c.label),['a','b']);assert.match(q32.children![0].prompt!,/first subquestion/);assert.equal(q32.children![1].answer,'Reference beta');assert.ok(q32.referenceSources?.some(s=>s.page===1&&s.graphic));assert.ok(!q32.referenceSources?.some(s=>s.page===2));assert.ok(!q32.answer.includes('Extra'));
  assert.equal(result.questions.at(-1)!.type,'graded');assert.match(result.questions.at(-1)!.notes,/多道补充题/);
  const config={...courseConfig(result.questions),confirmed:true};assert.deepEqual(configSchema.parse(JSON.parse(JSON.stringify(config))),config);
  const whole=unitConfig(config).questions.find(q=>q.number==='32')!;assert.match(whole.prompt,/first subquestion/);assert.match(whole.answer,/Reference beta/);
  const independent=unitConfig({...config,questions:[{...q32,unitMode:'independent',children:q32.children!.map(c=>({...c,confirmed:true}))}]}).questions;assert.equal(independent.length,2);assert.ok(independent.every(q=>q.referenceSources?.some(s=>s.graphic)));
  const image={page:1,width:10,height:10,data:'data:image/jpeg;base64,synthetic',hash:'synthetic'};const messages=messagesFor({...config,questions:independent},[{id:'reference-1',sourceFileId:'ref',images:[image]}],[],'test');assert.match(JSON.stringify(messages),/3.3 \/ 32 \/ a/);assert.match(JSON.stringify(messages),/3.3 \/ 32 \/ b/);assert.ok(JSON.stringify(messages).includes(image.data));assert.equal((messages[1].content as unknown[]).length,3);
});
test('无颜色回退、字符串题号、原顺序及旧数据可读，明确采用前保留教师文字和规则',()=>{
  const questions=parseCourseMaterials(['习题3.3\n32. Parent\na. First\nanswer\nb. Second\nanswer\n补充题1. Extra\nanswer1\n补充题2. Another\nanswer2'],'3.3');assert.deepEqual(questions.map(q=>q.number),['32','补充题1','补充题2']);assert.equal(questions[0].children?.length,2);
  const fallback=parseReferenceMaterials([{id:'f',text:'习题3.3\n18. Synthetic prompt\nanswer'}],'3.3');assert.ok(fallback.warnings.length);assert.equal(fallback.questions[0].parseMethod,'text');
  const old=courseConfig([{...blankQuestion(),number:'补充题',prompt:'Teacher prompt',answer:'Teacher answer',notes:'Teacher note'}]);old.questions[0].errorPenalty=.3;const parsed=courseConfig([{...old.questions[0],prompt:'Candidate prompt',answer:'Candidate answer',referenceSources:[{fileId:'ref',page:1,graphic:true}]}]);
  assert.equal(reconcileQuestions(old,parsed).questions[0].prompt,'Teacher prompt');const adopted=reconcileQuestions(old,parsed,new Set([parentContentKey(old.questions[0])])).questions[0];assert.equal(adopted.prompt,'Candidate prompt');assert.equal(adopted.errorPenalty,.3);assert.equal(adopted.notes,'Teacher note');
});
test('同一行的黑色题干和红色答案按颜色分别保留，不丢多行题干',async()=>{
  const info=await inspectFile(await styledReference(true),'synthetic.pdf',false);const q=parseReferenceMaterials([{id:'ref',...info}],'3.3').questions.find(q=>q.number==='18')!;
  assert.match(q.prompt,/Synthetic multi-line prompt/);assert.match(q.prompt,/second prompt line/);assert.equal(q.answer,'Reference eighteen');assert.ok(!q.prompt.includes('Reference eighteen'));
});
test('辅助解析结果校验页码、范围、层级及重复，不接受模型评分配置',()=>{
  const item={section:'3.3',number:'补充题',prompt:'Synthetic',answer:'Synthetic answer',kind:'solution',children:[{label:'a',prompt:'a prompt',answer:'a answer'}],sources:[{page:1,graphic:true}]};const content=JSON.stringify({questions:[item]});
  const config=referenceCandidate(content,'ref',[1],'3.3');assert.equal(config.confirmed,false);assert.equal(config.questions[0].children?.[0].confirmed,false);assert.equal(questionKey(config.questions[0]),'3.3 / 补充题');
  for(const value of [{...item,sources:[{page:2,graphic:true}]},{...item,section:'1.1'},{...item,errorPenalty:0}])assert.throws(()=>referenceCandidate(JSON.stringify({questions:[value]}),'ref',[1],'3.3'));
  assert.throws(()=>referenceCandidate(JSON.stringify({questions:[item,item]}),'ref',[1],'3.3'));
});
test('无法确定的新黑色标题在参考解后出现时保留片段并提示，不静默并入前一题',()=>{
  const spans=[['习题3.3','black'],['18. Synthetic prompt','black'],['Synthetic answer','red'],['延伸思考','black']].map(([text,color],i)=>({text,color:color as 'black'|'red',x:.1,y:.1+i*.05,width:.4,height:.01}));
  const parsed=parseReferenceMaterials([{id:'ref',text:'',referenceLayout:{version:1,warnings:[],pages:[{page:1,width:600,height:840,spans,graphics:[]}]}}],'3.3');
  assert.ok(parsed.warnings.some(w=>w.includes('新题边界')));assert.ok(!parsed.questions[0].prompt.includes('延伸思考'));assert.match(parsed.questions[0].referenceExcerpt!,/延伸思考/);assert.equal(parsed.questions[0].answer,'Synthetic answer');
});
