import test from 'node:test';
import assert from 'node:assert/strict';
import {blankConfig,blankQuestion,configSchema,validateRows,summarize,questionKey,type Judgment,type Config} from '../shared/domain.js';
import {inferIdentity,inspectFile,suggestQuestions} from '../server/files.js';
import {referenceTexts,syntheticDocx} from './fixtures.js';

export function testConfig():Config{return {...blankConfig(),confirmed:true,principles:'等价解接受；漏做只扣一次。',questions:[
  {...blankQuestion(),section:'1.1',number:'8',type:'completion_only',missingPenalty:1,errorPenalty:0},
  {...blankQuestion(),section:'1.2',number:'27',part:'a',type:'graded',missingPenalty:2,errorPenalty:.5,prompt:'判断线性系统是否相容',answer:'依据主元判断'},
  {...blankQuestion(),section:'1.3',number:'19',type:'completion_only',required:false,missingPenalty:0,errorPenalty:0},
]};}
function rows(c:Config):Judgment[]{return c.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',deduction:0,reason:'已查看原稿',pages:[1],needsReview:false,reviewed:true}));}
test('评分配置：题型独立于奇偶，验证重复、父子题、总分及正确性扣分',()=>{
  const c=testConfig();assert.equal(configSchema.safeParse(c).success,true);
  assert.equal(configSchema.safeParse({...c,questions:[...c.questions,c.questions[0]]}).success,false);
  assert.equal(configSchema.safeParse({...c,questions:[{...c.questions[0],errorPenalty:1}]}).success,false);
  assert.equal(configSchema.safeParse({...c,questions:[{...c.questions[0],missingPenalty:11}]}).success,false);
  assert.equal(configSchema.safeParse({...c,questions:[c.questions[1],{...c.questions[1],part:''}]}).success,false);
  assert.equal(configSchema.safeParse({...c,mode:'points',questions:c.questions.map(q=>({...q,maxPoints:1}))}).success,false);
});
test('确定性汇总：完成性题不得扣正确性分，漏做不叠加，不确定不算漏做',()=>{
  const c=testConfig();const list=rows(c);assert.deepEqual(validateRows(c,list,3,true),[]);
  assert.equal(summarize(c,list).score,10);
  assert.ok(validateRows(c,[list[0],{...list[1],verdict:'completed'},list[2]],3).some(e=>e.includes('数学判定')));
  assert.ok(validateRows(c,[{...list[0],deduction:1},...list.slice(1)],3).length);
  const missing={...list[0],recognition:'missing' as const,verdict:'missing' as const,deduction:1,pages:[]};
  assert.deepEqual(validateRows(c,[missing,...list.slice(1)],3,true),[]);
  assert.equal(summarize(c,[missing,...list.slice(1)]).score,9);
  assert.ok(validateRows(c,[{...missing,deduction:2},...list.slice(1)],3).length);
  assert.equal(summarize(c,[{...list[0],recognition:'uncertain',verdict:'uncertain',deduction:null},...list.slice(1)]).score,null);
  assert.ok(validateRows(c,[{...list[0],pages:[4]},...list.slice(1)],3).length);
  assert.ok(validateRows(c,list.slice(1),3).some(e=>e.includes('缺少')));
});
test('学生信息：短数字不当作学号，多个长数字交人工确定',()=>{
  assert.equal(inferIdentity('同学2-第3次.pdf').studentId,'');
  assert.equal(inferIdentity('测试学生-2600010000-2班.pdf').studentId,'2600010000');
  assert.equal(inferIdentity('2600010000-2600010001.pdf').studentId,'');
});
test('三份合成 DOCX 含原生公式，预览明确提示信息损失',async()=>{
  let count=0;
  for(const text of referenceTexts){const inspected=await inspectFile(syntheticDocx(text),'synthetic.docx',false);assert.match(inspected.warning,/数学公式/);count+=suggestQuestions(inspected.text).length;}
  assert.equal(count,19);
});
test('PDF 上传验证拒绝伪装和文件扩展名',async()=>{
  await assert.rejects(inspectFile(Buffer.from('fake pdf'),'test.pdf',true),/PDF/);
  await assert.rejects(inspectFile(Buffer.from('fake exe'),'test.exe',true),/仅接受 PDF/);
});
