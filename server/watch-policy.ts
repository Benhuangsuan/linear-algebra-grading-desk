import { isAbsolute, relative, resolve } from 'node:path';

// Only frontend source is watched. Documents, uploads, SQLite and Word locks never enter chokidar.
export function ignoreDevelopmentPath(root:string,path:string):boolean {
  const rel=relative(resolve(root),resolve(path)).replaceAll('\\','/');
  if(!rel)return false;
  if(rel.startsWith('../')||isAbsolute(rel))return true;
  if(/(^|\/)(~\$|[^/]*\.tmp$)/i.test(rel))return true;
  const [first]=rel.split('/');
  if(['src','shared','public'].includes(first))return false;
  return !['index.html','vite.config.ts','tsconfig.json','tsconfig.server.json','package.json','package-lock.json','.env','.env.local'].includes(rel);
}
