import { F } from "@/components/workforce-ui";

/** Vendor inputs, shared by add and edit. */
export function VendorFields({ d = {} }: { d?: { name?: string; code?: string | null; gstin?: string | null; pan?: string | null; contactName?: string | null; email?: string | null; phone?: string | null; address?: string | null } }) {
  return (
    <div className="grid grid-3">
      <F label="Name *"><input className="input" name="name" required defaultValue={d.name} /></F>
      <F label="Code"><input className="input" name="code" defaultValue={d.code ?? undefined} /></F>
      <F label="GSTIN"><input className="input" name="gstin" maxLength={15} defaultValue={d.gstin ?? undefined} /></F>
      <F label="PAN"><input className="input" name="pan" maxLength={10} defaultValue={d.pan ?? undefined} /></F>
      <F label="Contact person"><input className="input" name="contactName" defaultValue={d.contactName ?? undefined} /></F>
      <F label="Email"><input className="input" type="email" name="email" defaultValue={d.email ?? undefined} /></F>
      <F label="Phone"><input className="input" name="phone" defaultValue={d.phone ?? undefined} /></F>
      <F label="Address"><input className="input" name="address" defaultValue={d.address ?? undefined} /></F>
    </div>
  );
}
