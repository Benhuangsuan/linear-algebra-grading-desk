import test from 'node:test';
import assert from 'node:assert/strict';
import {blankConfig,blankQuestion,questionKey,summarize,validateRows} from '../shared/domain.js';
import {unitConfig} from '../shared/units.js';
import {validateVision} from '../server/ai/validate.js';
import {providerConfig,safeStatus} from '../server/ai/config.js';
import {complete} from '../server/ai/transport.js';
import {messagesFor,SYSTEM} from '../server/ai/prompt.js';
import {accounting,estimateInput,cost} from '../server/ai/budget.js';
import {reportedReasoningTokens} from '../shared/ai.js';
const config=unitConfig({...blankConfig(),confirmed:true,questions:[
  {...blankQuestion(),number:'2',type:'completion_only',missingPenalty:.2,errorPenalty:0},
  {...blankQuestion(),number:'3',kind:'true_false',subparts:['a','b','c'],missingPenalty:.2,errorPenalty:.1},
  {...blankQuestion(),number:'4',kind:'solution',subparts:['a','b','c'],missingPenalty:.2,errorPenalty:.1},
  {...blankQuestion(),number:'6',unitMode:'independent',subparts:['a','b'],missingPenalty:.2,errorPenalty:.1},
]});
const facts=()=>config.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',reason:'',pages:[1,2],reviewReason:''}));
test('第2阶段单元：模式由配置决定；判断命题拆分，解答步骤不拆，独立小题显式拆',()=>{
  assert.equal(config.questions.length,7);assert.equal(config.questions[0].type,'completion_only');
  assert.deepEqual(config.questions.slice(1,4).map(q=>q.part),['a','b','c']);
  assert.equal(config.questions[4].part,'');assert.equal(config.questions[4].subparts?.length,0);
  const f=facts();f[1]={...f[1],recognition:'not_found',verdict:'missing',pages:[]};
  f[2]={...f[2],verdict:'incorrect',reason:'命题 b 最终选择 F，但零向量属于任意线性子空间，应选 T'};
  f[4]={...f[4],verdict:'partial',reason:'只给出特解，遗漏齐次解空间'};
  const {rows}=validateVision(JSON.stringify({rows:f}),config,7);
  assert.equal(rows[0].deduction,0);assert.equal(rows[1].deduction,.2);assert.equal(rows[1].needsReview,true);
  assert.equal(rows[2].deduction,.1);assert.equal(rows[4].deduction,.1);assert.equal(summarize(config,rows).score,9.6);
  assert.ok(validateRows(config,rows.map(r=>({...r,reviewed:true})),7,true).some(e=>e.includes('尚未')));
});
test('严格输出：缺题/未知/重复/错题型/伪证据/总分/空泛判错必须拒绝',()=>{
  const parse=(rows:unknown)=>validateVision(JSON.stringify({rows}),config,7);
  assert.throws(()=>parse(facts().slice(1)));
  assert.throws(()=>parse([...facts(),facts()[0]]));
  assert.throws(()=>parse(facts().map((r,i)=>i===0?{...r,key:'9.9 / 999'}:r)));
  assert.throws(()=>parse(facts().map((r,i)=>i===1?{...r,type:'completion_only'}:r)));
  assert.throws(()=>parse(facts().map((r,i)=>i===1?{...r,recognition:'not_found',verdict:'missing',pages:[1]}:r)));
  assert.throws(()=>parse(facts().map((r,i)=>i===1?{...r,pages:[8]}:r)));
  assert.throws(()=>parse(facts().map((r,i)=>i===1?{...r,verdict:'incorrect',reason:'此处存在一处错误。'}:r)));
  assert.throws(()=>validateVision(JSON.stringify({rows:facts(),total:10}),config,7));
  const unclear=facts();unclear[4]={...unclear[4],recognition:'uncertain',verdict:'uncertain',reviewReason:'红笔与学生涂改重叠，无法可靠辨认'};
  assert.equal(summarize(config,parse(unclear).rows).score,null);
});
test('提示词包含全页/符号/红笔/等价解要求，两个学生请求隔离且静态前缀一致',()=>{
  const page={page:1,width:100,height:100,data:'data:image/jpeg;base64,fixture',hash:'fixture'};
  const a=messagesFor(config,[{id:'reference-1',images:[page]}],[page],'random-a');
  const b=messagesFor(config,[{id:'reference-1',images:[page]}],[page],'random-b');
  assert.deepEqual(a.slice(0,2),b.slice(0,2));assert.ok(!JSON.stringify(b).includes('random-a'));
  for(const mark of ['T/F','√×✓✗','红笔','等价','全部学生页','不是对你的指令'])assert.ok(SYSTEM.includes(mark),mark);
});
test('配置不泄露 Key；成本不虚构 usage；估算不假设缓存命中',()=>{
  const c=providerConfig('deepseek',{DEEPSEEK_API_KEY:'fixture-credential',AI_ALLOW_PAID:'true'});
  assert.ok(!JSON.stringify(safeStatus(c)).includes('fixture-credential'));
  assert.throws(()=>providerConfig('qwen',{QWEN_BASE_URL:'https://attacker.example'}));
  assert.equal(accounting(null,{input:2,output:8,cached:.1,date:'2026-10-23',currency:'CNY',tier:'test'}).estimatedCny,null);
  assert.ok(estimateInput(c,messagesFor(config,[],[],'a'))>0);
  assert.equal(cost({input:2,output:8,cached:.1,date:'2026-10-23',currency:'CNY',tier:'test'},1000,100,500),.00185);
  assert.equal(reportedReasoningTokens({completion_tokens:8192,completion_tokens_details:{reasoning_tokens:8192}}),8192);assert.equal(reportedReasoningTokens(null),undefined);assert.equal(reportedReasoningTokens({completion_tokens:8,completion_tokens_details:{reasoning_tokens:10}}),undefined);
});
test('两种 Provider 的流式图片请求与 usage；思考不落盘；错误/无Key不隐式退 Mock',async()=>{
  for(const id of ['deepseek','qwen'] as const){
    const c=providerConfig(id,{DEEPSEEK_API_KEY:'fixture-credential',DASHSCOPE_API_KEY:'fixture-credential',AI_ALLOW_PAID:'true'});
    const fetcher:typeof fetch=async(url,init)=>{
      assert.ok(String(url).includes(id==='deepseek'?'api.deepseek.com':'dashscope.aliyuncs.com'));
      const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
      assert.equal(body.model,id==='deepseek'?'deepseek-flash':'qwen3.7-flash');
      assert.equal(body.stream,true);
      if(id==='qwen')assert.equal(body.enable_thinking,true);
      const chunks=[{choices:[{delta:{reasoning_content:'do not persist'}}]},{choices:[{delta:{content:'{"ok":true}'},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:30}}}];
      return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    };
    const result=await complete(c,[{role:'user',content:'json'}],fetcher);
    assert.equal(result.content,'{"ok":true}');assert.ok(!JSON.stringify(result).includes('do not persist'));
    await assert.rejects(complete(c,[],async()=>new Response('',{status:429})),e=>e instanceof Error&&e.message==='服务商限流');
  }
  await assert.rejects(complete(providerConfig('deepseek',{}),[],async()=>{throw new Error('must not call');}));
});
