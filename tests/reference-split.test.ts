import test from 'node:test';
import assert from 'node:assert/strict';
import {splitReference,syntheticPdf} from './fixtures.js';
import {inspectFile} from '../server/files.js';
import {parseCourseMaterials,courseConfig} from '../shared/course.js';
import {childrenOf,childContentKey,reconcileQuestions} from '../shared/questions.js';
import {unitConfig} from '../shared/units.js';
import {messagesFor} from '../server/ai/prompt.js';

const text=splitReference;
test('3.1/40 合成题干与参考解按结构边界分离，两命题派生单元保留公共条件',()=>{
  const questions=parseCourseMaterials([text],'3.1');assert.equal(questions.length,1);const q=questions[0];const children=childrenOf(q);
  assert.equal(q.prompt,'设矩阵 M=diag(2,3)，判断下列命题');assert.equal(children.length,2);
  assert.ok(children[0].prompt?.includes('等于 6'));assert.ok(children[0].prompt?.includes('det M'));assert.ok(!children[0].prompt?.includes('对，'));
  assert.match(children[0].answer!,/^对，/);assert.ok(!children[0].answer!.includes('等于 6'));
  assert.match(children[1].prompt!,/等于 5$/);assert.match(children[1].answer!,/^错，/);assert.ok(children[1].answer!.includes('元素之积'));
  assert.ok(children.every(c=>c.confirmed===false));
  const config={...courseConfig([{...q,children:children.map(c=>({...c,confirmed:true}))}]),confirmed:true};const units=unitConfig(config);assert.equal(units.questions.length,2);assert.ok(units.questions.every(q=>q.prompt.includes('diag(2,3)')));
  const messages=messagesFor(units,[],[],'synthetic');const rules=JSON.stringify(messages);assert.ok(rules.includes('元素之和'));assert.ok(rules.includes('元素之积'));
});
test('不同标点/换行、跨页空白可拆；数学对称字样与模糊片段不被机械切割',()=>{
  const variant=text.replace('a.','a\n．').replace('b.','b  )').replace('对，','\n\f\n对，');
  const parsedVariant=parseCourseMaterials([variant],'3.1')[0];assert.match(childrenOf(parsedVariant)[0].answer!,/^对，/);assert.equal(parsedVariant.prompt,'设矩阵 M=diag(2,3)，判断下列命题');
  const ambiguous=parseCourseMaterials(['习题3.1\n40.判断正误\na. 对称矩阵是否满足条件\n对称条件需要讨论\nb. 解释对与错的关系\n未提供标准判断'],'3.1')[0];
  assert.ok(childrenOf(ambiguous).every(c=>!c.prompt&&!c.answer&&c.parseWarning&&c.sourceText&&c.confirmed===false));
  const solution=parseCourseMaterials(['习题3.1\n36.计算\na.设对称矩阵A\n证明过程\nb.求结果\n对比前式'],'3.1')[0];assert.equal(solution.kind,'solution');assert.ok(childrenOf(solution)[0].answer!.includes('证明过程'));
});
test('新候选不会覆盖人工内容，显式采用后仍待确认且保留ID和扣分',()=>{
  const parsed=courseConfig(parseCourseMaterials([text],'3.1'));const q=parsed.questions[0];const old={...q,children:childrenOf(q).map(c=>({...c,prompt:'人工题干',answer:'人工解',errorPenalty:.3,confirmed:true}))};const prior={...parsed,questions:[old],confirmed:true};
  assert.equal(childrenOf(reconcileQuestions(prior,parsed).questions[0])[0].prompt,'人工题干');
  const adopted=childrenOf(reconcileQuestions(prior,parsed,new Set([childContentKey(q,'a')])).questions[0]);
  assert.equal(adopted[0].id,old.children[0].id);assert.equal(adopted[0].errorPenalty,.3);assert.equal(adopted[0].confirmed,false);assert.match(adopted[0].answer!,/^对/);assert.equal(adopted[1].prompt,'人工题干');
});
test('合成 PDF 文本层提取后仍分离两个小问，不读取本机数据库',async()=>{
  const info=await inspectFile(await syntheticPdf(text),'synthetic.pdf',false);const q=parseCourseMaterials([info.text],'3.1').find(q=>q.number==='40')!;
  assert.deepEqual(childrenOf(q).map(c=>c.label),['a','b']);assert.match(childrenOf(q)[0].answer!,/^对/);assert.match(childrenOf(q)[1].answer!,/^错/);assert.match(childrenOf(q)[1].prompt!,/等于 5$/);
});
