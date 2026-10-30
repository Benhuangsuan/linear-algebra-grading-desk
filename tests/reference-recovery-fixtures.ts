import {PDFDocument} from 'pdf-lib';import {syntheticPdf} from './fixtures.js';
/** Invented questions, different sections/numbers from private teaching materials. */
export async function recoveryMaterials(){
 const content=[
  '补充章第7节 参考答案\n注：所有题目均需批改\n讲义题答案：\n2. Synthetic lecture alpha condition\nSynthetic solution alpha\n4. Synthetic lecture beta condition\nSynthetic solution beta\n6. Synthetic lecture gamma condition\nSynthetic solution gamma\n附加题：\n1. Synthetic extra delta condition\nSynthetic solution delta\n2. Synthetic extra epsilon condition\nSynthetic solution epsilon',
  '补充章第8节 参考答案\n注：所有题目均需批改\n讲义题答案：\n8. Synthetic coordinate alpha\nSynthetic answer alpha\n10. Synthetic coordinate beta\nSynthetic answer beta',
  '补充章第9节 参考答案\n注：所有题目均需批改\n讲义题答案：\n12. Synthetic product alpha\nSynthetic answer alpha\n14. Synthetic product beta\nSynthetic answer beta\n附加题：\n1. Synthetic product extra\nSynthetic answer extra',
  '补充章第10节 参考答案\n注：所有题目均需批改\n讲义题答案：\n16. Synthetic vector alpha\nSynthetic answer alpha\n18. Synthetic equivalence proof\na. Synthetic necessary direction\nSynthetic necessary answer\nb. Synthetic sufficient direction\nSynthetic sufficient answer\n附加题：\n1. Synthetic vector extra\nSynthetic answer extra',
 ];
 return Promise.all(content.map(async(text,i)=>{const pdf=await PDFDocument.load(await syntheticPdf(text));if(i===0){pdf.addPage([400,500]);pdf.addPage([400,500]);}return {name:`第${i+7}节 Synthetic.pdf`,buffer:Buffer.from(await pdf.save())};}));
}
