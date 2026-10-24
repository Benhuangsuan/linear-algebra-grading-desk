import test from 'node:test';
import assert from 'node:assert/strict';
import { blankQuestion, questionKey, type Config, type Judgment, type Submission } from '../shared/domain.js';
import { courseConfig } from '../shared/course.js';
import { gradeCell, gradesCsv } from '../server/grades-export.js';

function result(config:Config,rows:Judgment[]):Submission {
  return {id:'student',assignmentId:'assignment',fileId:'file',studentName:'测试同学',studentId:'2600010000',status:'confirmed',
    grade:{provider:'manual',model:'manual',at:'2026-10-21',version:1,config,rows,raw:null},
    review:structuredClone(rows),manualReport:'不应导出的报告',reportBase:'',error:'',revision:1,updatedAt:'2026-10-21'};
}
function correctRows(config:Config):Judgment[] {
  return config.questions.map(q=>({key:questionKey(q),type:q.type,recognition:'found',verdict:q.type==='completion_only'?'completed':'correct',deduction:0,reason:'',pages:[],needsReview:false,reviewed:true}));
}
const missing=(row:Judgment,recognition:'missing'|'not_found'='missing'):Judgment=>({...row,recognition,verdict:'missing',deduction:.2,reason:'漏做'});

test('成绩 CSV 仅两列，确认成绩附漏题数，无漏题不附备注',()=>{
  const config=courseConfig(['7','11','12'].map(number=>({...blankQuestion(),number})));
  const rows=correctRows(config);const s=result(config,[missing(rows[0]),missing(rows[1],'not_found'),rows[2]]);
  assert.equal(gradeCell(s),'9.6分，漏2题');
  assert.equal(gradesCsv([s]),'\uFEFF"姓名","成绩"\r\n"测试同学","9.6分，漏2题"');
  const correct=result(config,rows);assert.equal(gradeCell(correct),'10分');
  correct.review![2]={...rows[2],verdict:'incorrect',deduction:.1,errorCount:1,reason:'错误'};
  assert.equal(gradeCell(correct),'9.9分');
});

test('漏题备注使用最终人工判定，同一大题的小问去重，不计非必做题或待核对',()=>{
  const config=courseConfig([
    {...blankQuestion(),number:'12',part:'a'},
    {...blankQuestion(),number:'12',part:'b'},
    {...blankQuestion(),section:'1.2',number:'12'},
    {...blankQuestion(),number:'14'},
  ]);
  config.questions[3].required=false;
  const rows=correctRows(config).map(row=>missing(row));
  rows[3].deduction=0;
  const s=result(config,rows);
  assert.equal(gradeCell(s),'9.6分，漏2题');
  s.review![0]={...s.review![0],recognition:'found',verdict:'correct',deduction:0,reason:''};
  s.review![1]={...s.review![1],recognition:'found',verdict:'correct',deduction:0,reason:''};
  assert.equal(gradeCell(s),'9.8分，漏1题');
  s.status='review';assert.equal(gradeCell(s),'待确认');
  s.status='uploaded';s.grade=null;assert.equal(gradeCell(s),'待确认');
  const unresolved=result(config,correctRows(config));
  unresolved.review![0]={...unresolved.review![0],recognition:'uncertain',verdict:'uncertain',deduction:null};
  assert.equal(gradeCell(unresolved),'待确认');
});

test('CSV 保留 UTF-8 BOM、引号转义和公式保护',()=>{
  const s=result(courseConfig(),[]);s.studentName='测试,"甲"';
  assert.equal(gradesCsv([s]),'\uFEFF"姓名","成绩"\r\n"测试,""甲""","10分"');
  s.studentName='=1+1';assert.equal(gradesCsv([s]),'\uFEFF"姓名","成绩"\r\n"\'=1+1","10分"');
});
