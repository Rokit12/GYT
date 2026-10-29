import EarnClient from "@/components/EarnClient";
import { getSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function Earn() {
  const user = await getSession();
  return (
    <main className="wrap page">
      <EarnClient investorId={user?.investorId ?? null} />
    </main>
  );
}
