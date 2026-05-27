import * as fs from "node:fs/promises";
import { CodeServerManager } from "./code-server.js";
import { DurableIngressQueue } from "./inbox-queue.js";
import { DurableOutboundQueue } from "./outbox-queue.js";
import { UserProvisioner, type WorkspaceRecord } from "./provisioner.js";
import { SandboxManager } from "./sandbox.js";
import { WorkspaceCapabilityManager } from "./workspace-capabilities.js";

export async function deleteWorkspaceDestructively(params: {
  workspaceKey: string;
  provisioner: UserProvisioner;
  sandboxManager: Pick<SandboxManager, "remove">;
  codeServerManager: Pick<CodeServerManager, "destroy">;
  capabilityManager: Pick<WorkspaceCapabilityManager, "applyWorkspaceCapabilities">;
  inbox: Pick<DurableIngressQueue, "deleteWorkspace">;
  outbox: Pick<DurableOutboundQueue, "deleteWorkspace">;
  rm?: typeof fs.rm;
}): Promise<WorkspaceRecord> {
  const {
    workspaceKey,
    provisioner,
    sandboxManager,
    codeServerManager,
    capabilityManager,
    inbox,
    outbox,
    rm = fs.rm,
  } = params;

  const record = provisioner.getWorkspace(workspaceKey);
  if (!record) {
    throw new Error(`Unknown workspace: ${workspaceKey}`);
  }

  const paths = provisioner.getWorkspacePaths(workspaceKey);
  if (!paths) {
    throw new Error(`Workspace ${workspaceKey} has no resolved workspace path`);
  }

  await sandboxManager.remove(workspaceKey);
  await codeServerManager.destroy(workspaceKey);
  await capabilityManager.applyWorkspaceCapabilities(workspaceKey);
  await inbox.deleteWorkspace(workspaceKey);
  await outbox.deleteWorkspace(workspaceKey);
  await rm(paths.root, { recursive: true, force: true });
  await provisioner.deleteWorkspace(workspaceKey);

  return record;
}
