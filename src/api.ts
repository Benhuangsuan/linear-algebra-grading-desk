export async function api<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const form=body instanceof FormData;
  let response:Response;
  try {response=await fetch(`/api${path}`,{method,headers:body&&!form?{'Content-Type':'application/json'}:undefined,body:body?(form?body:JSON.stringify(body)):undefined});}
  catch {throw new Error('无法连接本地服务。请检查 PowerShell 中的服务是否正在运行，然后重试。');}
  let data:unknown;
  try {data=await response.json();}catch {throw new Error('服务返回了无效响应，请刷新后重试。');}
  if(!response.ok)throw new Error(typeof data==='object'&&data!==null&&'error'in data?String(data.error):'请求失败');
  return data as T;
}
export const contentUrl=(id:string)=>`/api/files/${encodeURIComponent(id)}/content`;
