"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Head, call } from "@/components/admin/kit";

const BerthPlanImporter = dynamic(() => import("@/components/BerthPlanImporter"), { ssr: false });

export default function BerthPlanPage() {
  const [marinas, setMarinas] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { call<{ id: string; name: string }[]>("/marinas").then(setMarinas).catch(() => {}); }, []);
  return (
    <>
      <Head eyebrow="Operations" title="Berth plan to 3D">
        <Link className="btn" href="/admin/berths">Back to the berth board</Link>
      </Head>
      <p className="small" style={{ maxWidth: 760 }}>
        Load an image of a marina&apos;s berth plan: a drawing, a scan or a screenshot of the CAD plan. GYT finds the berths on it,
        measures them from the plan&apos;s scale and builds the marina in 3D. Check the codes and sizes, then save: the berths become
        bookable, and Find a berth and the berth board show the marina&apos;s real layout.
      </p>
      <BerthPlanImporter marinas={marinas} />
    </>
  );
}
