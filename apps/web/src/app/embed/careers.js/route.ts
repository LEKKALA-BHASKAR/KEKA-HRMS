import { NextResponse } from "next/server";
import { tenantFromHost } from "@/lib/tenant-host";
import { companyUrl } from "@/lib/tenant-host-shared";

export const dynamic = "force-dynamic";

/**
 * The jobs widget loader a company pastes into its own website:
 *   <div id="boss-hr-jobs"></div><script src="https://acme.example.com/embed/careers.js" async></script>
 * It drops an iframe of /embed/careers into #boss-hr-jobs (or right after the
 * script tag) and keeps it as tall as its content.
 */
export async function GET() {
  const tenant = await tenantFromHost();
  if (!tenant) return new NextResponse("/* No company at this address. */", { status: 404, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
  const src = `${companyUrl(tenant.subdomain).replace(/\/+$/, "")}/embed/careers`;
  const js = `(function(){
  var src=${JSON.stringify(src)};
  var host=document.getElementById("boss-hr-jobs");
  if(!host){host=document.createElement("div");var me=document.currentScript;if(me&&me.parentNode){me.parentNode.insertBefore(host,me.nextSibling);}else{document.body.appendChild(host);}}
  var f=document.createElement("iframe");
  f.src=src;f.title="Open roles";f.loading="lazy";f.style.width="100%";f.style.border="0";f.style.minHeight="320px";
  host.appendChild(f);
  var origin=new URL(src).origin;
  window.addEventListener("message",function(e){if(e.origin===origin&&e.data&&typeof e.data.bossHrJobsHeight==="number"){f.style.height=Math.min(e.data.bossHrJobsHeight+4,20000)+"px";}});
})();`;
  return new NextResponse(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" } });
}
