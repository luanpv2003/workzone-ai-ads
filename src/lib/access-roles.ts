// Role names + labels (from the i18n catalogue), usable both in the UI (client components) and on the server. Permission-check logic lives in lib/access.ts.

import type { T } from "@/i18n/translate";

export type ClientRole = "admin" | "advertiser" | "analyst";
export type WorkspaceRole = "owner" | "admin" | "member";
/** view: read only; edit: run jobs, approve, edit campaigns / content; manage: connections, tokens, permissions, deleting clients. */
export type AccessLevel = "view" | "edit" | "manage";

export const CLIENT_ROLES: ClientRole[] = ["admin", "advertiser", "analyst"];
export const WORKSPACE_ROLES: WorkspaceRole[] = ["owner", "admin", "member"];
export const clientRoleLabels = (t: T): Record<ClientRole, string> => ({ admin: t("system.roles.client.admin"), advertiser: t("system.roles.client.advertiser"), analyst: t("system.roles.client.analyst") });
export const clientRoleHints = (t: T): Record<ClientRole, string> => ({ admin: t("system.roles.hint.admin"), advertiser: t("system.roles.hint.advertiser"), analyst: t("system.roles.hint.analyst") });
export const workspaceRoleLabels = (t: T): Record<WorkspaceRole, string> => ({ owner: t("system.roles.ws.owner"), admin: t("system.roles.ws.admin"), member: t("system.roles.ws.member") });
