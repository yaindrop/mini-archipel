import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import { Badge, Card, Flex, Statistic, Typography } from "antd";
import { Layers, Server } from "lucide-react";
import type { Host } from "../contracts.ts";
import {
  displayName,
  formatBytes,
  isVirtual,
  nodeIdentityLabel,
  stale,
  sampleFresh,
} from "../domain.ts";
export function Brand() {
  const { t } = useLinguiMacro();
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        <strong>{t`群岛`}</strong>
        <small>{t`节点工作台`}</small>
      </span>
    </span>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  useLingui();
  return (
    <div className={`page-heading ${className}`}>
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <Typography.Title level={1}>{title}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {description}
        </Typography.Paragraph>
      </div>
      {action}
    </div>
  );
}
export function Section({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useLingui();
  return (
    <Card
      className={`section-card ${className}`}
      title={
        <div className="section-title">
          <h2>{title}</h2>
          {subtitle ? (
            <Typography.Text type="secondary">{subtitle}</Typography.Text>
          ) : null}
        </div>
      }
      extra={action}
    >
      {children}
    </Card>
  );
}
export function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon: ReactNode;
}) {
  useLingui();
  return (
    <Card className="metric-tile">
      <Flex justify="space-between" align="center">
        <Typography.Text type="secondary">{label}</Typography.Text>
        <span className="metric-icon">{icon}</span>
      </Flex>
      <Statistic value={0} formatter={() => value} />
      <Typography.Text type="secondary" className="metric-detail">
        {detail}
      </Typography.Text>
    </Card>
  );
}
export function HostIdentity({
  host,
  index = 0,
}: {
  host: Host;
  index?: number;
}) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  return (
    <span className="host-identity">
      <span className={`node-icon node-color-${String(index % 4)}`}>
        {isVirtual(host) ? <Layers size={18} /> : <Server size={18} />}
      </span>
      <span>
        <strong>{displayName(host)}</strong>
        <small>
          {host.snapshot?.host
            ? t`${nodeIdentityLabel(host, _)} · ${String(host.snapshot.host.cores)} 核 · ${formatBytes(host.snapshot.host.memory_bytes)}`
            : nodeIdentityLabel(host, _)}
        </small>
      </span>
    </span>
  );
}
export function NodeStatus({ host, now }: { host: Host; now: number }) {
  const { t } = useLinguiMacro();
  const old = stale(host, now);
  const expired = !sampleFresh(host.snapshot?.sys, now);
  return (
    <Badge
      status={old ? "error" : expired ? "warning" : "success"}
      text={
        old
          ? host.online
            ? t`数据已过期`
            : t`节点离线`
          : expired
            ? t`节点在线，指标已过期`
            : t`节点在线`
      }
    />
  );
}
