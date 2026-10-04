import Link from "next/link";
import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { directoryWhere, DIRECTORY_SELECT, nameOf } from "@/lib/directory";
import { directoryVisibilityWhere } from "@/lib/core-hr";
import { SubTabs } from "@/components/subtabs";
import { EmptyState } from "@/components/keka";
import { IconUsers } from "@/components/icons";
import { DIRECTORY_TABS } from "../tabs";
import { OrgTree, type TreePerson } from "./org-tree";
import s from "./tree.module.css";

export const metadata = { title: "Organization Tree — BooS-HR" };

/** The few directory fields a node shows — a strict subset of DIRECTORY_SELECT. */
const { id, displayName, firstName, lastName, jobTitleName, photoUrl, reportingManagerId, department } = DIRECTORY_SELECT;
const NODE_SELECT = { id, displayName, firstName, lastName, jobTitleName, photoUrl, reportingManagerId, department };

export default async function OrgTreePage({ searchParams }: { searchParams: Promise<{ root?: string | string[] }> }) {
  const viewer = await requireViewer();
  const { root: rawRoot } = await searchParams;
  const rootParam = typeof rawRoot === "string" ? rawRoot : "";

  // One light query for the whole directory: a few hundred rows of short
  // strings. The client renders only the levels someone has opened.
  const rows = await prisma.employee.findMany({
    // The company's visibility settings apply to the tree as to the directory.
    where: { AND: [directoryWhere(viewer.tenantId), await directoryVisibilityWhere(viewer)] },
    select: NODE_SELECT,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
  });

  const people: TreePerson[] = rows.map((r) => ({
    id: r.id,
    name: nameOf(r),
    title: r.jobTitleName,
    dept: r.department?.name ?? null,
    photoUrl: r.photoUrl,
    managerId: r.reportingManagerId,
  }));

  const byId = new Map(people.map((p) => [p.id, p]));
  const root = rootParam && byId.has(rootParam) ? byId.get(rootParam)! : null;
  const rootManager = root?.managerId ? byId.get(root.managerId) ?? null : null;

  return (
    <>
      <SubTabs items={DIRECTORY_TABS} />
      <div className={s.head}>
        <div>
          <h1 className={s.title}>Organization Tree</h1>
          <p className={s.sub}>
            {root ? (
              <>
                Showing the team under <strong>{root.name}</strong>.{" "}
                {rootManager ? <><Link href={`/directory/tree?root=${rootManager.id}`}>Up to {rootManager.name}</Link> · </> : null}
                <Link href="/directory/tree">Whole organisation</Link>
              </>
            ) : rootParam ? (
              <>That person is not in the directory. <Link href="/directory/tree">Show the whole organisation</Link></>
            ) : (
              <>Reporting lines across {people.length} {people.length === 1 ? "person" : "people"}. Open a card&apos;s count to see their team.</>
            )}
          </p>
        </div>
      </div>

      {people.length === 0 ? (
        <div className={s.emptyWrap}>
          <EmptyState icon={<IconUsers />} title="No one in the directory yet">
            The tree fills in as people join and are given a reporting manager.
          </EmptyState>
        </div>
      ) : (
        <OrgTree key={root?.id ?? "top"} people={people} rootId={root?.id ?? null} viewerId={viewer.employee?.id ?? null} />
      )}
    </>
  );
}
