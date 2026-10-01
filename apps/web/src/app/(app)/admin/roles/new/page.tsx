import Link from "next/link";
import { PERMISSIONS, PERMISSION_GROUPS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card } from "@/components/ui";
import { RoleEditor } from "../forms";

export default async function NewRolePage() {
  await requireAuth(PERMISSIONS.ROLE_MANAGE);
  return (
    <>
      <PageHead
        title="New custom role"
        subtitle="A custom role is a name and any set of permissions. Scope is chosen when you assign it."
        actions={<Link className="btn" href="/admin/roles">Back to roles</Link>}
      />
      <Card>
        <RoleEditor role={{ name: "", description: null, permissions: [] }} groups={PERMISSION_GROUPS} />
      </Card>
    </>
  );
}
