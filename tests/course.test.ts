import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {syntheticReferences} from './fixtures.js';
import {blankQuestion,questionKey,summarize,validateRows,deductionRows,type Judgment} from '../shared/domain.js';
import {courseConfig,courseQuestion,parseCourseMaterials,parseScope,suggestedDeduction} from '../shared/course.js';
import {ignoreDevelopmentPath} from '../server/watch-policy.js';
import {inspectFile} from '../server/files.js';
import {unitConfig} from '../shared/units.js';
import {childrenOf,withChildren} from '../shared/questions.js';

test('1.1 课程规则：奇数只检查完成，漏做 0.2，偶数每处错误 0.1',()=>{
  const odd=courseQuestion({...blankQuestion(),section:'1.1',number:'7'});const even=courseQuestion({...blankQuestion(),section:'1.2',number:'26',subparts:['a','b','c']});const c=courseConfig([odd,even]);
  assert.equal(odd.type,'completion_only');assert.equal(even.type,'graded');assert.equal(c.total,10);
  assert.equal(suggestedDeduction(c,odd,'found','completed'),0);assert.equal(suggestedDeduction(c,odd,'missing','missing'),.2);
  assert.equal(suggestedDeduction(c,even,'not_found','missing'),.2);
  assert.equal(suggestedDeduction(c,even,'found','incorrect',1),.1);assert.equal(suggestedDeduction(c,even,'found','partial',3),.3);
  assert.equal(suggestedDeduction(c,even,'uncertain','uncertain'),null);
  const rows:Judgment[]=[{key:questionKey(odd),type:odd.type,recognition:'not_found',verdict:'missing',deduction:.2,reason:'未检索到作答',pages:[],needsReview:false,reviewed:true},{key:questionKey(even),type:even.type,recognition:'found',verdict:'partial',deduction:.3,errorCount:3,reason:'三处错误',pages:[],needsReview:false,reviewed:true}];
  assert.deepEqual(validateRows(c,rows,3,true),[]);assert.equal(summarize(c,rows).score,9.5);
  assert.ok(validateRows(c,[rows[0],{...rows[1],deduction:.1}],3).some(e=>e.includes('错误处数')));
  assert.ok(validateRows({...c,questions:[odd,{...even,subparts:[]}]},rows,3).some(e=>e.includes('无小问')));
  const overrides={...c,questions:[odd,{...even,errorPenalty:.2}]};assert.equal(suggestedDeduction(overrides,overrides.questions[1],'found','partial',2),.4);
});
test('整题缺做跨多个小问只扣一次；未检索到与识别不清分开',()=>{
  const a=courseQuestion({...blankQuestion(),section:'1.3',number:'36',part:'a'});const b={...a,part:'b'};const c=courseConfig([a,b]);
  const rows:Judgment[]=c.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'not_found',verdict:'missing',deduction:.2,reason:'未检索到',pages:[],needsReview:true,reviewed:false}));
  assert.equal(summarize(c,rows).score,9.8);assert.equal(deductionRows(c,rows).length,1);assert.equal(deductionRows(c,rows)[0].key,'1.3 / 36');
  assert.equal(summarize(c,[{...rows[0],recognition:'uncertain',verdict:'uncertain',deduction:null},rows[1]]).score,null);
});
test('范围解析和手工题目清单：支持多段章节范围，不凭空生成题号',()=>{
  assert.deepEqual([...parseScope('2.2 - 2.4,2.8')!],['2.2','2.3','2.4','2.8']);
  assert.throws(()=>parseScope('1.9-2.1'),/不支持/);
  const questions=parseCourseMaterials(['1.1: 7,11,34\n1.2: 13,26\n1.3:19,36'],'1.2-1.3');
  assert.equal(questions.length,4);assert.ok(questions.every(q=>q.section!=='1.1'));assert.equal(questions[1].errorPenalty,.1);
  assert.equal(parseCourseMaterials([],'1.1-1.3').length,0);
});
test('三份合成 PDF 提取 19 父题及 30 单元，重复材料不重复计题',async()=>{
  const texts:string[]=[];
  for(const file of await syntheticReferences()){const info=await inspectFile(file.buffer,file.name,false);assert.ok(info.text.length>100);texts.push(info.text);}
  assert.equal(texts.length,3);
  const questions=parseCourseMaterials(texts,'1.1-1.3');assert.equal(questions.length,19,questions.map(questionKey).join(', '));
  assert.equal(questions.filter(q=>q.type==='completion_only').length,9);assert.equal(questions.filter(q=>q.kind==='true_false').length,3);
  assert.equal(questions.find(q=>q.section==='1.2'&&q.number==='26')?.subparts?.length,5);
  assert.deepEqual(questions.find(q=>q.section==='1.3'&&q.number==='24')?.subparts,['a','b','c','d','e']);
  assert.deepEqual(questions.find(q=>q.section==='1.1'&&q.number==='34')?.subparts,['a','b','c','d']);
  assert.deepEqual(questions.find(q=>q.section==='1.3'&&q.number==='36')?.subparts,['a','b','c']);
  const confirmed={...courseConfig(questions.map(q=>withChildren(q,childrenOf(q).map(c=>({...c,confirmed:true}))))),confirmed:true};
  assert.equal(unitConfig(confirmed).questions.length,30);
  assert.ok(unitConfig(confirmed).questions.some(q=>questionKey(q)==='1.3 / 24 / e'));
  assert.equal(unitConfig(confirmed).questions.filter(q=>q.section==='1.3'&&q.number==='36').length,1);
  assert.equal(parseCourseMaterials([...texts,...texts],'1.1-1.3').length,19);
});
test('开发监听只包含代码，排除 Word 临时文件、参考资料和 SQLite',()=>{
  const root=process.cwd();
  for(const path of ['人工批改参考/作业批改参考答案/mso369B.tmp','第1版prompt相关文件/1.0版check/PowershellError.png','data/grading.sqlite-wal','codex输出/codex工作区/test.tmp','codex工作区/x','src/~$lock.ts','public/mso123.tmp'])assert.equal(ignoreDevelopmentPath(root,resolve(root,path)),true,path);
  for(const path of ['','src','src/main.tsx','shared/course.ts','public/favicon.svg','index.html'])assert.equal(ignoreDevelopmentPath(root,resolve(root,path)),false,path);
});
