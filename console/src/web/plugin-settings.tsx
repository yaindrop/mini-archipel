import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { remoteText } from "../messages.ts";
import { refreshFleet } from "./useFleet.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Card,
  Descriptions,
  Empty,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { displayName, stale } from "../domain.ts";
import { readEnvelope } from "../plugins/contracts.ts";
import { api, message } from "./api.ts";
import { PageTitle } from "./ui.tsx";
import type { WorkspaceProps } from "./plugins.tsx";
export function PluginSettings({ fleet, now }: WorkspaceProps) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const client = useQueryClient(),
    { message: feedback } = App.useApp();
  const mutation = useMutation({
    mutationFn: ({
      id,
      host,
      enabled,
    }: {
      id: string;
      host?: string;
      enabled: boolean;
    }) =>
      host ? api.agentPlugin(host, id, enabled) : api.setPlugin(id, enabled),
    onSuccess: async () => {
      await refreshFleet(client);
      void feedback.success(t`插件配置已保存`);
    },
  });
  return (
    <>
      <PageTitle
        eyebrow={t`EXTENSIONS`}
        title={t`插件管理`}
        description={t`独立管理控制台能力与每台节点的采集插件，开关会持久保存。`}
      />
      <Alert
        type="info"
        showIcon
        title={t`关闭插件只停止该插件的监控与操作能力，不会停止其观察的外部服务或正在运行的作业。`}
      />
      {mutation.isError ? (
        <Alert
          type="error"
          showIcon
          role="alert"
          title={message(mutation.error, _)}
        />
      ) : null}
      {Object.values(fleet.plugins).length ? (
        Object.values(fleet.plugins).map((plugin) => (
          <Card
            className="plugin-card"
            key={plugin.id}
            title={
              <Space>
                <span>{remoteText(plugin.label, _)}</span>
                <Tag>v{plugin.version}</Tag>
              </Space>
            }
          >
            <Typography.Paragraph type="secondary">
              {remoteText(plugin.description, _)}
            </Typography.Paragraph>
            {plugin.error ? (
              <Alert
                showIcon
                type="error"
                title={remoteText(plugin.error, _)}
              />
            ) : null}
            <div className="plugin-setting-row">
              <span>
                <strong>{t`控制台`}</strong>
                <Typography.Paragraph type="secondary">{t`页面、概览扩展、远端集成和控制操作`}</Typography.Paragraph>
              </span>
              <Space>
                <Switch
                  aria-label={t`控制台 ${remoteText(plugin.label, _)}`}
                  checked={plugin.enabled}
                  loading={
                    mutation.isPending &&
                    mutation.variables.id === plugin.id &&
                    !mutation.variables.host
                  }
                  disabled={mutation.isPending}
                  onChange={(enabled) => {
                    mutation.mutate({
                      id: plugin.id,
                      enabled,
                    });
                  }}
                />
              </Space>
            </div>
            <Descriptions
              column={1}
              size="small"
              items={fleet.hosts.map((host) => {
                const envelope = readEnvelope(host, plugin.id),
                  offline = stale(host, now);
                return {
                  key: host.name,
                  label: displayName(host),
                  children: (
                    <div className="plugin-node-setting">
                      <Space wrap>
                        {offline || envelope?.status !== "ready" ? (
                          <Tag
                            color={
                              offline
                                ? "default"
                                : envelope?.status === "error"
                                  ? "error"
                                  : "default"
                            }
                          >
                            {offline
                              ? t`节点离线`
                              : !envelope
                                ? t`节点未安装此插件`
                                : envelope.status === "error"
                                  ? t`异常`
                                  : envelope.status === "starting"
                                    ? t`启动中`
                                    : t`已禁用`}
                          </Tag>
                        ) : null}
                        {envelope?.error ? (
                          <Typography.Text type="danger">
                            {remoteText(envelope.error, _)}
                          </Typography.Text>
                        ) : null}
                      </Space>
                      <Switch
                        aria-label={t`${displayName(host)} ${remoteText(plugin.label, _)} 插件`}
                        checked={envelope?.enabled ?? false}
                        disabled={mutation.isPending || offline || !envelope}
                        loading={
                          mutation.isPending &&
                          mutation.variables.host === host.name &&
                          mutation.variables.id === plugin.id
                        }
                        onChange={(enabled) => {
                          mutation.mutate({
                            id: plugin.id,
                            host: host.name,
                            enabled,
                          });
                        }}
                      />
                    </div>
                  ),
                };
              })}
            />
          </Card>
        ))
      ) : (
        <Empty description={t`当前未安装插件`} />
      )}
    </>
  );
}
