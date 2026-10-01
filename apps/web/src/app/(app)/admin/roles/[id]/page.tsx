import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, PERMISSION_GROUPS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Callout } from "@/components/ui";
import { RoleEditor, DuplicateRoleButton, DeleteRoleButton } from "../forms";

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.ROLE_MANAGE);
  const { id } = await params;
  const role = await prisma.role.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { permissions: true, _count: { select: { assignments: true } } },
  });
  if (!role) notFound();

  return (
    <>
      <PageHead
        title={<>{role.name} {role.isSystem ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="brand">Custom</Badge>}</>}
        subtitle={`${role.permissions.length} permissions · assigned to ${role._count.assignments} user(s)`}
        actions={
          <>
            <DuplicateRoleButton id={role.id} />
            {role.isSystem ? null : <DeleteRoleButton id={role.id} name={role.name} />}
            <Link className="btn" href="/admin/roles">Back to roles</Link>
          </>
        }
      />
      {role.isSystem ? (
        <Callout tone="info" title="Built-in roles are fixed">
          Their permissions follow the product definition so upgrades stay predictable. Duplicate this role to make a custom version you can change.
        </Callout>
      ) : null}
      <div style={{ height: 12 }} />
      <Card>
        <RoleEditor
          role={{ id: role.id, name: role.name, description: role.description, permissions: role.permissions.map((p) => p.permission) }}
          groups={PERMISSION_GROUPS}
          readOnly={role.isSystem}
        />
      </Card>
    </>
  );
}
