import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, AlertCircle, CheckCircle2, Plus, MoreHorizontal } from 'lucide-react';
import type { Submission } from '../shared/domain';
export const statusNames:Record<Submission['status'],string>={uploaded:'待处理',queued:'排队中',processing:'处理中',review:'待人工复核',confirmed:'已确认',failed:'失败'};
export function Status({status}:{status:Submission['status']}){return <span className={`badge status-${status}`}><i/>{statusNames[status]}</span>;}
export function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
  const ref=useRef<HTMLElement>(null);const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')?.focus();
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.stopPropagation();close.current();}
      if(e.key==='Tab'){const focusable=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled)')??[]).filter(el=>el.getClientRects().length);const first=focusable[0];const last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    window.addEventListener('keydown',onKey);return()=>{window.removeEventListener('keydown',onKey);document.body.style.overflow=overflow;if(previous instanceof HTMLElement)previous.focus();};
  },[]);
  return <div className="modal-backdrop" onClick={onClose}><section ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="modal-title"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></div>{children}</section></div>;
}
export function Notice({children,tone='warning'}:{children:ReactNode;tone?:'warning'|'success'|'danger'|'info'}){return <div className={`notice ${tone}`}>{tone==='success'?<CheckCircle2 size={17}/>:<AlertCircle size={17}/>}<div>{children}</div></div>;}
export function Empty({title,description,action}:{title:string;description:string;action?:()=>void}){return <div className="empty"><div className="empty-mark">∑</div><h2>{title}</h2><p>{description}</p>{action&&<button className="primary" onClick={action}><Plus size={17}/>开始创建</button>}</div>;}
export function useBeforeUnload(dirty:boolean){useEffect(()=>{if(!dirty)return;const handler=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[dirty]);}
export function formatDate(date:string){return new Date(date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
export function ActionMenu({children,label='更多操作'}:{children:ReactNode;label?:string}){
  const [open,setOpen]=useState(false);const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};},[open]);
  return <div className="action-menu" ref={ref}><button className="icon-button" aria-label={label} aria-expanded={open} onClick={()=>setOpen(!open)}><MoreHorizontal size={19}/></button>{open&&<div className="menu-items" onClick={()=>setOpen(false)}>{children}</div>}</div>;
}
