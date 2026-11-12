"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Dialog({ title, children, onClose, sheet = false }: { title: string; children: ReactNode; onClose: () => void; sheet?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={ref} className={`dialog${sheet ? " sheet" : ""}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); closeRef.current(); }}>
    <div className="dialog-head"><h2 id={titleId} className="dialog-title">{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
    <div className="dialog-body">{children}</div>
  </dialog>;
}
