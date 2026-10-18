import { msg } from "@lingui/core/macro";
import { type Translate } from "../messages.ts";
export function scanFailure(
  error: string | null,
  translate: Translate,
): string {
  if (error?.includes("limit"))
    return translate(msg`目录条目超过限制，请降低下钻深度后重试。`);
  if (error?.includes("save"))
    return translate(msg`扫描状态无法保存，请检查节点可用空间和目录权限。`);
  if (
    error?.includes("not readable") ||
    error?.includes("Permission denied") ||
    error?.includes("Operation not permitted")
  )
    return translate(msg`目录不可读取，请检查节点访问权限。`);
  if (error?.includes("cached tree"))
    return translate(msg`目录已不在缓存中，请重新扫描上级目录。`);
  return translate(msg`未获得有效目录统计，请查看节点诊断日志。`);
}
