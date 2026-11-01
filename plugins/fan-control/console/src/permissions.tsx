import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Alert } from "antd";
import type { Host } from "../../../../console/src/contracts.ts";
import { stale } from "../../../../console/src/domain.ts";
import { readEnvelope } from "../../../../console/src/plugins/contracts.ts";
import { api } from "../../../../console/src/web/api.ts";
import { refreshArchipel } from "../../../../console/src/web/useArchipel.ts";
import { PermissionChecks } from "../../../../console/src/web/permission-checks.tsx";
import { PermissionsSchema } from "./contracts.ts";
const ReplySchema = z.object({
  ok: z.boolean(),
  permissions: PermissionsSchema,
});
export function NodePermissions({ host, now }: { host: Host; now: number }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const envelope = readEnvelope(host, "fan-control");
  const parsed = z
    .object({ permissions: PermissionsSchema.optional() })
    .safeParse(envelope?.data);
  const result = parsed.success
    ? parsed.data.permissions?.["privileged-service"]
    : undefined;
  const available = !stale(host, now) && Boolean(envelope?.enabled);
  const { mutate, isPending, error } = useMutation({
    mutationFn: (action: "permission-check" | "permission-request") =>
      api.pluginAction(
        "fan-control",
        action,
        { host: host.name, permission: "privileged-service" },
        ReplySchema,
      ),
    onSuccess: async () => {
      await refreshArchipel(client);
    },
  });
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (available && !result?.checked_at && !attempted.current.has(host.name)) {
      attempted.current.add(host.name);
      mutate("permission-check");
    }
  }, [available, host.name, result?.checked_at, mutate]);
  return (
    <>
      <PermissionChecks
        node={host.name}
        items={[
          {
            key: "privileged-service",
            label: t`风扇特权服务`,
            status: error ? "error" : (result?.status ?? "unchecked"),
            checkedAt: result?.checked_at ?? null,
            detail: error
              ? t`节点能力检测失败，请重试。`
              : (result?.message ?? t`尚未检查节点能力。`),
            busy: isPending,
            canCheck: available && !isPending,
            canRequest: available && !isPending,
            requestLabel: t`安装/修复入口`,
            onCheck: () => {
              mutate("permission-check");
            },
            onRequest: () => {
              mutate("permission-request");
            },
          },
        ]}
      />
      {result?.entrypoint ? (
        <Alert
          type="info"
          title={result.entrypoint}
          description={t`请在目标节点使用此插件入口；完成安装或配置后重新检查。`}
        />
      ) : null}
    </>
  );
}
