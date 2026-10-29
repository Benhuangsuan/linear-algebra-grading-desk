import test from 'node:test';import assert from 'node:assert/strict';
import {manualGrade,MockProvider} from '../server/provider.js';import {validateVision} from '../server/ai/validate.js';import {gradeCell} from '../server/grades-export.js';
import {summarize,validateRows,type Assignment,type Submission,type Judgment} from '../shared/domain.js';
import {parseReferenceMaterials} from '../server/reference-parser.js';import{parseCourseMaterials,courseConfig,parseScope}from'../shared/course.js';import{questionKey,configSchema}from'../shared/domain.js';import{unitConfig}from'../shared/units.js';import{referenceCandidate}from'../server/ai/reference.js';import{referenceSections}from'../shared/reference.js';import{reconcileQuestions}from'../shared/questions.js';
const text='补充章第 5 节 参考答案\n注：所有题目均需批改。\n讲义题答案：\n3. Synthetic prompt\nSynthetic answer\n附加题答案：\n3. Another prompt\nAnother answer';
const page=(page:number,rows:[string,'black'|'red'][] )=>({page,width:600,height:800,graphics:[],spans:rows.map(([text,color],i)=>({text,color,x:.1,y:.1+i*.04,width:.5,height:.02}))});
const material={id:'synthetic',name:'第5节 Synthetic.pdf',text,referenceLayout:{version:1 as const,warnings:[],pages:[page(1,[['补充章第5节 参考答案','black'],['注：所有题目均需批改。','black'],['讲义题答案：','black'],['3. Synthetic prompt','black'],['Synthetic answer','red'],['附加题答案：','black'],['3. Another prompt','black'],['First answer','red']]),page(2,[['补充章第5节 参考答案','black'],['附加题答案：','black'],['Continued synthetic answer','red']])]}};
test('自由范围不限制PDF章节；补充章题组同号、全题批改与跨页保持',()=>{
 for(const scope of ['补充章1-4','补充章第1～4节','补充题与课堂讲义','1.1-1.3']){const r=parseReferenceMaterials([material],scope);assert.equal(r.questions.length,2);assert.deepEqual(r.questions.map(questionKey),['补充章第5节 / 讲义题 3','补充章第5节 / 附加题 3']);assert.ok(r.questions.every(q=>q.type==='graded'&&q.errorPenalty===.1));assert.match(r.questions[1].answer,/Continued/);assert.deepEqual(r.questions[1].referenceSources?.map(s=>s.page),[1,2]);assert.equal(unitConfig({...courseConfig(r.questions),confirmed:true}).questions.length,2);}
 assert.deepEqual(referenceSections(material),['补充章第5节']);assert.equal(parseScope('补充题与课堂讲义'),null);
 const other={...material,id:'synthetic-other',name:'第6节 Synthetic.pdf',text:material.text.replaceAll('5','6'),referenceLayout:{...material.referenceLayout,pages:material.referenceLayout.pages.map(p=>({...p,spans:p.spans.map(s=>({...s,text:s.text.replaceAll('5','6')}))}))}};assert.equal(parseReferenceMaterials([material,other],'自由说明').questions.length,4);
});
test('文本回退保留两组、来源页与校对提示；空白和无章节给出可操作说明',()=>{
 const r=parseReferenceMaterials([material],'补充章','text');assert.equal(r.questions.length,2);assert.ok(r.questions.every(q=>q.type==='graded'&&q.parseWarning&&q.referenceSources?.length===2));assert.equal(parseCourseMaterials(['习题1.1\n3. Synthetic\nanswer'],'1.1')[0].type,'completion_only');
 for(const text of ['', 'no recognizable heading']){const result=parseReferenceMaterials([{id:'empty',name:'unknown.pdf',text}],'自由说明');assert.equal(result.questions.length,0);assert.ok(result.warnings.some(w=>/未取得文字|未找到章节/.test(w)));}
});
test('AI候选契约区分题组、真实章节与全题规则，拒绝混组/重复/越界页',()=>{
 const item={section:'补充章第5节',number:'3',prompt:'Synthetic',answer:'Synthetic answer',kind:'solution',children:[],sources:[{page:1,graphic:true}]};
 const raw=JSON.stringify({questions:[{...item,group:'讲义题'},{...item,group:'附加题'}]});const c=referenceCandidate(raw,'synthetic',[1],'中文范围',material);assert.equal(c.questions.length,2);assert.ok(c.questions.every(q=>q.type==='graded'));assert.ok(c.questions[0].referenceSources?.[0].graphic);
 for(const questions of [[item],[{...item,group:'讲义题'},{...item,group:'讲义题'}],[{...item,group:'讲义题',section:'1.5'}],[{...item,group:'讲义题',sources:[{page:2,graphic:false}]}]])assert.throws(()=>referenceCandidate(JSON.stringify({questions}),'synthetic',[1],'中文范围',material));
});
test('重新整理仅补充候选，不改教师规则；旧无group快照键和值完全保留',()=>{
 const candidate=courseConfig(parseReferenceMaterials([material],'自由说明').questions);const old={...candidate,questions:[{...candidate.questions[0],type:'completion_only' as const,errorPenalty:0,notes:'Teacher choice'}]};const merged=reconcileQuestions(old,candidate);assert.equal(merged.questions.length,2);assert.deepEqual(merged.questions[0],old.questions[0]);assert.equal(reconcileQuestions(merged,candidate).questions.length,2);assert.ok(configSchema.safeParse(merged).success);
 const legacy=courseConfig(parseCourseMaterials(['习题1.1\n3. Synthetic legacy\nLegacy answer'],'1.1'));const before=structuredClone(legacy);const appended=reconcileQuestions(legacy,candidate);assert.equal(questionKey(appended.questions[0]),'1.1 / 3');assert.equal(appended.questions[0].type,'completion_only');assert.deepEqual(legacy,before);assert.deepEqual(appended.questions[0],before.questions[0]);
});

