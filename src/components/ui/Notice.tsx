import type { ReactNode } from "react";
import { Icon } from "./Icon";
export function Notice({ title, children, tone = "info" }: { title: string; children?: ReactNode; tone?: "info" | "warn" | "danger" | "ok" | "neutral" }) {
  const icon = {info:"info",warn:"alertTriangle",danger:"alertCircle",ok:"checkCircle",neutral:"circle"}[tone];
  return <div className={`callout is-${tone}`} role={tone === "danger" ? "alert" : "status"}><Icon name={icon} /><div className="callout-body"><p className="callout-title">{title}</p>{children}</div></div>;
}
