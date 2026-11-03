import AdminNav from "@/components/admin/AdminNav";
import AdminGate from "@/components/admin/AdminGate";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap admin-shell">
      <AdminNav />
      <main className="admin-main"><AdminGate>{children}</AdminGate></main>
    </div>
  );
}
