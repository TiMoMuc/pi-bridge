export const CALENDAR_ROUTE_PREFIX = "/calendar";

export function calendarSubscriptionPath(workspaceKey: string, token: string): string {
  return `${CALENDAR_ROUTE_PREFIX}/${encodeURIComponent(workspaceKey)}/${encodeURIComponent(token)}.ics`;
}

export function calendarLocalUrl(bindHost: string, port: number, workspaceKey: string, token: string): string {
  const host = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  return `http://${host}:${port}${calendarSubscriptionPath(workspaceKey, token)}`;
}

export function calendarPublicUrl(baseUrl: string, workspaceKey: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${calendarSubscriptionPath(workspaceKey, token)}`;
}
