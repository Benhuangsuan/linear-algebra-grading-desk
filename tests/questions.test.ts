import test from 'node:test';
import assert from 'node:assert/strict';
import {blankQuestion,configSchema,questionKey} from '../shared/domain.js';
import {courseConfig,courseQuestion,parseCourseMaterials} from '../shared/course.js';
import {childrenOf,extractChildren,withChildren,reconcileQuestions} from '../shared/questions.js';
import {unitConfig} from '../shared/units.js';

test('小问标点与换行本地容错，不将孤立数学变量或说明正文拆成小问',()=>{
  for(const mark of ['.','．','、',')','）']){
    const children=extractChildren('a'+mark+' 命题甲\n对\nb '+mark+' 命题乙\n错\nc\n'+mark+' 命题丙\n对\nd'+mark+' 命题丁\n对\ne  '+mark+' 命题戊\n对');
    assert.deepEqual(children.map(c=>c.label),['a','b','c','d','e']);assert.ok(children[4].answer?.includes('命题戊'));
  }
  assert.deepEqual(extractChildren('设 a,b,c 为向量\na = b+c\nb. 这是说明\n线性组合 a、b、c'),[]);
  assert.deepEqual(extractChildren('a. isolated explanation'),[]);
  assert.deepEqual(extractChildren('a\n．\n命题甲\nb\n．\n命题乙').map(c=>c.label),['a','b']);
  assert.deepEqual(parseCourseMaterials(['1.1:7,11'],'1.1').map(q=>q.subparts),[undefined,undefined]);
});
test('层级增量兼容：稳定ID、重排、内容/扣分覆盖、确认门禁、整题默认与重复保护',()=>{
  const legacy=courseQuestion({...blankQuestion(),number:'34',kind:'true_false',subparts:['a','b']});
  const original=JSON.stringify(legacy);const children=childrenOf(legacy);assert.equal(JSON.stringify(legacy),original);
  const edited=withChildren(legacy,[{...children[1],label:'c',prompt:'独立命题',answer:'对',errorPenalty:.3},children[0]]);
  assert.equal(edited.children![0].id,children[1].id);
  const c={...courseConfig([edited]),confirmed:true};const units=unitConfig(c);
  assert.deepEqual(units.questions.map(questionKey),['1.1 / 34 / c','1.1 / 34 / a']);
  assert.equal(units.questions[0].errorPenalty,.3);assert.ok(units.questions[0].prompt.endsWith('独立命题'));
  assert.equal(units.questions[0].childId,children[1].id);assert.equal(units.questions[0].parentKey,'1.1 / 34');
  assert.throws(()=>unitConfig({...c,questions:[withChildren(edited,[{...children[0],confirmed:false}])]}),/尚未核对/);
  const whole={...edited,number:'36',kind:'solution' as const,unitMode:'whole' as const};
  assert.equal(unitConfig({...c,questions:[whole]}).questions.length,1);
  assert.equal(unitConfig({...c,questions:[{...whole,unitMode:'independent'}]}).questions.length,2);
  assert.equal(configSchema.safeParse({...c,questions:[withChildren(edited,[children[0],{...children[1],label:'a'}])]}).success,false);
  assert.equal(configSchema.safeParse({...c,questions:[edited,{...edited,part:'a'}]}).success,false);
});
test('重解析只在显式调和后补新候选，保留教师内容、手动小问和历史，重复操作幂等',()=>{
  const old=withChildren(courseQuestion({...blankQuestion(),section:'1.3',number:'24',kind:'true_false',notes:'教师备注',prompt:'教师题干',answer:'教师答案',subparts:['a','b','c','d','z']}),childrenOf({...blankQuestion(),subparts:['a','b','c','d','z']}).map(c=>({...c,answer:'手动内容'})));
  const prior={...courseConfig([old]),confirmed:true};const snapshot=JSON.stringify(prior);
  const parsed=courseConfig(parseCourseMaterials(['习题1.3\n24. 判断对错\na. 甲\nb. 乙\nc. 丙\nd. 丁\ne ． 戊\n对'],'1.3'));
  const merged=reconcileQuestions(prior,parsed);
  assert.equal(JSON.stringify(prior),snapshot);assert.equal(merged.questions.length,1);
  assert.deepEqual(childrenOf(merged.questions[0]).map(c=>c.label),['a','b','c','d','z','e']);
  assert.equal(merged.questions[0].prompt,'教师题干');assert.equal(merged.questions[0].answer,'教师答案');
  assert.equal(childrenOf(merged.questions[0])[0].answer,'手动内容');
  assert.equal(childrenOf(merged.questions[0]).at(-1)?.confirmed,false);
  assert.deepEqual(reconcileQuestions(merged,parsed),merged);
});