test('同号题组的人工、Mock和视觉评分身份一致，扣分汇总及CSV不混合',async()=>{
 const candidate=courseConfig(parseReferenceMaterials([material],'自由说明').questions);const config={...reconcileQuestions(courseConfig(),candidate),confirmed:true};
 assert.doesNotMatch(config.principles,/奇数题仅检查完成/);assert.equal(reconcileQuestions({...courseConfig(),principles:'Teacher custom rule'},candidate).principles,'Teacher custom rule');
 const assignment={version:1,config} as Assignment,manual=manualGrade(assignment),units=unitConfig(config);assert.deepEqual(manual.config,units);assert.equal(units.questions.length,2);
 const facts=units.questions.map((q,i)=>({key:questionKey(q),type:q.type,recognition:i===0?'not_found':'found',verdict:i===0?'missing':'partial',reason:'Synthetic evidence',pages:i===0?[]:[1],reviewReason:''}));
 const rows=validateVision(JSON.stringify({rows:facts}),units,1).rows.map(r=>({...r,needsReview:false,reviewed:true}));assert.deepEqual(validateRows(manual.config,rows,1,true),[]);assert.deepEqual(rows.map(r=>r.deduction),[.2,.1]);assert.equal(summarize(units,rows).score,9.7);
 assert.equal(gradeCell({status:'confirmed',grade:manual,review:rows} as Submission),'9.7，漏1题');const mock=await new MockProvider().grade(assignment,{pages:1} as never);assert.deepEqual(mock.rows.map(r=>r.key),manual.rows.map(r=>r.key));
 const legacy={...candidate,questions:candidate.questions.flatMap(q=>['a','b'].map(part=>({...q,part})))};
 const missing:Judgment[]=legacy.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'missing',verdict:'missing',deduction:.2,reason:'Synthetic missing',pages:[],reviewed:true,needsReview:false}));
 assert.equal(summarize(legacy,missing).score,9.6);assert.equal(gradeCell({status:'confirmed',grade:{...manual,config:legacy,rows:missing}} as Submission),'9.6，漏2题');
});
